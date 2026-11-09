/**
 * Adoption on a real MySQL server: a hand-made table is adopted only when it
 * is the declaration, including what MySQL decides beside the columns (its
 * engine, its collations, its triggers and CHECKs), which no snapshot states.
 *
 * Requires the Docker test database:
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { createMigrationClient } from "@migrations/dialects/all";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING ?? "";
const describeIfMySQL = CONNECTION ? describe : describe.skip;

const DATABASE = "viborm_adoption_estate";
const a = s.model({ id: s.string().id() }).map("a");
const dependency = s
  .model({ x: s.string().id(), n: s.int(), label: s.string() })
  .index(["n"])
  .map("dependency");

describeIfMySQL("MySQL adoption (docker)", () => {
  let pool: Pool;
  let admin: MySQL2Driver;
  const driver = () =>
    new MySQL2Driver({
      pool,
      namespace: DATABASE,
      migrationNamespaceAttestation: "non-redirecting",
    });
  const migrationsOf = (
    storage: MemoryEstateStorage,
    schema: Record<string, unknown>,
    tables: readonly string[]
  ) =>
    createMigrationClient(
      createClient({ schema: schema as never, driver: driver() }) as never,
      { storage, tables }
    );
  const sql = (text: string) => admin._executeRaw(text);

  beforeAll(async () => {
    pool = createPool(CONNECTION);
    admin = new MySQL2Driver({
      pool,
      migrationNamespaceAttestation: "non-redirecting",
    });
  });
  afterAll(async () => {
    await sql(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await pool.end();
  });
  beforeEach(async () => {
    await sql(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await sql(`CREATE DATABASE \`${DATABASE}\``);
  });

  /**
   * `dependency` exactly as VibORM writes it (a scratch estate, then
   * forgotten), changed by `raw`, beside an estate that manages only `a`.
   */
  async function estateBesideDeclaredTable(raw: readonly string[]) {
    const scratch = migrationsOf(new MemoryEstateStorage(), { dependency }, [
      "dependency",
    ]);
    await scratch.generate({ name: "scratch" });
    await scratch.apply();
    for (const table of ["_viborm_migration_state", "_viborm_migration_log"])
      await sql(`DROP TABLE \`${DATABASE}\`.\`${table}\``);
    await sql(
      `INSERT INTO \`${DATABASE}\`.\`dependency\` VALUES ('kept', 1, 'k')`
    );
    const storage = new MemoryEstateStorage();
    const first = migrationsOf(storage, { a }, ["a"]);
    await first.generate({ name: "a" });
    await first.apply();
    for (const statement of raw) await sql(statement);
    return storage;
  }

  it("adopts the declaration's own shape", async () => {
    const storage = await estateBesideDeclaredTable([]);
    const next = migrationsOf(storage, { a, dependency }, ["a", "dependency"]);
    await next.generate({ name: "adopt", adopt: ["dependency"] });
    expect((await next.apply()).outcome).toBe("applied");
    expect(await next.verify()).toEqual({ ok: true });
  }, 60_000);

  it("refuses before any effect a table carrying behaviour its declaration does not state", async () => {
    const table = `\`${DATABASE}\`.\`dependency\``;
    const hazards: [string, readonly string[]][] = [
      [
        'CHECK constraint "positive"',
        [`ALTER TABLE ${table} ADD CONSTRAINT positive CHECK (\`n\` > 0)`],
      ],
      ["ENGINE=MyISAM", [`ALTER TABLE ${table} ENGINE=MyISAM`]],
      [
        'a collation on column "label"',
        [
          `ALTER TABLE ${table} MODIFY \`label\` VARCHAR(191) COLLATE utf8mb4_0900_ai_ci NOT NULL`,
        ],
      ],
      // New columns would take it: VibORM's ADD COLUMN writes no collation.
      [
        "the table collation utf8mb4_0900_ai_ci",
        [
          `ALTER TABLE ${table} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
        ],
      ],
      [
        'trigger "no_inserts"',
        [
          `CREATE TRIGGER \`${DATABASE}\`.no_inserts BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no'`,
        ],
      ],
    ];
    for (const [feature, raw] of hazards) {
      await sql(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
      await sql(`CREATE DATABASE \`${DATABASE}\``);
      const storage = await estateBesideDeclaredTable(raw);
      const next = migrationsOf(storage, { a, dependency }, [
        "a",
        "dependency",
      ]);
      const base = (await next.status()).marker?.stateId;
      await next.generate({ name: "adopt", adopt: ["dependency"] });
      for (const run of [
        () => next.apply(),
        () => next.reset({ dryRun: true }),
      ]) {
        await expect(run(), feature).rejects.toMatchObject({
          code: "V11014",
          message: expect.stringContaining(
            `Cannot adopt "dependency": it has ${feature}`
          ),
        });
      }
      expect((await next.status()).marker?.stateId, feature).toBe(base);
      expect((await sql(`SELECT * FROM ${table}`)).rows, feature).toHaveLength(
        1
      );
    }
  }, 180_000);
});
