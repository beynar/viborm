import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";

import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { producedIdentitySchema } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * One shared PGlite, one private schema for this file. The corrupting driver is built
 * over the same database and therefore carries the same namespace — without it it
 * would address `public`, where this suite has no tables.
 */
const getFamily = usePGliteSchemaFamily(producedIdentitySchema);

const driverOptions = () => {
  const family = getFamily();
  return { client: family.database, namespace: family.namespace };
};

/**
 * N4-U2 / N4-U4 — the PROVENANCE instrument for a PRODUCED identity.
 *
 * The behavior suite's decoys catch "take the first row" and any scan-shaped resolution.
 * They cannot catch a RE-DERIVATION, and for a produced identity that is the whole claim:
 * every decoy differs from its target in the very column the payload spells
 * (`code: 'S-DECOY'` vs `'S-FRESH'`, `email: 'decoy@x'` vs `'target@x'`), so an
 * implementation that resolved the fresh row's key by SELECTing that column back after
 * the INSERT would land on the same row and every state assertion would still pass.
 *
 * What these units actually claim is narrower: the fresh row's identity comes from
 * **the INSERT that produced it**, read out of that statement's own declared output —
 * `RETURNING <pk>` in transaction mode on a returning driver, the driver's `insertId`
 * otherwise. Only corrupting what that statement RETURNED can tell the two apart, which
 * is the instrument N1 built (`CorruptLocatePGliteDriver`) and N4-U1 aimed at the depth
 * probe (`depth-seam-located-provenance.test.ts`). This is the same instrument aimed at
 * a produced value.
 *
 * The corruption points the returned key at ANOTHER LIVE ROW rather than at nonsense, so
 * a foreign-key constraint cannot substitute for the assertion: both outcomes are
 * insertable, and only the provenance decides which row the child lands on.
 *
 * Transaction substrate only, for the reason N4-U1's witness records: the produced value
 * is a `RETURNING` column there, and the batch substrate reads it from the driver's
 * `insertId` scratch instead — a channel this harness cannot rewrite without becoming a
 * test of the driver rather than of the engine. The batch legs of both shapes are the
 * ordinary ones the behavior suite already runs.
 */
class CorruptInsertIdentityDriver extends PGliteDriver {
  private readonly table: string;
  private readonly column: string;
  private readonly wrongValue: unknown;
  private armed = true;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    config: { table: string; column: string; wrongValue: unknown }
  ) {
    super(options);
    this.table = config.table;
    this.column = config.column;
    this.wrongValue = config.wrongValue;
  }

  private corrupt<T>(sql: string, result: QueryResult<T>): QueryResult<T> {
    const isProducingInsert =
      this.armed &&
      sql.startsWith("INSERT INTO") &&
      sql.includes(this.table) &&
      sql.includes("RETURNING") &&
      result.rows.length > 0;
    if (!isProducingInsert) return result;
    // One shot: the FIRST returning INSERT into this table is the statement whose
    // identity the tree spends. Nothing later is rewritten, so the corruption is a
    // property of that produced VALUE and not of the whole connection.
    this.armed = false;
    return {
      ...result,
      rows: result.rows.map((row) => ({
        ...(row as Record<string, unknown>),
        [this.column]: this.wrongValue,
      })) as T[],
    };
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.execute<T>(client, sql, params, context)
    );
  }

  protected override async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.executeRaw<T>(client, sql, params, context)
    );
  }
}

const schema = producedIdentitySchema as unknown as Record<string, Model<any>>;

function makeEngine(driver: PGliteDriver): QueryEngine {
  const schemas = createSchemaRegistry(producedIdentitySchema);
  return new QueryEngine(
    driver,
    createModelRegistry(producedIdentitySchema, schemas)
  );
}

describe("N4-U2 / N4-U4 produced-identity provenance (corrupt the INSERT's returned key)", () => {
  test("an upsert CREATE arm's grandchild follows the key its OWN INSERT returned", async () => {
    const options = driverOptions();
    const stateClient = createClient({
      schema: producedIdentitySchema,
      driver: new PGliteDriver(options),
    });
    await stateClient.org.create({ data: { id: 2, slug: "target-org" } });
    // A live decoy squad the corrupted key can legally point at — so a wrong-provenance
    // grandchild is a silent WRONG ROW, not a constraint error.
    const decoy = await stateClient.squad.create({
      data: { code: "S-DECOY", title: "decoy", orgId: 2 },
    });

    const driver = new CorruptInsertIdentityDriver(options, {
      table: "n4pi_squads",
      column: "id",
      wrongValue: decoy.id,
    });
    const engine = makeEngine(driver);
    await new OperationExecutor(engine).execute(
      new UpdateOperation(engine, schema.org as Model<any>, {
        where: { id: 2 },
        data: {
          squads: {
            upsert: {
              where: { code: "S-FRESH" },
              create: {
                code: "S-FRESH",
                title: "fresh",
                drills: { create: { text: "follows-returned-key" } },
              },
              update: { title: "not-taken" },
            },
          },
        },
      }),
      createOperationExecutionContext("org", "update", engine.instrumentation)
    );

    const squads = await stateClient.squad.findMany({ orderBy: { id: "asc" } });
    expect(squads.map((row) => row.code)).toEqual(["S-DECOY", "S-FRESH"]);
    const drills = await stateClient.drill.findMany({ orderBy: { id: "asc" } });
    expect(drills).toHaveLength(1);
    // THE CLAIM. The grandchild follows the CORRUPTED returned key — the decoy's id —
    // because that is what the INSERT reported having produced. An implementation that
    // re-derived the identity by re-reading `code: 'S-FRESH'`, or that took the row it
    // just wrote from a second SELECT, would attach the drill to the real fresh squad
    // and this assertion would fail. Nothing else in the estate discriminates the two:
    // both spellings put exactly one drill under a real squad of the right org.
    expect(drills[0]?.squadId).toBe(decoy.id);
    expect(drills[0]?.squadId).not.toBe(squads[1]?.id);
  }, 30_000);

  test("a shared-primary-key child and its terminal read spend ONE produced identity", async () => {
    const options = driverOptions();
    const stateClient = createClient({
      schema: producedIdentitySchema,
      driver: new PGliteDriver(options),
    });
    // The live decoy the corrupted key points at.
    const decoy = await stateClient.account.create({
      data: { email: "decoy@x", handle: "decoy", name: "decoy" },
    });

    const driver = new CorruptInsertIdentityDriver(options, {
      table: "n4pi_accounts",
      column: "id",
      wrongValue: decoy.id,
    });
    const engine = makeEngine(driver);
    const result = await new OperationExecutor(engine).execute(
      new CreateOperation(engine, schema.profile as Model<any>, {
        data: {
          bio: "produced",
          account: {
            create: { email: "target@x", handle: "target", name: "target" },
          },
        },
      }),
      createOperationExecutionContext(
        "profile",
        "create",
        engine.instrumentation
      )
    );

    // THE CLAIM, in two halves that must agree. The profile's shared primary key — which
    // is also its foreign key — is the value the before-parent INSERT RETURNED, so the
    // corruption carries it to the decoy account …
    await expect(
      stateClient.profile.findMany({ orderBy: { accountId: "asc" } })
    ).resolves.toEqual([{ accountId: decoy.id, bio: "produced" }]);
    // … and the terminal read addressed THAT row, through the same `Ref`. If the
    // identity were re-derived from anywhere else (the create data's `email`, a second
    // read of the accounts table, the driver's own last-insert id) the two halves would
    // name different rows and the operation would return nothing at all.
    expect(result).toMatchObject({ accountId: decoy.id, bio: "produced" });
  }, 30_000);

  test("a produced-identity INSERT that reports no key fails closed, writing nothing", async () => {
    const options = driverOptions();
    const stateClient = createClient({
      schema: producedIdentitySchema,
      driver: new PGliteDriver(options),
    });
    await stateClient.org.create({ data: { id: 2, slug: "target-org" } });

    // `undefined` is not a live key and not a droppable column: the produced value is
    // absent, which is the one thing a produced identity cannot recover from. The pin is
    // that it ABORTS rather than writing the grandchild against nothing — the same
    // fail-closed disposition N4-U1's "probe row missing the key" arm asserts for a
    // located identity.
    const driver = new CorruptInsertIdentityDriver(options, {
      table: "n4pi_squads",
      column: "id",
      wrongValue: undefined,
    });
    const engine = makeEngine(driver);
    // The refusal is NAMED, not merely "something threw". A bare `toThrow()` is
    // satisfied by any failure on this path — a decoder crash, a constraint
    // violation, a typo in the payload — while the claim is narrower: the ABSENCE of
    // the produced key is what stopped the operation. The message is the measured one,
    // so the pin fails if an incidental error ever stands in for the guard.
    await expect(
      new OperationExecutor(engine).execute(
        new UpdateOperation(engine, schema.org as Model<any>, {
          where: { id: 2 },
          data: {
            squads: {
              upsert: {
                where: { code: "S-FRESH" },
                create: {
                  code: "S-FRESH",
                  title: "fresh",
                  drills: { create: { text: "orphan" } },
                },
                update: { title: "not-taken" },
              },
            },
          },
        }),
        createOperationExecutionContext("org", "update", engine.instrumentation)
      )
    ).rejects.toThrow("Step 'squad.create' did not produce row field 'id'.");
    await expect(stateClient.drill.findMany({})).resolves.toEqual([]);
    await expect(stateClient.squad.findMany({})).resolves.toEqual([]);
  }, 30_000);
});
