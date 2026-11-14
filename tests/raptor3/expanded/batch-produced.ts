// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers are invoked only from registered tests.
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

export const batchProducedCases = ["g1-produced-batch-stable"] as const;

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

/**
 * A cut would be committed producer state without its dependent token. The
 * engine of 1.14.0 reached one on a transport that could not carry the
 * generated value inside the batch, and guarded what followed it; a value
 * the database generates now reaches the statements that need it inside the
 * same batch, or the call is refused. This driver witnesses that no batch
 * ends on a producer without its token.
 */
class ProducerContinuationDriver extends BatchOnlyPGliteDriver {
  readonly reachedCuts: string[] = [];
  readonly completedBatchSql: string[][] = [];
  private readonly accounts: string;
  private readonly tokens: string;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    accounts: string,
    tokens: string
  ) {
    super(options);
    this.accounts = accounts;
    this.tokens = tokens;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const responses = await super.executeBatch<T>(client, queries);
    this.completedBatchSql.push(queries.map((query) => query.sql));
    const owner = await client.query(
      `SELECT id,code FROM ${this.accounts} WHERE id='owner'`
    );
    const token = await client.query(
      `SELECT id,"accountCode" FROM ${this.tokens} WHERE id='new-token'`
    );
    if (owner.rows.length === 1 && token.rows.length === 0)
      this.reachedCuts.push("g1-batch-producer-committed");
    return responses;
  }
}

/** Forced-batch PostgreSQL provider conformance, not a hosted/DST race claim. */
export async function runBatchProducedOutput(
  family: PGliteSchemaFamily<typeof batchProducedSchema>,
  _id: (typeof batchProducedCases)[number],
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
  const driver = new ProducerContinuationDriver(
    { client: database, namespace },
    accounts,
    tokens
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
    // One batch carries the producer, its generated value and the token.
    assert.deepEqual(
      driver.reachedCuts,
      [],
      `A batch ended on a producer without its token; completed batches: ${JSON.stringify(driver.completedBatchSql)}`
    );
    assert.equal(driver.completedBatchSql.length, 1);
    const observation: RunObservation = {
      outcome,
      initial: observedInitial,
      final: await inspect(),
      defaults: [],
      reachedCuts: [],
    };
    assert.deepEqual(observation.final, {
      accounts: [...initial.accounts, { id: "owner", code: 41 }],
      tokens: [{ id: "new-token", accountCode: 41 }, ...initial.tokens],
      sequence: [{ value: 41, called: true }],
    });
    assert.deepEqual(outcome, {
      kind: "success",
      value: { id: "owner", code: 41 },
    });
    return observation;
  } finally {
    await driver.disconnect();
  }
}
