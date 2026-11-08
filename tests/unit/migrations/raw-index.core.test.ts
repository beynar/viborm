/**
 * Raw indexes (`Model.rawIndex`): one index per dialect in that database's own
 * language. These pin what the migration layer makes of one without a
 * database: what the serializer records, what a stored snapshot admits, the
 * identity the fingerprint and the differ give it, the text each driver
 * renders and refuses, the marker introspection reads back, and the probe a
 * stepwise PostgreSQL run proves its marker with.
 */

import { s } from "@schema";
import { probeForGeneratedStatement } from "@src/migrations/catalog-probes";
import { lowLockSteps } from "@src/migrations/compile";
import { diff } from "@src/migrations/differ";
import { getMigrationDriver } from "@src/migrations/drivers";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { surrealMigrationDriver } from "@src/migrations/drivers/surrealql";
import { applyNativeRename } from "@src/migrations/native-rename";
import { fingerprintSnapshot } from "@src/migrations/push-fingerprint";
import {
  RAW_INDEX_MARKER_PREFIX,
  rawIndexHash,
  rawIndexMarker,
  readRawIndexMarker,
} from "@src/migrations/raw-index";
import { serializeModels } from "@src/migrations/serializer";
import type {
  DiffOperation,
  IndexDef,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import {
  encodeSnapshot,
  parseSnapshotDocument,
} from "@src/migrations/v1-parse-snapshot";
import { describe, expect, it } from "vitest";
import { ddlContext, pgEstateDriver } from "./_estate";

const NO_HEADER =
  /must start with CREATE \[UNIQUE\] INDEX \{name\} ON \{table\}/;
const NOT_A_SCALAR = /names \{titel\}, which is not a scalar field/;
const NO_FIELD = /names no field/;
const HASH_MISMATCH = /raw.hash does not match its template/;
const NO_TEMPLATE = /missing template/;
const NOT_ONLY_RAW = /cannot also be unique/;
const COLUMNS_MISMATCH = /columns are not the fields its template names/;
const NEEDS_NAME = /needs a name/;
const TAKEN_NAME = /has the name of another index/;
const COMMENT_TOO_LONG = /1024-byte index comment/;
const CONCURRENT_HEADER = /must start with|says CONCURRENTLY/;
const SAYS_CONCURRENTLY = /says CONCURRENTLY/;
const SAYS_COMMENT = /says COMMENT/;
const SAYS_ALGORITHM = /says ALGORITHM/;
const SAYS_LOCK = /says LOCK/;
const ONE_STATEMENT =
  /one statement, with no semicolon and no comment left open/;
const UNDECLARED = /this schema does not declare/;
const KEY_HOLDS_RAW_FIELD =
  /holding a field the raw index 'documents_slug_raw'/;

const PG_HNSW =
  "CREATE INDEX {name} ON {table} USING hnsw ({embedding} vector_cosine_ops)";
const SURREAL_HNSW =
  "DEFINE INDEX {name} ON {table} FIELDS {embedding} HNSW DIMENSION 3 DIST COSINE";

const documents = () =>
  s
    .model({
      id: s.string().id(),
      title: s.string(),
      embedding: s.vector().dimension(3).map("embedding_vec"),
    })
    .rawIndex("documents_embedding_hnsw", {
      pg: PG_HNSW,
      surrealdb: SURREAL_HNSW,
    })
    .map("documents");

function tableOf(snapshot: SchemaSnapshot, name: string): TableDef {
  const table = snapshot.tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`no table ${name}`);
  return table;
}

function rawIndex(name: string, template: string, columns: string[]): IndexDef {
  return {
    name,
    columns,
    unique: false,
    raw: { hash: rawIndexHash(template), template },
  };
}

function snapshotWith(...indexes: IndexDef[]): SchemaSnapshot {
  return {
    tables: [
      {
        name: "documents",
        columns: [
          { name: "id", type: "text", nullable: false },
          { name: "embedding_vec", type: "vector(3)", nullable: false },
          { name: "title", type: "text", nullable: false },
        ],
        primaryKey: { columns: ["id"], name: "documents_pkey" },
        indexes,
        foreignKeys: [],
        uniqueConstraints: [],
      },
    ],
  };
}

function snapshotBytes(index: Record<string, unknown>): {
  bytes: Uint8Array;
  hash: string;
} {
  const { bytes, snapshotHash } = encodeSnapshot({
    tables: [
      {
        name: "documents",
        columns: [{ name: "embedding_vec", type: "text", nullable: false }],
        indexes: [index as never],
        foreignKeys: [],
        uniqueConstraints: [],
      },
    ],
  });
  return { bytes, hash: snapshotHash };
}

describe("the serializer records a raw index for its own dialect", () => {
  it("names the template's fields as columns, in order, with the template's hash", () => {
    const snapshot = serializeModels(
      { document: documents() },
      { migrationDriver: postgresMigrationDriver }
    );
    expect(tableOf(snapshot, "documents").indexes).toEqual([
      {
        name: "documents_embedding_hnsw",
        columns: ["embedding_vec"],
        unique: false,
        raw: { hash: rawIndexHash(PG_HNSW), template: PG_HNSW },
      },
    ]);
  });

  it("records nothing on a dialect it has no text for", () => {
    for (const migrationDriver of [
      mysqlMigrationDriver,
      sqlite3MigrationDriver,
    ]) {
      const snapshot = serializeModels(
        { document: documents() },
        { migrationDriver }
      );
      expect(tableOf(snapshot, "documents").indexes).toEqual([]);
    }
  });

  it("keeps the name a foreign key's automatic index would take", () => {
    const author = s
      .model({ id: s.string().id(), posts: s.toMany(() => post) })
      .map("authors");
    const post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        author: s
          .toOne(() => author)
          .fields("authorId")
          .references("id"),
      })
      .rawIndex("posts_authorId_idx", {
        pg: "CREATE INDEX {name} ON {table} (lower({authorId}))",
      })
      .map("posts");
    const indexes = tableOf(
      serializeModels(
        { author, post },
        { migrationDriver: postgresMigrationDriver }
      ),
      "posts"
    ).indexes;
    // The raw index covers nothing, so the foreign key still gets its own,
    // under the constraint's fallback name.
    expect(indexes.map(({ name, raw }) => [name, raw !== undefined])).toEqual([
      ["posts_authorId_idx", true],
      ["posts_authorId_fkey_idx", false],
    ]);
  });

  it("refuses a nameless index, a template without the header, a field that is not a scalar, and one naming none", () => {
    const refusal = (template: string) => () =>
      serializeModels(
        {
          document: s
            .model({ id: s.string().id(), title: s.string() })
            .rawIndex("documents_raw", { pg: template }),
        },
        { migrationDriver: postgresMigrationDriver }
      );
    expect(refusal("CREATE INDEX documents_raw ON {table} ({title})")).toThrow(
      NO_HEADER
    );
    expect(refusal("CREATE INDEX {name} ON {table} ({titel})")).toThrow(
      NOT_A_SCALAR
    );
    expect(refusal("CREATE INDEX {name} ON {table} ((1))")).toThrow(NO_FIELD);
    expect(refusal("  ")).toThrow(NO_HEADER);
    expect(() =>
      serializeModels(
        {
          document: s
            .model({ id: s.string().id(), title: s.string() })
            .rawIndex("", { pg: "CREATE INDEX {name} ON {table} ({title})" }),
        },
        { migrationDriver: postgresMigrationDriver }
      )
    ).toThrow(NEEDS_NAME);
    // The name an `.index()` without one derives is taken too.
    expect(() =>
      serializeModels(
        {
          document: s
            .model({ id: s.string().id(), title: s.string() })
            .index(["title"])
            .rawIndex("documents_title_idx", {
              pg: "CREATE INDEX {name} ON {table} (lower({title}))",
            })
            .map("documents"),
        },
        { migrationDriver: postgresMigrationDriver }
      )
    ).toThrow(TAKEN_NAME);
    expect(() =>
      serializeModels(
        {
          document: s
            .model({ id: s.string().id(), title: s.string() })
            .rawIndex("documents_raw", {
              surrealdb: "DEFINE INDEX {name} ON TABLE {table} FIELDS {title}",
            }),
        },
        { migrationDriver: surrealMigrationDriver }
      )
    ).not.toThrow();
  });
});

describe("a stored snapshot admits a raw index only as it was recorded", () => {
  const recorded = {
    name: "documents_raw",
    columns: ["embedding_vec"],
    unique: false,
    raw: { hash: rawIndexHash(PG_HNSW), template: PG_HNSW },
  };

  it("parses back what the serializer recorded", () => {
    const { bytes, hash } = snapshotBytes(recorded);
    expect(parseSnapshotDocument(bytes, hash).tables[0]!.indexes[0]).toEqual(
      recorded
    );
  });

  it("refuses a hash that is not its template's, and a raw index that is also unique, typed or partial", () => {
    const refused = (index: Record<string, unknown>, message: RegExp) => {
      const { bytes, hash } = snapshotBytes(index);
      expect(() => parseSnapshotDocument(bytes, hash)).toThrow(message);
    };
    refused(
      { ...recorded, raw: { hash: rawIndexHash("other"), template: PG_HNSW } },
      HASH_MISMATCH
    );
    refused({ ...recorded, raw: { hash: recorded.raw.hash } }, NO_TEMPLATE);
    refused({ ...recorded, unique: true }, NOT_ONLY_RAW);
    refused({ ...recorded, type: "gin" }, NOT_ONLY_RAW);
    refused({ ...recorded, where: "x > 1" }, NOT_ONLY_RAW);
    refused({ ...recorded, columns: ["a", "b"] }, COLUMNS_MISMATCH);
  });

  it("leaves the bytes of a snapshot without one as they were", () => {
    const snapshot = serializeModels(
      { document: s.model({ id: s.string().id(), title: s.string() }) },
      { migrationDriver: postgresMigrationDriver }
    );
    expect(
      new TextDecoder().decode(encodeSnapshot(snapshot).bytes)
    ).not.toContain('"raw"');
  });

  it("hashes a template under its own frozen domain", () => {
    expect(rawIndexHash(PG_HNSW)).toBe(rawIndexHash(PG_HNSW));
    expect(rawIndexHash("CREATE INDEX {name} ON {table} ({a})")).toBe(
      "418617fcc15ff8f1c93ee0563dd4781436d48ff61346e5de19f9ae6464537713"
    );
  });
});

describe("a raw index is its name, its text's hash and its columns", () => {
  const declared = rawIndex("documents_raw", PG_HNSW, ["embedding_vec"]);
  const introspected: IndexDef = {
    name: "documents_raw",
    columns: ["embedding_vec"],
    unique: false,
    raw: { hash: rawIndexHash(PG_HNSW) },
  };

  it("fingerprints alike with or without its template, and as nothing else", () => {
    const fingerprint = (index: IndexDef) =>
      fingerprintSnapshot(snapshotWith(index), postgresMigrationDriver);
    expect(fingerprint(introspected)).toBe(fingerprint(declared));
    expect(
      fingerprint({ ...introspected, raw: { hash: rawIndexHash("x") } })
    ).not.toBe(fingerprint(declared));
    expect(fingerprint({ ...introspected, columns: ["title"] })).not.toBe(
      fingerprint(declared)
    );
    expect(
      fingerprint({
        name: "documents_raw",
        columns: ["embedding_vec"],
        unique: false,
      })
    ).not.toBe(fingerprint(declared));
  });

  it("diffs to nothing when unchanged, and to a drop and a create otherwise", async () => {
    const operations = async (current: IndexDef) =>
      (
        await diff(snapshotWith(current), snapshotWith(declared))
      ).operations.map((operation) => operation.type);
    expect(await operations(introspected)).toEqual([]);
    expect(
      await operations({ ...introspected, raw: { hash: rawIndexHash("x") } })
    ).toEqual(["dropIndex", "createIndex"]);
    expect(await operations({ ...introspected, columns: ["title"] })).toEqual([
      "dropIndex",
      "createIndex",
    ]);
    // A hand-made index under its name is replaced by it.
    expect(
      await operations({
        name: "documents_raw",
        columns: ["embedding_vec"],
        unique: false,
      })
    ).toEqual(["dropIndex", "createIndex"]);
  });

  it("follows a column rename like any index, its marker written again", () => {
    const rename = {
      type: "renameColumn",
      tableName: "documents",
      from: "embedding_vec",
      to: "vec",
    } as const;
    const renamed = applyNativeRename(snapshotWith(declared), rename);
    expect(tableOf(renamed, "documents").indexes[0]).toEqual({
      ...declared,
      columns: ["vec"],
    });
    const command = getMigrationDriver(pgEstateDriver("reporting"));
    const context = ddlContext("live", {
      currentSchema: snapshotWith(declared),
    });
    const moved = { ...declared, columns: ["vec"] };
    expect(command.compileStatements(rename, context)).toEqual([
      'ALTER TABLE "reporting"."documents" RENAME COLUMN "embedding_vec" TO "vec"',
      `COMMENT ON INDEX "reporting"."documents_raw" IS '${RAW_INDEX_MARKER_PREFIX}${rawIndexMarker(moved)}'`,
    ]);
    // A program that drops it anyway leaves the marker to that drop.
    expect(
      command.compileStatements(rename, {
        ...context,
        followingOperations: [
          {
            type: "dropIndex",
            tableName: "documents",
            indexName: "documents_raw",
          },
        ],
      })
    ).toHaveLength(1);
    expect(
      sqlite3MigrationDriver.compileStatements(rename, context).slice(1)
    ).toEqual([
      'DROP INDEX "documents_raw"',
      `CREATE INDEX "documents_raw" ON "documents" USING hnsw ("vec" vector_cosine_ops) /* ${RAW_INDEX_MARKER_PREFIX}${rawIndexMarker(moved)} */`,
    ]);
  });

  it("is never a low-lock build", () => {
    const create: DiffOperation = {
      type: "createIndex",
      tableName: "documents",
      index: declared,
    };
    expect(lowLockSteps([create]).size).toBe(0);
  });
});

describe("each driver renders a raw index with its marker", () => {
  const index = rawIndex(
    "documents_raw",
    "CREATE INDEX {name} ON {table} ({title}, lower({embedding}))",
    ["title_col", "embedding_vec"]
  );
  const create: DiffOperation = {
    type: "createIndex",
    tableName: "documents",
    index,
  };
  const marker = rawIndexMarker(index);

  it("writes the marker as canonical JSON of the columns, the name and the hash", () => {
    expect(marker).toBe(
      `{"columns":["title_col","embedding_vec"],"name":"documents_raw","raw":"${index.raw!.hash}"}`
    );
    expect(readRawIndexMarker(marker, "documents_raw")).toEqual({
      name: "documents_raw",
      columns: ["title_col", "embedding_vec"],
      unique: false,
      raw: { hash: index.raw!.hash },
    });
    // An index renamed by hand keeps a marker naming its old name.
    expect(readRawIndexMarker(marker, "renamed")).toBeUndefined();
    expect(readRawIndexMarker("{not json", "documents_raw")).toBeUndefined();
    expect(
      readRawIndexMarker(
        `{"columns":[],"name":"documents_raw","raw":"${index.raw!.hash}"}`,
        "documents_raw"
      )
    ).toBeUndefined();
  });

  it("PostgreSQL: the text on the bound schema, then the marker as its comment", () => {
    const command = getMigrationDriver(pgEstateDriver("reporting"));
    expect(command.compileStatements(create, ddlContext("live"))).toEqual([
      'CREATE INDEX "documents_raw" ON "reporting"."documents" ("title_col", lower("embedding_vec"))',
      `COMMENT ON INDEX "reporting"."documents_raw" IS '${RAW_INDEX_MARKER_PREFIX}${marker}'`,
    ]);
  });

  it("MySQL: the marker as the index's own comment, on a line of its own", () => {
    expect(
      mysqlMigrationDriver.compileStatements(
        {
          ...create,
          index: rawIndex(
            "documents_raw",
            "CREATE INDEX {name} ON {table} ({title}) -- by hand",
            ["title_col"]
          ),
        },
        ddlContext("artifact")
      )
    ).toEqual([
      `CREATE INDEX \`documents_raw\` ON \`documents\` (\`title_col\`) -- by hand\nCOMMENT '${RAW_INDEX_MARKER_PREFIX}${rawIndexMarker(rawIndex("documents_raw", "CREATE INDEX {name} ON {table} ({title}) -- by hand", ["title_col"]))}'`,
    ]);
  });

  it("MySQL: a marker over its 1024-byte index comment refuses before any statement", () => {
    const long = "c".repeat(64);
    const columns = Array.from({ length: 16 }, (_, i) => `${long}${i}`);
    const template = `CREATE INDEX {name} ON {table} (${columns.map((_, i) => `{f${i}}`).join(", ")})`;
    expect(() =>
      mysqlMigrationDriver.compileStatements(
        { ...create, index: rawIndex("documents_raw", template, columns) },
        ddlContext("artifact")
      )
    ).toThrow(COMMENT_TOO_LONG);
  });

  it("SQLite: a trailing comment in which no name can close the comment", () => {
    const slashed = rawIndex(
      "a*/b",
      "CREATE INDEX {name} ON {table} ({title})",
      ["title_col"]
    );
    const [statement] = sqlite3MigrationDriver.compileStatements(
      { ...create, index: slashed },
      ddlContext("artifact")
    );
    expect(statement).toBe(
      `CREATE INDEX "a*/b" ON "documents" ("title_col") /* ${RAW_INDEX_MARKER_PREFIX}${rawIndexMarker(slashed).replaceAll("/", "\\/")} */`
    );
    const comment = statement!.slice(
      statement!.indexOf(` /* ${RAW_INDEX_MARKER_PREFIX}`)
    );
    expect(comment.indexOf("*/")).toBe(comment.length - 2);
  });

  it("SurrealDB: a new key holding a field a raw index names refuses", () => {
    const table: TableDef = {
      name: "documents",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "slug", type: "string", nullable: false },
      ],
      primaryKey: { columns: ["id"] },
      indexes: [
        rawIndex(
          "documents_slug_raw",
          "DEFINE INDEX {name} ON {table} FIELDS {slug}",
          ["slug"]
        ),
      ],
      foreignKeys: [],
      uniqueConstraints: [],
    };
    const newKey: DiffOperation = {
      type: "addPrimaryKey",
      tableName: "documents",
      primaryKey: { columns: ["slug"] },
    };
    expect(() =>
      surrealMigrationDriver.compileStatements(
        newKey,
        ddlContext("live", { currentSchema: { tables: [table] } })
      )
    ).toThrow(KEY_HOLDS_RAW_FIELD);
  });

  it("SurrealDB: the marker as the index's comment, inline", () => {
    const table: TableDef = {
      name: "documents",
      columns: [
        { name: "embedding_vec", type: "array<float>", nullable: false },
      ],
      primaryKey: { columns: ["id"] },
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [],
    };
    const surreal = rawIndex("documents_raw", SURREAL_HNSW, ["embedding_vec"]);
    expect(
      surrealMigrationDriver.compileStatements(
        { type: "createIndex", tableName: "documents", index: surreal },
        ddlContext("live", { currentSchema: { tables: [table] } })
      )
    ).toEqual([
      `DEFINE INDEX documents_raw ON documents FIELDS embedding_vec HNSW DIMENSION 3 DIST COSINE\nCOMMENT ${JSON.stringify(rawIndexMarker(surreal))};`,
    ]);
    // The key is not filtered out of a raw index's columns.
    const keyed = surrealMigrationDriver.finalizeTable({
      ...table,
      indexes: [rawIndex("documents_key_raw", SURREAL_HNSW, ["id"])],
    });
    expect(keyed.indexes).toHaveLength(1);
  });

  it("refuses what VibORM writes itself, as a word of the statement only", () => {
    const refused = (
      driver: {
        compileStatements: typeof mysqlMigrationDriver.compileStatements;
      },
      template: string,
      message: RegExp,
      context = ddlContext("artifact")
    ) =>
      expect(() =>
        driver.compileStatements(
          {
            ...create,
            index: rawIndex("documents_raw", template, ["title_col"]),
          },
          context
        )
      ).toThrow(message);
    const pg = getMigrationDriver(pgEstateDriver("reporting"));
    refused(
      pg,
      "CREATE INDEX CONCURRENTLY {name} ON {table} ({title})",
      CONCURRENT_HEADER
    );
    refused(
      pg,
      "CREATE INDEX {name} ON {table} ({title}) WITH (fillfactor = 70) CONCURRENTLY",
      SAYS_CONCURRENTLY,
      ddlContext("live")
    );
    refused(
      mysqlMigrationDriver,
      "CREATE INDEX {name} ON {table} ({title}) COMMENT 'mine'",
      SAYS_COMMENT
    );
    refused(
      mysqlMigrationDriver,
      "CREATE INDEX {name} ON {table} ({title}) ALGORITHM=INPLACE",
      SAYS_ALGORITHM
    );
    refused(
      mysqlMigrationDriver,
      "CREATE INDEX {name} ON {table} ({title}) LOCK=NONE",
      SAYS_LOCK
    );
    refused(
      sqlite3MigrationDriver,
      "CREATE INDEX {name} ON {table} ({title});",
      ONE_STATEMENT
    );
    refused(
      sqlite3MigrationDriver,
      "CREATE INDEX {name} ON {table} ({title}); DROP TABLE x",
      ONE_STATEMENT
    );
    // A `;` the text hides behind a comment still ends the statement before
    // the marker, and an open comment would swallow it.
    for (const driver of [
      sqlite3MigrationDriver,
      mysqlMigrationDriver,
      getMigrationDriver(pgEstateDriver("reporting")),
    ]) {
      refused(
        driver,
        "CREATE INDEX {name} ON {table} ({title}); -- note",
        ONE_STATEMENT
      );
      refused(
        driver,
        "CREATE INDEX {name} ON {table} ({title}) /* open",
        ONE_STATEMENT
      );
    }
    // A quoted identifier or a string spelling a refused word is no refusal.
    expect(() =>
      mysqlMigrationDriver.compileStatements(
        {
          ...create,
          index: rawIndex(
            "documents_raw",
            "CREATE INDEX {name} ON {table} ({title}, `lock`)",
            ["title_col"]
          ),
        },
        ddlContext("artifact")
      )
    ).not.toThrow();
    expect(() =>
      surrealMigrationDriver.compileStatements(
        {
          ...create,
          index: rawIndex(
            "documents_raw",
            "DEFINE INDEX {name} ON {table} FIELDS {title} COMMENT 'mine'",
            ["title_col"]
          ),
        },
        ddlContext("artifact")
      )
    ).toThrow(SAYS_COMMENT);
  });

  it("refuses to render an introspected raw index the schema does not declare", () => {
    expect(() =>
      sqlite3MigrationDriver.compileStatements(
        {
          ...create,
          index: { ...index, raw: { hash: index.raw!.hash } },
        },
        ddlContext("artifact")
      )
    ).toThrow(UNDECLARED);
  });
});

describe("MySQL keys nothing for a raw index", () => {
  it("keeps a TEXT column as written and refuses no unindexable type for it", () => {
    const finalized = mysqlMigrationDriver.finalizeTable({
      name: "documents",
      columns: [
        { name: "id", type: "VARCHAR(191)", nullable: false },
        { name: "body", type: "TEXT", nullable: false },
      ],
      primaryKey: { columns: ["id"] },
      indexes: [
        rawIndex(
          "documents_body_prefix",
          "CREATE INDEX {name} ON {table} ({body}(32))",
          ["body"]
        ),
      ],
      foreignKeys: [],
      uniqueConstraints: [],
    });
    expect(finalized.columns.find(({ name }) => name === "body")?.type).toBe(
      "TEXT"
    );
  });
});

describe("a stepwise PostgreSQL run proves the marker, not only the index", () => {
  it("probes the comment statement with the marker and the create with the index", () => {
    const command = getMigrationDriver(pgEstateDriver("reporting"));
    const index = rawIndex("documents_raw", PG_HNSW, ["embedding_vec"]);
    const create: DiffOperation = {
      type: "createIndex",
      tableName: "documents",
      index,
    };
    const [built, commented] = command.compileStatements(
      create,
      ddlContext("live")
    );
    expect(probeForGeneratedStatement(command, create, built!)?.post.id).toBe(
      "index:exists:documents_raw"
    );
    const probes = probeForGeneratedStatement(command, create, commented!);
    expect(probes?.pre).toMatchObject({
      id: "index-marker:absent:documents_raw",
      equals: false,
    });
    expect(probes?.post).toMatchObject({
      id: "index-marker:present:documents_raw",
      equals: true,
      parameters: [
        { kind: "string", value: "reporting" },
        { kind: "string", value: "documents_raw" },
        {
          kind: "string",
          value: `${RAW_INDEX_MARKER_PREFIX}${rawIndexMarker(index)}`,
        },
      ],
    });
    expect(probes?.post.sql).toContain("obj_description");
    // The same statement inside a created table is proven the same way.
    const table = tableOf(snapshotWith(index), "documents");
    const statements = command.compileStatements(
      { type: "createTable", table },
      ddlContext("live")
    );
    const comment = statements.find((statement) =>
      statement.startsWith("COMMENT ON INDEX")
    )!;
    expect(
      probeForGeneratedStatement(
        command,
        { type: "createTable", table },
        comment
      )?.post.id
    ).toBe("index-marker:present:documents_raw");
  });
});
