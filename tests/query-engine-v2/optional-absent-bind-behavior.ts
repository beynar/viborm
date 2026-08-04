import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NestedWriteError } from "@errors";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine/write-engine/OperationExecutor";
import { UpsertOperation } from "../../src/query-engine/write-engine/UpsertOperation";

/**
 * M5 — the absent-optional bind, across the whole driver matrix.
 *
 * A root upsert whose update arm carries relations delegates that arm to a full
 * `UpdateOperation` and plans its WHOLE superset one level in (ATOM §3 technique
 * 2): both arms' planning reads run before the locate decides which arm is
 * taken. On an ABSENT target the update arm's locate matches nothing, so its
 * `optional` firstRowField outputs resolve to `undefined` — and the arm's
 * parent-correlated child probe binds that `undefined` as a parameter.
 *
 * Eight of the nine driver legs coerce `undefined` to NULL in their binder and
 * the correlated read comes back empty, which is exactly right. mysql2 REJECTS
 * an undefined bind outright ("Bind parameters must not contain undefined"), so
 * this already-shipped public shape errored on MySQL. The engine now states the
 * bind itself (`materializeLinearSql`): an optional absent output means "no row",
 * and "no row" is SQL NULL, so the correlated read matches nothing on every leg.
 *
 * These are fixed-expectation behaviors, run on every driver class and both
 * substrates. Two decoys keep them falsifiable in both directions: an untaken
 * arm may not reach ANOTHER parent's child row (the NULL must match nothing),
 * and a taken arm's correlation may not be weakened into matching anything.
 */
export const optionalAbsentBindSchema = (() => {
  const account = s
    .model({
      // Explicit ids so a witness can name the row that was (or was not) touched.
      id: s.int().id(),
      email: s.string().unique(),
      label: s.string(),
      notes: s.oneToMany(() => note),
    })
    .map("m5_absent_accounts");
  const note = s
    .model({
      id: s.int().id(),
      body: s.string(),
      accountId: s.int().nullable(),
      account: s
        .manyToOne(() => account)
        .fields("accountId")
        .references("id")
        .optional(),
    })
    .map("m5_absent_notes");
  return { account, note };
})();

hydrateSchemaNames(optionalAbsentBindSchema);

/**
 * The upsert runs through the OPERATION, not the routed client: a batch-only,
 * non-returning driver refuses the single-row upsert refetch family at the client
 * seam, which would make the batch leg vacuous. Every other update/upsert-family
 * behavior suite uses this same seam for the same reason.
 */
function makeUpsertRunner(driver: AnyDriver) {
  const schemas = createSchemaRegistry(optionalAbsentBindSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(optionalAbsentBindSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return (args: Record<string, unknown>): Promise<unknown> =>
    executor.execute(
      new UpsertOperation(engine, optionalAbsentBindSchema.account, args),
      createOperationExecutionContext(
        "account",
        "upsert",
        engine.instrumentation
      )
    );
}

function makeStateClient(driver: AnyDriver) {
  return createClient({ schema: optionalAbsentBindSchema, driver });
}
type StateClient = ReturnType<typeof makeStateClient>;

/**
 * The decoy owns note 1 and is seeded FIRST with the LOWER key, so an untaken
 * arm that dropped its parent correlation — or matched a NULL against anything —
 * lands on it. `target` owns note 2.
 */
async function seed(client: StateClient): Promise<void> {
  await client.account.create({
    data: { id: 1, email: "decoy@x", label: "decoy" },
  });
  await client.account.create({
    data: { id: 2, email: "target@x", label: "target" },
  });
  await client.note.create({
    data: { id: 1, body: "decoy-body", accountId: 1 },
  });
  await client.note.create({
    data: { id: 2, body: "target-body", accountId: 2 },
  });
}

/** The M5 shape: an upsert whose update arm carries a parent-correlated read. */
function upsertArgs(email: string, noteId: number): Record<string, unknown> {
  return {
    where: { email },
    create: { id: 9, email, label: "created" },
    update: {
      label: "updated",
      notes: { update: { where: { id: noteId }, data: { body: "written" } } },
    },
  };
}

export function runOptionalAbsentBindBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} absent-optional planning bind (M5)`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = makeStateClient(stateDriver);
      const upsert = makeUpsertRunner(driver);
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { client, upsert, dispose };
    };

    test(
      "an absent target takes the create arm, and the untaken update arm's correlated probe touches nothing",
      { timeout: 30_000 },
      async () => {
        const { client, upsert, dispose } = await setup();
        try {
          await seed(client);
          // `absent@x` matches no row, so the create arm is taken — but the update
          // arm's superset probe (`WHERE id = 1 AND accountId = <absent parent>`)
          // has already been planned and must run without a binder refusal.
          await expect(upsert(upsertArgs("absent@x", 1))).resolves.toEqual({
            id: 9,
            email: "absent@x",
            label: "created",
          });
          // The decoy's note is the wrong-row witness: the untaken arm's NULL
          // correlation must match NOTHING, never "the row with that id".
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 1, body: "decoy-body", accountId: 1 },
            { id: 2, body: "target-body", accountId: 2 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a present target takes the update arm and its correlated probe still binds the located row",
      { timeout: 30_000 },
      async () => {
        const { client, upsert, dispose } = await setup();
        try {
          await seed(client);
          await expect(upsert(upsertArgs("target@x", 2))).resolves.toEqual({
            id: 2,
            email: "target@x",
            label: "updated",
          });
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 1, body: "decoy-body", accountId: 1 },
            { id: 2, body: "written", accountId: 2 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a present target whose nested target belongs to another parent still refuses",
      { timeout: 30_000 },
      async () => {
        const { client, upsert, dispose } = await setup();
        try {
          await seed(client);
          // Note 1 exists but belongs to the decoy. The correlation is what rejects
          // it: normalizing the ABSENT bind to NULL must not turn a present-parent
          // correlation into a match-anything.
          await expect(upsert(upsertArgs("target@x", 1))).rejects.toThrow(
            NestedWriteError
          );
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 1, body: "decoy-body", accountId: 1 },
            { id: 2, body: "target-body", accountId: 2 },
          ]);
          await expect(
            client.account.findUnique({ where: { id: 2 } })
          ).resolves.toEqual({ id: 2, email: "target@x", label: "target" });
        } finally {
          await dispose();
        }
      }
    );
  });
}
