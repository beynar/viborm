import { createClient } from "@client/client";
import { s } from "@schema";
import { Sql, sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { checkEstate } from "@src/migrations/check";
import { type GenerateV1Result, generateV1 } from "@src/migrations/generate-v1";
import { loadMigrationGraph } from "@src/migrations/graph";
import { isSha256 } from "@src/migrations/identity";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, expectTypeOf, test } from "vitest";
import { pgEstateDriver } from "./_estate";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

function clientWith(schema: Record<string, typeof user>) {
  return createClient({
    schema,
    driver: new PlanningDriver("sqlite"),
  });
}

describe("migration v1 generate", () => {
  test("dry-run on a missing estate publishes nothing", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    const preview = await generateV1(client, storage, {
      dryRun: true,
      name: "init",
    });
    expect(preview.outcome).toBe("preview");
    expect(await storage.readEstate()).toBeNull();
    expect(await storage.listStates()).toEqual([]);
    await client.$disconnect();
  });

  test("identical inputs publish the same state id", async () => {
    const left = new MemoryEstateStorage();
    const right = new MemoryEstateStorage();
    const client = clientWith({ user });
    const first = await generateV1(client, left, { name: "init" });
    const second = await generateV1(client, right, { name: "init" });
    expect(first.outcome).toBe("published");
    expect(first.stateId).toBe(second.stateId);
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(isSha256(first.stateId)).toBe(true);
    expectTypeOf(first).toMatchTypeOf<GenerateV1Result>();
    await client.$disconnect();
  });

  test("manual generation refuses an unknown parent before publishing", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await generateV1(client, storage, { name: "init" });
    await expect(
      generateV1(client, storage, {
        name: "orphan",
        manualMigration: {
          transitions: [
            {
              from: "a".repeat(64),
              execution: "transactional",
              up: [sql`SELECT 1`],
              rollback: { kind: "irreversible", reason: "manual" },
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
    });
    expect(await storage.listStates()).toHaveLength(1);
    await client.$disconnect();
  });

  test("an empty manual transition set is refused before estate publication", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await expect(
      generateV1(client, storage, {
        name: "empty-manual",
        manualMigration: { transitions: [] },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("at least one"),
    });
    expect(await storage.readEstate()).toBeNull();
    expect(await storage.listSnapshots()).toEqual([]);
    expect(await storage.listSql()).toEqual([]);
    expect(await storage.listStates()).toEqual([]);
    await client.$disconnect();
  });

  test("manual generation snapshots every caller-owned definition layer once", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    let manualReads = 0;
    let transitionListReads = 0;
    let fromReads = 0;
    const transition = Object.defineProperty(
      {
        execution: "transactional",
        up: [sql`SELECT 1`],
        rollback: { kind: "irreversible", reason: "manual" },
      },
      "from",
      {
        enumerable: true,
        get() {
          fromReads += 1;
          return fromReads === 1 ? null : "a".repeat(64);
        },
      }
    );
    const manualMigration = Object.defineProperty({}, "transitions", {
      enumerable: true,
      get() {
        transitionListReads += 1;
        return transitionListReads === 1
          ? [transition]
          : [
              {
                from: "b".repeat(64),
                execution: "transactional",
                up: [sql`SELECT 2`],
                rollback: { kind: "irreversible", reason: "changed" },
              },
            ];
      },
    });
    const options = Object.defineProperty(
      { name: "read-once-manual" },
      "manualMigration",
      {
        enumerable: true,
        get() {
          manualReads += 1;
          return manualMigration;
        },
      }
    );

    const generated = await Reflect.apply(generateV1, undefined, [
      client,
      storage,
      options,
    ]);
    expect(generated.outcome).toBe("published");
    expect({ manualReads, transitionListReads, fromReads }).toEqual({
      manualReads: 1,
      transitionListReads: 1,
      fromReads: 1,
    });
    if (!generated.stateId) throw new Error("expected a published state");
    const graph = await loadMigrationGraph(storage);
    expect(graph.states.get(generated.stateId)?.parents[0]?.fromState).toBe(
      null
    );
    await client.$disconnect();
  });

  test("unreadable manual Sql is refused before estate publication", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    const unreadable = new (class extends Sql {
      override get strings(): string[] {
        throw new Error("hostile Sql strings");
      }
    })(["SELECT 1"], []);

    await expect(
      generateV1(client, storage, {
        name: "unreadable-manual-sql",
        manualMigration: {
          transitions: [
            {
              from: null,
              execution: "transactional",
              up: [unreadable],
              rollback: { kind: "irreversible", reason: "manual" },
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("could not be read"),
      originalCause: expect.any(Error),
    });
    expect(await storage.readEstate()).toBeNull();
    expect(await storage.listSnapshots()).toEqual([]);
    expect(await storage.listSql()).toEqual([]);
    expect(await storage.listStates()).toEqual([]);
    await client.$disconnect();
  });

  test("manual fragments and checks detach changing Sql values once", async () => {
    class ChangingSql extends Sql {
      stringReads = 0;
      valueReads = 0;
      statementCalls = 0;
      private readonly expression: string;
      private readonly firstValue: number;

      constructor(expression: string, firstValue: number) {
        super([expression], []);
        this.expression = expression;
        this.firstValue = firstValue;
      }

      override get strings(): string[] {
        this.stringReads += 1;
        return [`${this.expression} `, ""];
      }

      override get values(): unknown[] {
        this.valueReads += 1;
        return [this.valueReads === 1 ? this.firstValue : 999];
      }

      override toStatement(): string {
        this.statementCalls += 1;
        return `${this.expression}${this.values.length === 0 ? "" : " ?"}`;
      }
    }

    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    const fragment = new ChangingSql("SELECT", 11);
    const check = new ChangingSql("SELECT", 22);
    const generated = await generateV1(client, storage, {
      name: "detached-manual-sql",
      manualMigration: {
        transitions: [
          {
            from: null,
            execution: "transactional",
            up: [fragment],
            rollback: { kind: "irreversible", reason: "manual" },
          },
        ],
        destinationChecks: [
          { kind: "trusted-read", query: check, equals: true },
        ],
      },
    });

    expect({
      fragmentStrings: fragment.stringReads,
      fragmentValues: fragment.valueReads,
      fragmentStatements: fragment.statementCalls,
      checkStrings: check.stringReads,
      checkValues: check.valueReads,
      checkStatements: check.statementCalls,
    }).toEqual({
      fragmentStrings: 1,
      fragmentValues: 1,
      fragmentStatements: 0,
      checkStrings: 1,
      checkValues: 1,
      checkStatements: 0,
    });
    if (!generated.stateId) throw new Error("expected a published state");
    const graph = await loadMigrationGraph(storage);
    const state = graph.states.get(generated.stateId);
    expect(
      state?.parents[0]?.operations[0]?.steps[0]?.execute.parameters
    ).toEqual([{ kind: "number", value: 11 }]);
    expect(state?.destinationChecks[0]?.query.parameters).toEqual([
      { kind: "number", value: 22 },
    ]);
    await client.$disconnect();
  });

  test.each([
    ["NaN", () => Number.NaN],
    ["function", () => () => 1],
    ["symbol", () => Symbol("migration")],
    ["invalid Date", () => new Date(Number.NaN)],
    [
      "cyclic JSON",
      () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      },
    ],
  ])("manual %s parameter is refused without storage writes", async (_name, value) => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });

    await expect(
      generateV1(client, storage, {
        name: "invalid-manual-parameter",
        manualMigration: {
          transitions: [
            {
              from: null,
              execution: "transactional",
              up: [new Sql(["SELECT ", ""], [value()])],
              rollback: { kind: "irreversible", reason: "manual" },
            },
          ],
        },
      })
    ).rejects.toThrow();
    expect(await storage.readEstate()).toBeNull();
    expect(await storage.listSnapshots()).toEqual([]);
    expect(await storage.listSql()).toEqual([]);
    expect(await storage.listStates()).toEqual([]);
    await client.$disconnect();
  });

  test("byte parameters publish and reload without a Buffer global", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
    Reflect.deleteProperty(globalThis, "Buffer");
    let generated: GenerateV1Result | undefined;
    let graph: Awaited<ReturnType<typeof loadMigrationGraph>> | undefined;
    try {
      generated = await generateV1(client, storage, {
        name: "bytes-without-buffer",
        manualMigration: {
          transitions: [
            {
              from: null,
              execution: "transactional",
              up: [sql`SELECT ${Uint8Array.of(0, 1, 254, 255)}`],
              rollback: { kind: "irreversible", reason: "manual" },
            },
          ],
        },
      });
      graph = await loadMigrationGraph(storage);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "Buffer", descriptor);
      }
    }
    if (!generated?.stateId) throw new Error("expected a published state");
    expect(
      graph?.states.get(generated.stateId)?.parents[0]?.operations[0]?.steps[0]
        ?.execute.parameters
    ).toEqual([{ kind: "bytes", value: "AAH+/w==" }]);
    await client.$disconnect();
  });

  test("manual boundary controls are refused before artifact publication", async () => {
    const storage = new MemoryEstateStorage();
    const driver = pgEstateDriver("public");
    const client = createClient({ schema: { user }, driver });
    await expect(
      generateV1(client, storage, {
        name: "unsafe-manual",
        manualMigration: {
          transitions: [
            {
              from: null,
              execution: "transactional",
              up: [sql.raw("COMMIT")],
              rollback: { kind: "irreversible", reason: "manual" },
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unsafe-manual"),
    });
    expect(await storage.readEstate()).toBeNull();
    expect(await storage.listSnapshots()).toEqual([]);
    expect(await storage.listSql()).toEqual([]);
    expect(await storage.listStates()).toEqual([]);
  });

  test.each([
    "BEGIN",
    "COMMIT",
    "END",
    "ROLLBACK",
    "SAVEPOINT migration_owned",
    "RELEASE migration_owned",
  ])("SQLite manual boundary control %s is refused before publication", async (statement) => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await expect(
      generateV1(client, storage, {
        name: "unsafe-sqlite-manual",
        manualMigration: {
          transitions: [
            {
              from: null,
              execution: "transactional",
              up: [sql.raw(statement)],
              rollback: { kind: "irreversible", reason: "manual" },
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unsafe-sqlite-manual"),
    });
    expect(await storage.readEstate()).toBeNull();
    expect(await storage.listSnapshots()).toEqual([]);
    expect(await storage.listSql()).toEqual([]);
    expect(await storage.listStates()).toEqual([]);
    await client.$disconnect();
  });

  test("SQLite manual SQL accepts control words outside statement-control position", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await expect(
      generateV1(client, storage, {
        name: "safe-sqlite-manual",
        manualMigration: {
          transitions: [
            {
              from: null,
              execution: "transactional",
              up: [
                sql.raw(
                  "CREATE TABLE [begin] ([commit] TEXT DEFAULT 'ROLLBACK')"
                ),
                sql.raw(
                  "CREATE TRIGGER savepoint AFTER INSERT ON [begin] BEGIN SELECT 'RELEASE'; END"
                ),
              ],
              rollback: { kind: "irreversible", reason: "manual" },
            },
          ],
        },
      })
    ).resolves.toMatchObject({ outcome: "published" });
    expect(await storage.listStates()).toHaveLength(1);
    await client.$disconnect();
  });

  test("a second virtual-root transition is refused after any published state", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await generateV1(client, storage, { name: "init" });
    await expect(
      generateV1(client, storage, { from: null, name: "second-root" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("virtual-root"),
    });
    expect(await storage.listStates()).toHaveLength(1);
    await client.$disconnect();
  });

  test("dry-run after a schema change previews a child and publishes nothing", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    const published = await generateV1(client, storage, { name: "init" });
    const states = await storage.listStates();
    const snapshots = await storage.listSnapshots();
    const sql = await storage.listSql();
    const nextUser = s.model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
    });
    const next = createClient({
      schema: { user: nextUser },
      driver: new PlanningDriver("sqlite"),
    });
    const preview = await generateV1(next, storage, {
      dryRun: true,
      name: "add-name",
    });
    expect(preview.outcome).toBe("preview");
    expect(preview.stateId).not.toBe(published.stateId);
    expect(await storage.listStates()).toEqual(states);
    expect(await storage.listSnapshots()).toEqual(snapshots);
    expect(await storage.listSql()).toEqual(sql);
    await next.$disconnect();
    await client.$disconnect();
  });

  test("a changed name produces a distinct child state", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    const first = await generateV1(client, storage, { name: "init" });
    const renamed = await generateV1(client, new MemoryEstateStorage(), {
      name: "other",
    });
    expect(first.stateId).not.toBe(renamed.stateId);
    await client.$disconnect();
  });

  test("noop when the unique leaf already matches the schema", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await generateV1(client, storage, { name: "init" });
    const again = await generateV1(client, storage, { name: "again" });
    expect(again.outcome).toBe("noop");
    expect(await storage.listStates()).toHaveLength(1);
    await client.$disconnect();
  });

  test("check reports a valid published estate", async () => {
    const storage = new MemoryEstateStorage();
    const client = clientWith({ user });
    await generateV1(client, storage, { name: "init" });
    const checked = await checkEstate(storage);
    expect(checked.ok).toBe(true);
    const graph = await loadMigrationGraph(storage);
    expect(graph.leaves).toHaveLength(1);
    await client.$disconnect();
  });
});
