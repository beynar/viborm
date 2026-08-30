import { createClient } from "@client/client";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { compileManualTransition } from "@src/migrations/compile";
import { SqlAssembly } from "@src/migrations/sql-assembly";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it, vi } from "vitest";

const schema = {
  user: s.model({ id: s.string().id() }),
};

const invalidForwardPrograms: readonly [string, () => readonly Sql[]][] = [
  ["an empty forward program", () => []],
  ["a trailing empty dispatch", () => [sql.raw("SELECT 1"), sql.raw("")]],
  [
    "a trailing whitespace-only dispatch",
    () => [sql.raw("SELECT 1"), sql.raw(" \n\t")],
  ],
  [
    "a nested whitespace-only dispatch",
    () => [sql.raw("SELECT 1"), sql`${sql.raw(" \n\t")}`],
  ],
];

type Issue34Driver =
  | ReturnType<typeof createInMemorySQLite3Driver>
  | ReturnType<typeof createInMemoryPGliteDriver>;

const providers: readonly (readonly [string, () => Issue34Driver])[] = [
  ["SQLite3", createInMemorySQLite3Driver],
  ["PGlite", createInMemoryPGliteDriver],
];

describe("manual migration dispatch admission", () => {
  for (const [provider, createDriver] of providers) {
    describe(provider, () => {
      it.each(
        invalidForwardPrograms
      )("refuses %s before publication or provider execution", async (_case, createUp) => {
        const storage = new MemoryEstateStorage();
        const driver = createDriver();
        const execute = vi.spyOn(driver, "_executeRaw");
        const client = createClient({ schema, driver });
        const migrations = createMigrationClient(client, { storage });

        try {
          await expect(
            migrations.generate({
              name: "blank-manual-dispatch",
              manualMigration: {
                transitions: [
                  {
                    from: null,
                    execution: "transactional",
                    up: createUp(),
                    rollback: {
                      kind: "irreversible",
                      reason: "the transition is intentionally one-way",
                    },
                  },
                ],
              },
            })
          ).rejects.toMatchObject({
            code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
          });

          expect(execute).not.toHaveBeenCalled();
          expect(await storage.readEstate()).toBeNull();
          expect(await storage.listSnapshots()).toEqual([]);
          expect(await storage.listSql()).toEqual([]);
          expect(await storage.listStates()).toEqual([]);
        } finally {
          await client.$disconnect();
        }
      });
    });
  }

  it.each<[string, readonly Sql[]]>([
    ["an empty rollback program", []],
    ["a whitespace-only rollback dispatch", [sql.raw(" \n\t")]],
  ])("refuses %s at the same compiler boundary", (_case, rollback) => {
    expect(() =>
      compileManualTransition(
        [sql.raw("SELECT 1")],
        { kind: "manual", execution: "transactional", sql: rollback },
        "sqlite",
        "transactional",
        undefined,
        new SqlAssembly()
      )
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      })
    );
  });

  it.each<["sqlite" | "postgresql", "?" | "$1"]>([
    ["sqlite", "?"],
    ["postgresql", "$1"],
  ])("keeps one valid opaque %s statement byte-exact", (dialect, placeholder) => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`  SELECT  ${42} AS issue_34; SELECT 43 \t`],
      { kind: "irreversible", reason: "the transition is one-way" },
      dialect,
      "transactional",
      undefined,
      assembly
    );
    const sealed = assembly.seal();

    expect(compiled.operations).toHaveLength(1);
    expect(compiled.operations[0]?.steps).toHaveLength(1);
    expect(sealed.dispatches).toHaveLength(1);
    expect(new TextDecoder().decode(sealed.bytes)).toBe(
      `  SELECT  ${placeholder} AS issue_34; SELECT 43 \t`
    );
    expect(sealed.dispatches[0]?.parameters).toEqual([
      { kind: "number", value: 42 },
    ]);
  });
});
