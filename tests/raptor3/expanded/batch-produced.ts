import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import type { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { s } from "@schema";
import {
  createIdentifierQuoter,
  createQualifiedIdentifierRenderer,
} from "@src/sql/identifiers";
import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import type {
  CandidateEngineFactory,
  OperationOutcome,
  RunObservation,
} from "../harness/protocol";
import { observeFailure } from "../harness/sqlite-world";

export const batchProducedCases = [
  "g1-produced-batch-stable",
  "g1-produced-batch-moved-owner",
] as const;

export const batchProducedSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      code: s.int().increment().unique(),
      tokens: s.toMany(() => token),
    })
    .map("g1_batch_accounts");
  const token = s
    .model({
      id: s.string().id(),
      accountCode: s.int(),
      account: s
        .toOne(() => account)
        .fields("accountCode")
        .references("code"),
    })
    .map("g1_batch_tokens");
  return { account, token };
})();

/** The cut is committed producer state without its dependent token, never batch N. */
class ProducerContinuationDriver extends BatchOnlyPGliteDriver {
  readonly reachedCuts: string[] = [];
  readonly completedBatchSql: string[][] = [];
  private producerReached = false;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    private readonly accounts: string,
    private readonly tokens: string,
    private readonly moveOwner: boolean
  ) {
    super(options);
    this.adapter.capabilities.supportsCteWithMutations = false;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const responses = await super.executeBatch<T>(client, queries);
    this.completedBatchSql.push(queries.map((query) => query.sql));
    if (this.producerReached) return responses;
    const owner = await client.query(
      `SELECT id,code FROM ${this.accounts} WHERE id='owner'`
    );
    const token = await client.query(
      `SELECT id,"accountCode" FROM ${this.tokens} WHERE id='new-token'`
    );
    if (owner.rows.length !== 1 || token.rows.length !== 0) return responses;
    assert.deepEqual(owner.rows, [{ id: "owner", code: 41 }]);
    this.producerReached = true;
    this.reachedCuts.push("g1-batch-producer-committed");
    if (!this.moveOwner) return responses;
    await this.transaction(client, async (transaction) => {
      const moved = await this.executeRaw(
        transaction,
        `UPDATE ${this.accounts} SET code=42 WHERE id='owner' AND code=41 RETURNING id,code`,
        []
      );
      assert.deepEqual(moved.rows, [{ id: "owner", code: 42 }]);
      await this.executeRaw(
        transaction,
        `INSERT INTO ${this.accounts} (id,code) VALUES ('replacement',41)`,
        []
      );
    });
    this.reachedCuts.push("g1-batch-owner-moved-and-code-reused");
    return responses;
  }
}

/** Forced-batch PostgreSQL provider conformance, not a hosted/DST race claim. */
export async function runBatchProducedOutput(
  family: PGliteSchemaFamily<typeof batchProducedSchema>,
  id: (typeof batchProducedCases)[number],
  requestedFactory?: CandidateEngineFactory
): Promise<RunObservation> {
  await family.reset();
  const { database, namespace } = family;
  const table = createQualifiedIdentifierRenderer(
    createIdentifierQuoter('"'),
    namespace
  );
  const accounts = table("g1_batch_accounts");
  const tokens = table("g1_batch_tokens");
  const sequences = await database.query<{ sequence: string }>(
    "SELECT pg_get_serial_sequence($1,'code') AS sequence",
    [accounts]
  );
  const sequence = sequences.rows[0]?.sequence;
  assert.ok(sequence);
  await database.query("SELECT setval($1::regclass,41,false)", [sequence]);
  await database.exec(`
    INSERT INTO ${accounts} (id,code) VALUES ('decoy',7);
    INSERT INTO ${tokens} (id,"accountCode") VALUES ('old-token',7);
  `);
  const initial = {
    accounts: [{ id: "decoy", code: 7 }],
    tokens: [{ id: "old-token", accountCode: 7 }],
    sequence: [{ value: 41, called: false }],
  };
  const inspect = async () => ({
    accounts: (await database.query(`SELECT * FROM ${accounts} ORDER BY id`))
      .rows,
    tokens: (await database.query(`SELECT * FROM ${tokens} ORDER BY id`)).rows,
    sequence: (
      await database.query(
        `SELECT last_value::int AS value,is_called AS called FROM ${sequence}`
      )
    ).rows,
  });
  const moveOwner = id === "g1-produced-batch-moved-owner";
  const driver = new ProducerContinuationDriver(
    { client: database, namespace },
    accounts,
    tokens,
    moveOwner
  );
  const args = {
    data: { id: "owner", tokens: { create: { id: "new-token" } } },
    select: { id: true, code: true },
  } as const;
  let candidateExecutions = 0;
  const candidateFactory: CandidateEngineFactory | undefined = requestedFactory
    ? (config) => {
        const engine = requestedFactory(config);
        return {
          execute(...parameters) {
            candidateExecutions += 1;
            return engine.execute(...parameters);
          },
          prepareBatch(...parameters) {
            candidateExecutions += 1;
            return engine.prepareBatch(...parameters);
          },
        };
      }
    : undefined;
  try {
    const observedInitial = await inspect();
    assert.deepEqual(observedInitial, initial);
    let outcome: OperationOutcome;
    try {
      const value = candidateFactory
        ? await candidateFactory({
            schema: batchProducedSchema,
            driver,
          }).execute("account", "create", args)
        : await createClient({
            schema: batchProducedSchema,
            driver,
          }).account.create(args);
      outcome = { kind: "success", value };
    } catch (failure) {
      outcome = { kind: "failure", failure: observeFailure(failure) };
    }
    if (requestedFactory)
      assert.equal(
        candidateExecutions,
        1,
        "Expected exactly one candidate execution"
      );
    const requiredCuts = moveOwner
      ? ["g1-batch-producer-committed", "g1-batch-owner-moved-and-code-reused"]
      : ["g1-batch-producer-committed"];
    assert.deepEqual(
      driver.reachedCuts,
      requiredCuts,
      `Missing eligible generated-output continuation cut; completed batches: ${JSON.stringify(driver.completedBatchSql)}`
    );
    const observation: RunObservation = {
      outcome,
      initial: observedInitial,
      final: await inspect(),
      defaults: [],
      reachedCuts: [...driver.reachedCuts],
    };
    assert.deepEqual(observation.final, {
      accounts: moveOwner
        ? [
            ...initial.accounts,
            { id: "owner", code: 42 },
            { id: "replacement", code: 41 },
          ]
        : [...initial.accounts, { id: "owner", code: 41 }],
      tokens: moveOwner
        ? initial.tokens
        : [{ id: "new-token", accountCode: 41 }, ...initial.tokens],
      sequence: [{ value: 41, called: true }],
    });
    if (!moveOwner) {
      assert.deepEqual(outcome, {
        kind: "success",
        value: { id: "owner", code: 41 },
      });
      return observation;
    }
    assert.equal(outcome.kind, "failure");
    if (outcome.kind === "failure") {
      assert.equal(outcome.failure.name, "TransactionError");
      assert.equal(
        outcome.failure.message,
        "Created record 'account' changed across a generated-output segment boundary."
      );
    }
    return observation;
  } finally {
    await driver.disconnect();
  }
}
