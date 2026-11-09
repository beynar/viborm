/**
 * A `tables` estate that widens its list and adopts an existing table: the
 * client's list may grow past the estate's frozen one, history commands
 * select what the estate manages (never the client's list), and
 * `generate({ adopt })` brings a hand-made table under the estate without
 * DDL once apply proves its live shape equals the declaration.
 */

import { createClient } from "@client/client";
import { createMigrationClient } from "@migrations/dialects/all";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import {
  encodeStateManifest,
  encodeTransitionHash,
  parseStateManifest,
} from "@migrations/v1-parse";
import { s } from "@schema";
import { introspect } from "@src/migrations/drivers/sqlite/introspect";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";

type Driver = ReturnType<typeof createInMemorySQLite3Driver>;

const ADOPTS_DEPENDENCY = /adopts "dependency"/;
const CREATES_FRESH = /CREATE TABLE "fresh"/;

const a = s.model({ id: s.string().id() }).map("a");
const dependency = s
  .model({ x: s.string().id(), n: s.int() })
  .index(["n"])
  .map("dependency");

/** The table as a hand-written bootstrap would have made it. */
const RAW_DEPENDENCY = [
  `CREATE TABLE IF NOT EXISTS "dependency" ("x" TEXT NOT NULL, "n" INTEGER NOT NULL, PRIMARY KEY ("x"))`,
  `CREATE INDEX IF NOT EXISTS "dependency_n_idx" ON "dependency" ("n")`,
  `INSERT INTO "dependency" ("x", "n") VALUES ('kept', 1)`,
];

const migrationsOf = (
  driver: Driver,
  storage: MemoryEstateStorage,
  schema: Record<string, unknown>,
  tables: readonly string[]
) =>
  createMigrationClient(
    createClient({ schema: schema as never, driver }) as never,
    { storage, tables }
  );

/** An estate whose frozen list is `["a"]`, applied once, plus raw tables. */
async function estateWithRawTable(raw: readonly string[] = RAW_DEPENDENCY) {
  const driver = createInMemorySQLite3Driver();
  const storage = new MemoryEstateStorage();
  const first = migrationsOf(driver, storage, { a }, ["a"]);
  const base = await first.generate({ name: "a" });
  await first.apply();
  for (const sql of raw) await driver._executeRaw(sql);
  return { driver, storage, first, baseState: base.stateId! };
}

const rows = async (driver: Driver, table = "dependency") =>
  (await driver._executeRaw(`SELECT * FROM "${table}"`)).rows;

const tableSql = async (driver: Driver, table = "dependency") =>
  (
    await driver._executeRaw<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table]
    )
  ).rows[0]?.sql;

const rejection = async (running: Promise<unknown>) => {
  try {
    await running;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected a refusal");
};

describe("a widened `tables` list", () => {
  it("adopts a hand-made table without DDL, keeps its rows, and verifies clean", async () => {
    const { driver, storage, first, baseState } = await estateWithRawTable();
    // The raw table is outside the estate's frozen list: nothing sees it.
    expect(await first.verify()).toEqual({ ok: true });

    const next = migrationsOf(driver, storage, { a, dependency }, [
      "a",
      "dependency",
    ]);
    // The widened client's history commands still select what the estate
    // manages, not its own list.
    expect(await next.verify()).toEqual({ ok: true });
    const generated = await next.generate({
      name: "adopt",
      adopt: ["dependency"],
    });
    expect(generated.outcome).toBe("published");
    expect(generated.operations).toEqual([]);
    expect(generated.reviewSql).toContain(
      "Adopts existing table dependency: no DDL"
    );
    const shown = await next.show({ id: generated.stateId! });
    expect(shown.incoming.map((edge) => edge.adopts)).toEqual([["dependency"]]);
    expect((await next.status()).pending).toEqual([generated.stateId]);

    const applied = await next.apply();
    expect(applied).toMatchObject({
      outcome: "applied",
      path: [generated.stateId],
      statements: [],
    });
    expect(await rows(driver)).toEqual([{ x: "kept", n: 1 }]);
    const status = await next.status();
    expect(status.marker?.stateId).toBe(generated.stateId);
    expect(status.pending).toEqual([]);
    expect(await next.verify()).toEqual({ ok: true });
    expect(baseState).not.toBe(generated.stateId);

    // Managed from now on: a later change is ordinary DDL on it.
    const grown = s
      .model({ x: s.string().id(), n: s.int(), note: s.string().nullable() })
      .index(["n"])
      .map("dependency");
    const later = migrationsOf(driver, storage, { a, dependency: grown }, [
      "a",
      "dependency",
    ]);
    await later.generate({ name: "note" });
    await later.apply();
    expect(await rows(driver)).toEqual([{ x: "kept", n: 1, note: null }]);
    expect(await later.verify()).toEqual({ ok: true });
  });

  it("refuses at apply, before any effect, a live table that is not the declaration", async () => {
    const mismatches: [string, readonly string[]][] = [
      [
        "a column type",
        [
          `CREATE TABLE "dependency" ("x" TEXT NOT NULL, "n" TEXT NOT NULL, PRIMARY KEY ("x"))`,
          `CREATE INDEX "dependency_n_idx" ON "dependency" ("n")`,
        ],
      ],
      [
        "a missing index",
        [
          `CREATE TABLE "dependency" ("x" TEXT NOT NULL, "n" INTEGER NOT NULL, PRIMARY KEY ("x"))`,
        ],
      ],
      [
        // SQLite lets this key hold NULL, which the declared ID cannot read.
        "a key column without NOT NULL",
        [
          `CREATE TABLE "dependency" ("x" TEXT, "n" INTEGER NOT NULL, PRIMARY KEY ("x"))`,
          `CREATE INDEX "dependency_n_idx" ON "dependency" ("n")`,
        ],
      ],
      [
        "WITHOUT ROWID",
        [
          `CREATE TABLE "dependency" ("x" TEXT NOT NULL, "n" INTEGER NOT NULL, PRIMARY KEY ("x")) WITHOUT ROWID`,
          `CREATE INDEX "dependency_n_idx" ON "dependency" ("n")`,
        ],
      ],
    ];
    for (const [label, ddl] of mismatches) {
      const { driver, storage, baseState } = await estateWithRawTable([
        ...ddl,
        `INSERT INTO "dependency" ("x", "n") VALUES ('kept', 1)`,
      ]);
      const before = await tableSql(driver);
      const next = migrationsOf(driver, storage, { a, dependency }, [
        "a",
        "dependency",
      ]);
      await next.generate({ name: "adopt", adopt: ["dependency"] });
      const refused = await rejection(next.apply());
      expect(refused.code, label).toBe("V11014");
      // The destination proof's, not the origin's: before the step the raw
      // table is not managed, so nothing proposes to drop it.
      expect(refused.message, label).not.toContain("dropTable");
      expect((await next.status()).marker?.stateId, label).toBe(baseState);
      expect(await tableSql(driver), label).toBe(before);
      expect(await rows(driver), label).toHaveLength(1);
    }
  });

  it("adopts a WITHOUT ROWID table declared `.withoutRowid()`", async () => {
    const clustered = s
      .model({ x: s.string().id(), n: s.int() })
      .map("dependency")
      .withoutRowid();
    const { driver, storage } = await estateWithRawTable([
      `CREATE TABLE "dependency" ("x" TEXT NOT NULL, "n" INTEGER NOT NULL, PRIMARY KEY ("x")) WITHOUT ROWID`,
      `INSERT INTO "dependency" ("x", "n") VALUES ('kept', 1)`,
    ]);
    const next = migrationsOf(driver, storage, { a, dependency: clustered }, [
      "a",
      "dependency",
    ]);
    await next.generate({ name: "adopt", adopt: ["dependency"] });
    expect((await next.apply()).outcome).toBe("applied");
    expect(await rows(driver)).toEqual([{ x: "kept", n: 1 }]);
    expect(await next.verify()).toEqual({ ok: true });
  });

  it("never lets reset drop a listed table nothing adopted yet", async () => {
    const { driver, storage, baseState } = await estateWithRawTable();
    const widened = migrationsOf(driver, storage, { a }, ["a", "dependency"]);
    const preview = await widened.reset({ dryRun: true });
    expect(preview.tables).toEqual(["a"]);
    await widened.reset();
    expect(await rows(driver)).toEqual([{ x: "kept", n: 1 }]);
    expect((await widened.status()).marker?.stateId).toBe(baseState);
    expect(await widened.verify()).toEqual({ ok: true });
  });

  it("reset replays an adoption of a table it does not clear, and refuses one it would", async () => {
    const { driver, storage } = await estateWithRawTable();
    const next = migrationsOf(driver, storage, { a, dependency }, [
      "a",
      "dependency",
    ]);
    const adopted = await next.generate({
      name: "adopt",
      adopt: ["dependency"],
    });
    // Unadopted live, the raw table survives the clear and the replay
    // adopts it with the same proof.
    expect((await next.reset({ dryRun: true })).tables).toEqual(["a"]);
    await next.reset();
    expect((await next.status()).marker?.stateId).toBe(adopted.stateId);
    expect(await rows(driver)).toEqual([{ x: "kept", n: 1 }]);
    // Adopted now, the clear would drop it and nothing could recreate it.
    const refused = await rejection(next.reset());
    expect(refused.code).toBe("V11009");
    expect(refused.message).toMatch(ADOPTS_DEPENDENCY);
    expect(await rows(driver)).toEqual([{ x: "kept", n: 1 }]);
  });

  it("refuses an adoption it cannot admit at generate, publishing nothing", async () => {
    const { driver, storage, first } = await estateWithRawTable();
    const states = async () => (await first.list()).length;
    const published = await states();
    const refusals: [string, () => Promise<unknown>][] = [
      // A name of the estate's own list is managed: a raw one is drift.
      [
        "estate already manages",
        () =>
          migrationsOf(driver, storage, { a, dependency }, [
            "a",
            "dependency",
          ]).generate({ adopt: ["a"] }),
      ],
      [
        "does not declare",
        () =>
          migrationsOf(driver, storage, { a }, ["a", "dependency"]).generate({
            adopt: ["dependency"],
          }),
      ],
      // The schema cannot declare a table its client does not list.
      [
        "outside the authenticated managed-table list",
        () =>
          migrationsOf(driver, storage, { a, dependency }, ["a"]).generate({
            adopt: ["dependency"],
          }),
      ],
    ];
    for (const [message, running] of refusals) {
      const refused = await rejection(running());
      expect(refused.message).toContain(message);
    }
    // An estate without a list manages everything: nothing to adopt.
    const whole = createInMemorySQLite3Driver();
    const unlisted = createMigrationClient(
      createClient({
        schema: { a, dependency } as never,
        driver: whole,
      }) as never,
      { storage: new MemoryEstateStorage() }
    );
    expect(
      (await rejection(unlisted.generate({ adopt: ["dependency"] }))).message
    ).toContain("needs an estate with a `tables` list");
    // A parent that already has the table.
    const next = migrationsOf(driver, storage, { a, dependency }, [
      "a",
      "dependency",
    ]);
    await next.generate({ name: "adopt", adopt: ["dependency"] });
    const after = await states();
    const already = await rejection(
      migrationsOf(
        driver,
        storage,
        {
          a,
          dependency: s
            .model({ x: s.string().id(), n: s.int(), m: s.int().nullable() })
            .index(["n"])
            .map("dependency"),
        },
        ["a", "dependency"]
      ).generate({ adopt: ["dependency"] })
    );
    expect(already.message).toContain("already has");
    expect(await states()).toBe(after);
    expect(after).toBe(published + 1);
  });

  it("refuses a narrowed list, and a list on one side only", async () => {
    const { driver, storage } = await estateWithRawTable();
    const narrowed = await rejection(
      migrationsOf(driver, storage, {}, ["dependency"]).verify()
    );
    expect(narrowed.code).toBe("V11004");
    expect(narrowed.message).toContain('omits "a"');
    const unlisted = await rejection(
      createMigrationClient(
        createClient({ schema: { a } as never, driver }) as never,
        { storage }
      ).verify()
    );
    expect(unlisted.code).toBe("V11004");
    expect(unlisted.message).toContain("passes none");
  });

  it("adds a new model to a list estate as an ordinary CREATE TABLE", async () => {
    const { driver, storage } = await estateWithRawTable([]);
    const fresh = s.model({ id: s.string().id() }).map("fresh");
    const next = migrationsOf(driver, storage, { a, fresh }, ["a", "fresh"]);
    const generated = await next.generate({ name: "fresh" });
    expect(generated.operations.map(({ type }) => type)).toEqual([
      "createTable",
    ]);
    const applied = await next.apply();
    expect(applied.statements.join("\n")).toMatch(CREATES_FRESH);
    expect(await tableSql(driver, "fresh")).toBeDefined();
    expect(await next.verify()).toEqual({ ok: true });
    // Its rollback drops it again, as for any created table.
    await next.down();
    expect(await tableSql(driver, "fresh")).toBeUndefined();
    expect(await next.verify()).toEqual({ ok: true });
  });

  it("releases an adopted table on down: no DDL, rows kept, the parent verifies clean", async () => {
    const { driver, storage, baseState } = await estateWithRawTable();
    const next = migrationsOf(driver, storage, { a, dependency }, [
      "a",
      "dependency",
    ]);
    await next.generate({ name: "adopt", adopt: ["dependency"] });
    await next.apply();
    const preview = await next.down({ dryRun: true });
    expect(preview).toMatchObject({ preview: true, refusal: null });
    await next.down();
    expect((await next.status()).marker?.stateId).toBe(baseState);
    expect(await rows(driver)).toEqual([{ x: "kept", n: 1 }]);
    expect(await next.verify()).toEqual({ ok: true });
    // Released, it is the user's again: re-applying adopts it again.
    expect((await next.apply()).outcome).toBe("applied");
    expect(await next.verify()).toEqual({ ok: true });
  });

  it("reanchor compares each state with what it manages, from one read", async () => {
    const { driver, storage, baseState } = await estateWithRawTable();
    await migrationsOf(driver, storage, { a, dependency }, [
      "a",
      "dependency",
    ]).generate({ name: "adopt", adopt: ["dependency"] });
    await migrationsOf(driver, storage, { a, dependency }, [
      "a",
      "dependency",
    ]).apply();
    // A restored history: the same first state, the adoption regenerated
    // under another name (another id), so the marker is ahead of it.
    const restored = new MemoryEstateStorage();
    expect(
      (
        await migrationsOf(driver, restored, { a }, ["a"]).generate({
          name: "a",
        })
      ).stateId
    ).toBe(baseState);
    const history = migrationsOf(driver, restored, { a, dependency }, [
      "a",
      "dependency",
    ]);
    const readopted = await history.generate({
      name: "adopt again",
      adopt: ["dependency"],
    });
    // The first state manages only `a`, so the live database matches it too.
    const ambiguous = await rejection(history.reanchor());
    expect(ambiguous.message).toContain("Several states");
    expect(await history.reanchor({ to: { id: readopted.stateId! } })).toEqual({
      stateId: readopted.stateId,
    });
    expect(await history.verify()).toEqual({ ok: true });
    expect(await rows(driver)).toEqual([{ x: "kept", n: 1 }]);
  });

  it("keeps refusing a raw table whose foreign key crosses into the managed set", async () => {
    // The boundary rule predates adoption: such a table fails every proof
    // before it could be adopted, so adoption never meets one.
    const { driver, storage } = await estateWithRawTable([
      `CREATE TABLE "child" ("id" TEXT NOT NULL PRIMARY KEY, "a_id" TEXT NOT NULL REFERENCES "a" ("id"))`,
    ]);
    const refused = await rejection(
      migrationsOf(driver, storage, { a }, ["a", "child"]).verify()
    );
    expect(refused.message).toContain("crosses the managed-table boundary");
  });

  it("refuses to load a stored adoption of a table the estate already manages", async () => {
    const { driver, storage } = await estateWithRawTable();
    const adopted = await migrationsOf(driver, storage, { a, dependency }, [
      "a",
      "dependency",
    ]).generate({ name: "adopt", adopt: ["dependency"] });
    const forged = new MemoryEstateStorage();
    await forged.publishEstate((await storage.readEstate())!);
    for (const hash of await storage.listSnapshots())
      await forged.publishSnapshot(hash, (await storage.readSnapshot(hash))!);
    for (const hash of await storage.listSql())
      await forged.publishSql(hash, (await storage.readSql(hash))!);
    for (const id of await storage.listStates()) {
      const bytes = (await storage.readState(id))!;
      if (id !== adopted.stateId) {
        await forged.publishState(id, bytes);
        continue;
      }
      // Recomputed identities: only the graph's own rule can refuse it.
      const {
        stateId: _id,
        parents,
        ...manifest
      } = parseStateManifest(bytes, id);
      const reparented = parents.map(({ transitionHash: _hash, ...parent }) => {
        const body = { ...parent, adopts: ["a", "dependency"] };
        return { ...body, transitionHash: encodeTransitionHash(body) };
      });
      const encoded = encodeStateManifest({ ...manifest, parents: reparented });
      await forged.publishState(encoded.stateId, encoded.bytes);
    }
    const refused = await rejection(
      migrationsOf(driver, forged, { a, dependency }, [
        "a",
        "dependency",
      ]).verify()
    );
    expect(refused.code).toBe("V11012");
    expect(refused.message).toContain('adopts "a"');
  });
});

describe("SQLite key-column nullability", () => {
  it("reads what SQLite enforces, not only what was declared", async () => {
    const cases: [string, string, boolean][] = [
      ["TEXT key", `("x" TEXT, PRIMARY KEY ("x"))`, true],
      ["TEXT key NOT NULL", `("x" TEXT NOT NULL, PRIMARY KEY ("x"))`, false],
      ["compound key", `("x" INTEGER, "y" TEXT, PRIMARY KEY ("x", "y"))`, true],
      ["rowid alias", `("x" INTEGER PRIMARY KEY)`, false],
      ["table-level rowid alias", `("x" integer, PRIMARY KEY ("x"))`, false],
      ["autoincrement", `("x" INTEGER PRIMARY KEY AUTOINCREMENT)`, false],
      ["WITHOUT ROWID", `("x" TEXT, PRIMARY KEY ("x")) WITHOUT ROWID`, false],
    ];
    for (const [label, definition, nullable] of cases) {
      const driver = createInMemorySQLite3Driver();
      await driver._executeRaw(`CREATE TABLE "t" ${definition}`);
      const accepted = await driver
        ._executeRaw(`INSERT INTO "t" ("x") VALUES (NULL)`)
        .then(
          async () =>
            (await driver._executeRaw(`SELECT "x" FROM "t"`)).rows[0]?.x ===
            null,
          () => false
        );
      // The oracle: what the database stores, not what the reader says.
      expect(accepted, label).toBe(nullable);
      const { tables } = await introspect(
        (sql, params) => driver._executeRaw(sql, params) as never
      );
      expect(tables[0]?.columns[0]?.nullable, label).toBe(nullable);
      await driver.disconnect();
    }
  });
});
