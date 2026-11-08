import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { qualifiedName } from "@migrations/catalog-probes";
import { createMigrationClient } from "@migrations/client";
import { CONTROL_TABLES } from "@migrations/control";
import { getMigrationDriver } from "@migrations/drivers";
import { rawIndexHash } from "@migrations/raw-index";
import { serializeModels } from "@migrations/serializer";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import type { DiffOperation, IndexDef } from "@migrations/types";
import { s } from "@schema";
import type { AnyModel, RawIndexTemplates } from "@schema/model";
import { defineContract } from "@tests/contracts/contract";
import { describe, expect, test } from "vitest";

const TABLE = "raw_index_documents";
const INDEX = "raw_index_documents_text";

/** Each dialect's two texts, a hand-made index of the same name, and its drop. */
interface RawIndexDialect {
  readonly key: keyof RawIndexTemplates;
  /** What the indexed field holds: a string, or a vector for an HNSW. */
  readonly kind: "string" | "vector";
  readonly first: string;
  readonly second: string;
  readonly handMade: (column: string) => string;
  readonly drop: string;
}

const DIALECTS: Readonly<Record<string, RawIndexDialect>> = {
  postgresql: {
    key: "pg",
    kind: "string",
    first: "CREATE INDEX {name} ON {table} (lower({FIELD}))",
    second: "CREATE INDEX {name} ON {table} (upper({FIELD}))",
    handMade: (column) => `CREATE INDEX "${INDEX}" ON "${TABLE}" ("${column}")`,
    drop: `DROP INDEX "${INDEX}"`,
  },
  mysql: {
    key: "mysql",
    kind: "string",
    first: "CREATE INDEX {name} ON {table} ({FIELD}(16))",
    second: "CREATE INDEX {name} ON {table} ({FIELD}(8))",
    // The column is TEXT: a raw index keys nothing, so it stays as declared.
    handMade: (column) =>
      `CREATE INDEX \`${INDEX}\` ON \`${TABLE}\` (\`${column}\`(10))`,
    drop: `DROP INDEX \`${INDEX}\` ON \`${TABLE}\``,
  },
  sqlite: {
    key: "sqlite",
    kind: "string",
    first: "CREATE INDEX {name} ON {table} (lower({FIELD}))",
    second: "CREATE INDEX {name} ON {table} (upper({FIELD}))",
    handMade: (column) => `CREATE INDEX "${INDEX}" ON "${TABLE}" ("${column}")`,
    drop: `DROP INDEX "${INDEX}"`,
  },
  surrealql: {
    key: "surrealdb",
    kind: "vector",
    first:
      "DEFINE INDEX {name} ON {table} FIELDS {FIELD} HNSW DIMENSION 3 DIST COSINE",
    second:
      "DEFINE INDEX {name} ON TABLE {table} FIELDS {FIELD} HNSW DIMENSION 3 DIST EUCLIDEAN",
    handMade: (column) => `DEFINE INDEX ${INDEX} ON ${TABLE} FIELDS ${column};`,
    drop: `REMOVE INDEX ${INDEX} ON ${TABLE};`,
  },
};

interface Version {
  /** The indexed field, renamed (with its column) from `title` to `heading`. */
  readonly field: "title" | "heading";
  /** Which text the raw index has, or none. */
  readonly text: "first" | "second" | undefined;
  /** A nullable `score`: on SQLite the change rebuilds the table. */
  readonly nullableScore: boolean;
}

function templateOf(dialect: RawIndexDialect, version: Version): string {
  return dialect[version.text!].replace("{FIELD}", `{${version.field}}`);
}

function schemaOf(
  dialect: RawIndexDialect,
  version: Version
): Record<string, AnyModel> {
  const indexed =
    dialect.kind === "vector" ? s.vector().dimension(3) : s.string();
  const score = version.nullableScore ? s.int().nullable() : s.int();
  const document =
    version.field === "title"
      ? s.model({ id: s.string().id(), title: indexed, score })
      : s.model({ id: s.string().id(), heading: indexed, score });
  if (version.text === undefined) return { document: document.map(TABLE) };
  const templates: RawIndexTemplates = {};
  templates[dialect.key] = templateOf(dialect, version);
  return { document: document.rawIndex(INDEX, templates).map(TABLE) };
}

const renamed = (change: { type: string; rename?: () => unknown }) =>
  change.type === "ambiguous" ? (change.rename?.() as never) : undefined;

export interface RawIndexBehaviorOptions {
  readonly driverName: string;
  /** A driver on an empty database. */
  readonly createDriver: () => AnyDriver;
  /**
   * Whether this provider admits live migration commands. LibSQL and D1
   * declare no SQLite migration capability: they refuse `push` and `apply`,
   * and their run executes the statements generation renders, by hand.
   */
  readonly push: boolean;
  /**
   * Whether `reset` replays this history. SurrealDB's replay of a history
   * holding a column rename conflicts with itself in its one transaction
   * (V5001), with a plain `.index()` in place of the raw one too (measured
   * 2026-11-08): a limit of that reset, not of raw indexes.
   */
  readonly resetsRenames?: boolean;
}

/** `.rawIndex()` from push to reset, on one provider. */
export function runRawIndexBehavior({
  driverName,
  createDriver,
  push,
  resetsRenames = true,
}: RawIndexBehaviorOptions): void {
  describe(`${driverName} raw indexes`, () => {
    async function withDriver(
      run: (
        driver: AnyDriver,
        dialect: RawIndexDialect,
        clientOf: (
          version: Version
        ) => Parameters<typeof createMigrationClient>[0]
      ) => Promise<void>
    ): Promise<void> {
      const driver = createDriver();
      const dialect = DIALECTS[driver.dialect]!;
      const clients: { $disconnect(): Promise<void> }[] = [];
      const clientOf = (version: Version) => {
        const client = createClient({
          schema: schemaOf(dialect, version),
          driver,
        });
        clients.push(client);
        return client;
      };
      try {
        await run(driver, dialect, clientOf);
      } finally {
        const command = getMigrationDriver(driver);
        if (driver.dialect !== "surrealql") {
          for (const table of [CONTROL_TABLES.log, CONTROL_TABLES.state])
            await driver._executeRaw(
              `DROP TABLE IF EXISTS ${qualifiedName(command, table)}`
            );
          await driver._executeRaw(
            `DROP TABLE IF EXISTS ${qualifiedName(command, TABLE)}`
          );
        }
        await (clients[0]?.$disconnect() ?? driver.disconnect());
      }
    }

    /** The live raw index, as introspection reads it back. */
    async function liveIndex(driver: AnyDriver): Promise<IndexDef | undefined> {
      const live = await getMigrationDriver(driver).introspect(
        (statement, parameters) => driver._executeRaw(statement, parameters)
      );
      return live.tables
        .find(({ name }) => name === TABLE)
        ?.indexes.find(({ name }) => name === INDEX);
    }

    const expected = (dialect: RawIndexDialect, version: Version) => ({
      name: INDEX,
      columns: [version.field],
      unique: false,
      raw: { hash: rawIndexHash(templateOf(dialect, version)) },
    });

    test.runIf(push)(
      "push creates it, follows its text and its field, and drops it",
      async () => {
        await withDriver(async (driver, dialect, clientOf) => {
          const kinds = async (version: Version) => {
            const result = await createMigrationClient(clientOf(version)).push({
              resolve: renamed as never,
            });
            return result.operations.map(({ label }) =>
              label.split(" ").slice(1, 3).join(" ")
            );
          };
          const settled = async (version: Version) =>
            expect(
              await createMigrationClient(clientOf(version)).push()
            ).toMatchObject({
              outcome: "noop",
              operations: [],
            });

          const first: Version = {
            field: "title",
            text: "first",
            nullableScore: false,
          };
          expect(await kinds(first)).toContain("Create table");
          expect(await liveIndex(driver)).toEqual(expected(dialect, first));
          await settled(first);

          // A changed text is a new index.
          const second: Version = { ...first, text: "second" };
          expect(await kinds(second)).toEqual(["Drop index", "Create index"]);
          await settled(second);

          // A hand-made index under its name is replaced by it.
          await driver._executeRaw(dialect.drop);
          await driver._executeRaw(dialect.handMade("title"));
          expect(await kinds(second)).toEqual(["Drop index", "Create index"]);
          expect(await liveIndex(driver)).toEqual(expected(dialect, second));
          await settled(second);

          // On SQLite the table is rebuilt, and the index with it.
          const rebuilt: Version = { ...second, nullableScore: true };
          expect(await kinds(rebuilt)).toContain("Alter column");
          expect(await liveIndex(driver)).toEqual(expected(dialect, rebuilt));
          await settled(rebuilt);

          // The field and its column renamed: the index follows it.
          const heading: Version = { ...rebuilt, field: "heading" };
          expect(await kinds(heading)).toEqual(
            expect.arrayContaining([
              "Rename column",
              "Drop index",
              "Create index",
            ])
          );
          expect(await liveIndex(driver)).toEqual(expected(dialect, heading));
          await settled(heading);

          const removed: Version = { ...heading, text: undefined };
          expect(await kinds(removed)).toEqual(["Drop index"]);
          expect(await liveIndex(driver)).toBeUndefined();
          await settled(removed);
        });
      }
    );

    test.runIf(!push)(
      "what generation renders is read back, through a column rename",
      async () => {
        await withDriver(async (driver, dialect) => {
          const first: Version = {
            field: "title",
            text: "first",
            nullableScore: false,
          };
          const command = getMigrationDriver(driver);
          const [table] = serializeModels(schemaOf(dialect, first), {
            migrationDriver: command,
          }).tables;
          const run = async (operation: DiffOperation) => {
            for (const statement of command.compileStatements(operation, {
              destination: "live",
              currentSchema: { tables: [table!] },
            }))
              await driver._executeRaw(statement);
          };
          await run({ type: "createTable", table: table! });
          expect(await liveIndex(driver)).toEqual(expected(dialect, first));
          // Its column renamed by a field's `.map()`: the text it was
          // rendered from is the same, and the marker names the new column.
          await run({
            type: "renameColumn",
            tableName: TABLE,
            from: "title",
            to: "heading",
          });
          expect(await liveIndex(driver)).toEqual({
            ...expected(dialect, first),
            columns: ["heading"],
          });
        });
      }
    );

    test.runIf(push)(
      "generate, apply, verify, down after a rename, and reset converge",
      async () => {
        await withDriver(async (driver, dialect, clientOf) => {
          const storage = new MemoryEstateStorage();
          const step = async (name: string, version: Version) => {
            const migrations = createMigrationClient(clientOf(version), {
              storage,
            });
            await migrations.generate({ name, resolve: renamed as never });
            await expect(migrations.apply()).resolves.toMatchObject({
              outcome: "applied",
            });
            await expect(migrations.verify()).resolves.toEqual({ ok: true });
            expect(await liveIndex(driver)).toEqual(expected(dialect, version));
            return migrations;
          };
          const first: Version = {
            field: "title",
            text: "first",
            nullableScore: false,
          };
          const second: Version = { ...first, text: "second" };
          const rebuilt: Version = { ...second, nullableScore: true };
          const heading: Version = { ...rebuilt, field: "heading" };
          await step("first", first);
          await step("second", second);
          await step("rebuilt", rebuilt);
          const migrations = await step("heading", heading);

          await expect(migrations.down({ steps: 1 })).resolves.toMatchObject({
            preview: false,
          });
          await expect(migrations.verify()).resolves.toEqual({ ok: true });
          expect(await liveIndex(driver)).toEqual(expected(dialect, rebuilt));

          if (!resetsRenames) return;
          await expect(migrations.reset()).resolves.toMatchObject({
            preview: false,
          });
          await expect(migrations.verify()).resolves.toEqual({ ok: true });
          // A reset replays the whole history, to its leaf.
          expect(await liveIndex(driver)).toEqual(expected(dialect, heading));
        });
      }
    );
  });
}

export const rawIndexContract = defineContract({
  id: "drivers.raw-index",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "ddl"],
  register: runRawIndexBehavior,
});
