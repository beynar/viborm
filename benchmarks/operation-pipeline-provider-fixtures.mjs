/** Provider adapters for the cross-provider operation-pipeline workload. */

import { Buffer } from "node:buffer";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { PROVIDERS } from "./operation-pipeline-catalog.mjs";

function providerRows(count) {
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      Object.freeze({
        id: `provider_record_${String(index).padStart(5, "0")}`,
        label: `Provider record ${String(index).padStart(5, "0")}`,
        score: index,
        enabled: index % 2 === 0,
        big: 9_000_000_000n + BigInt(index),
        amount: `${index + 1}.125`,
        recordedAt: new Date(
          Date.UTC(2026, 0, 1, 0, 0, index % 60)
        ),
        status: index % 2 === 0 ? "active" : "inactive",
        metadata: Object.freeze({ index, group: index % 5 }),
        optionalText: index % 2 === 0 ? null : `optional_${index}`,
        payload: new Uint8Array([index % 251, (index + 1) % 251]),
      })
    )
  );
}


function builtModule(targetDirectory, fileName) {
  return import(pathToFileURL(join(targetDirectory, "dist", fileName)).href);
}

export function providerSkipReason(providerName) {
  const provider = PROVIDERS[providerName];
  if (!provider) return `Unknown provider ${providerName}.`;
  if (provider.unavailableReason) return provider.unavailableReason;
  if (provider.runtime === "bun" && !process.versions.bun) {
    return "This provider leg must run under Bun.";
  }
  if (provider.runtime === "workerd") {
    return "This provider leg must run in the Workers substrate.";
  }
  if (provider.environment && !process.env[provider.environment]) {
    return `Set ${provider.environment} to a disposable benchmark database.`;
  }
  return undefined;
}

function responseByteCounter(source) {
  let bytes = 0;
  return {
    source,
    addBytes(count) {
      bytes += count;
    },
    read() {
      return bytes;
    },
    reset() {
      bytes = 0;
    },
  };
}

function wideRow(fieldCount) {
  return Object.fromEntries(
    Array.from({ length: fieldCount }, (_, index) => [
      `field${String(index + 1).padStart(3, "0")}`,
      `wide_${String(index + 1).padStart(3, "0")}`,
    ])
  );
}

function relationValue(providerName, value) {
  return ["planetscale", "mysql2", "sqlite3", "libsql", "bun-sqlite"].includes(
    providerName
  )
    ? JSON.stringify(value)
    : value;
}

function fakeResultRows(providerName, rows, providerShape) {
  if (providerShape.kind === "identity") {
    return rows.map((row) => ({ id: row.id }));
  }
  if (providerShape.kind === "mixed-scalar") {
    return rows.map((row) => ({
      ...row,
      big: row.big.toString(),
      recordedAt:
        providerName === "neon-http"
          ? row.recordedAt
          : row.recordedAt.toISOString(),
      metadata: row.metadata,
    }));
  }
  if (providerShape.kind === "wide-scalar") {
    return [{ id: "wide_1", ...wideRow(providerShape.fields) }];
  }
  if (providerShape.kind === "fixed-nested") {
    return rows.map((row, index) => ({
      id: `parent_${index}`,
      children: relationValue(providerName, [
        { id: `child_${index}`, label: row.label },
      ]),
    }));
  }
  if (providerShape.kind === "variant-nested") {
    return rows.map((row, index) => ({
      id: `comment_${index}`,
      subject: relationValue(providerName, {
        __viborm_state: "linked",
        type: index % 2 === 0 ? "article" : "clip",
        data: {
          id: `${index % 2 === 0 ? "article" : "clip"}_${index}`,
          title: row.label,
        },
      }),
    }));
  }
  if (providerShape.kind === "count") {
    return [{ "0viborm_aggregate:count": providerShape.sourceRows }];
  }
  if (providerShape.kind === "aggregate") {
    const count = providerShape.sourceRows;
    return [
      {
        "0viborm_aggregate:count": count,
        "0viborm_aggregate:sum": {
          score: (count * (count - 1)) / 2,
        },
      },
    ];
  }
  if (providerShape.kind === "relation-count") {
    return rows.map((_, index) => ({
      id: `parent_${index}`,
      "0viborm_relation_counts": relationValue(providerName, { children: 1 }),
    }));
  }
  if (providerShape.kind === "returning") {
    return [{ id: "returning_1", score: 1 }];
  }
  throw new Error(`No deterministic result exists for ${providerShape.kind}`);
}

function planetScaleClient(providerName, rows, providerShape) {
  const client = {
    transaction: true,
    connection() {
      return client;
    },
    async execute(sql) {
      const command = String(sql).trimStart().split(/\s+/u)[0]?.toUpperCase();
      if (["BEGIN", "COMMIT", "ROLLBACK", "SET"].includes(command)) {
        return { rows: [], rowsAffected: 0, insertId: "0" };
      }
      const payload = {
        rows:
          command === "UPDATE"
            ? []
            : fakeResultRows(providerName, rows, providerShape),
        rowsAffected: command === "UPDATE" ? 1 : 0,
        insertId: "0",
      };
      return payload;
    },
  };
  return client;
}

function neonFetch(counter, rows, providerShape) {
  const selected = fakeResultRows("neon-http", rows, providerShape);
  const fieldEntries = Object.entries(selected[0] ?? {});
  const dataTypeId = (value) => {
    if (value instanceof Date) return 1114;
    if (typeof value === "boolean") return 16;
    if (typeof value === "number") return 23;
    if (typeof value === "bigint") return 20;
    if (value instanceof Uint8Array) return 17;
    if (value !== null && typeof value === "object") return 3802;
    return 25;
  };
  const wireValue = (value, type) => {
    if (value === null) return null;
    if (type === 16) return value ? "t" : "f";
    if (type === 17) {
      return `\\x${Buffer.from(value).toString("hex")}`;
    }
    if (type === 3802) return JSON.stringify(value);
    if (value instanceof Date) return value.toISOString();
    return String(value);
  };
  const fields = fieldEntries.map(([name, value]) => ({
    name,
    dataTypeID: dataTypeId(value),
  }));
  const body = JSON.stringify({
    fields,
    command: providerShape.kind === "returning" ? "UPDATE" : "SELECT",
    rowCount: selected.length,
    rows: selected.map((row) =>
      fields.map((field) =>
        wireValue(row[field.name], field.dataTypeID)
      )
    ),
  });
  const bodyBytes = Buffer.byteLength(body);
  return async () => {
    counter.addBytes(bodyBytes);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function createDriver(
  providerName,
  targetDirectory,
  rows,
  providerShape
) {
  if (providerName === "sqlite3") {
    const { SQLite3Driver } = await builtModule(targetDirectory, "sqlite3.mjs");
    return new SQLite3Driver({ dataDir: ":memory:" });
  }
  if (providerName === "bun-sqlite") {
    const { BunSQLiteDriver } = await builtModule(
      targetDirectory,
      "bun-sqlite.mjs"
    );
    return new BunSQLiteDriver({ dataDir: ":memory:" });
  }
  if (providerName === "libsql") {
    const { LibSQLDriver } = await builtModule(targetDirectory, "libsql.mjs");
    return new LibSQLDriver({ databaseUrl: "file::memory:" });
  }
  if (providerName === "pglite") {
    const { PGliteDriver } = await builtModule(targetDirectory, "pglite.mjs");
    return new PGliteDriver();
  }
  if (providerName === "pg") {
    const { PgDriver } = await builtModule(targetDirectory, "pg.mjs");
    return new PgDriver({ databaseUrl: process.env.VIBORM_BENCH_PG_URL });
  }
  if (providerName === "postgres.js") {
    const { PostgresDriver } = await builtModule(
      targetDirectory,
      "postgres.mjs"
    );
    return new PostgresDriver({
      databaseUrl: process.env.VIBORM_BENCH_POSTGRES_JS_URL,
    });
  }
  if (providerName === "bun-sql") {
    const { BunSQLDriver } = await builtModule(targetDirectory, "bun-sql.mjs");
    return new BunSQLDriver({
      databaseUrl: process.env.VIBORM_BENCH_BUN_SQL_URL,
    });
  }
  if (providerName === "mysql2") {
    const { MySQL2Driver } = await builtModule(targetDirectory, "mysql2.mjs");
    return new MySQL2Driver({
      databaseUrl: process.env.VIBORM_BENCH_MYSQL2_URL,
    });
  }
  if (providerName === "planetscale") {
    const { PlanetScaleDriver } = await builtModule(
      targetDirectory,
      "planetscale.mjs"
    );
    return new PlanetScaleDriver({
      client: planetScaleClient(providerName, rows, providerShape),
    });
  }
  if (providerName === "neon-http") {
    const { NeonHTTPDriver } = await builtModule(
      targetDirectory,
      "neon-http.mjs"
    );
    const counter = responseByteCounter("deterministic-fetch-body");
    const fetchFixture = neonFetch(counter, rows, providerShape);
    counter.activate = () => {
      globalThis.fetch = fetchFixture;
    };
    counter.activate();
    return {
      driver: new NeonHTTPDriver({
        databaseUrl: "postgresql://bench:bench@fixture.invalid/bench",
      }),
      responseBytes: counter,
    };
  }
  throw new Error(`Provider fixture ${providerName} is not executable`);
}

function dialect(providerName) {
  if (providerName === "mysql2" || providerName === "planetscale") {
    return "mysql";
  }
  if (
    ["pg", "postgres.js", "pglite", "bun-sql", "neon-http"].includes(
      providerName
    )
  ) {
    return "postgresql";
  }
  return "sqlite";
}

function placeholders(providerName, count) {
  if (dialect(providerName) === "postgresql") {
    return Array.from({ length: count }, (_, index) => `$${index + 1}`);
  }
  return Array.from({ length: count }, () => "?");
}

function quote(providerName, identifier) {
  return dialect(providerName) === "mysql"
    ? `\`${identifier}\``
    : `"${identifier}"`;
}

function tableNames(providerShape) {
  const suffix = `${providerShape.kind.replaceAll("-", "_")}_${
    providerShape.rows ?? providerShape.sourceRows ?? 1
  }`;
  return {
    record: `viborm_bench_provider_record_${suffix}`,
    wide: `viborm_bench_provider_wide_${suffix}`,
    parent: `viborm_bench_provider_parent_${suffix}`,
    child: `viborm_bench_provider_child_${suffix}`,
    article: `viborm_bench_provider_article_${suffix}`,
    clip: `viborm_bench_provider_clip_${suffix}`,
    comment: `viborm_bench_provider_comment_${suffix}`,
  };
}

function buildSchema(s, providerShape, tables) {
  if (providerShape.kind === "wide-scalar") {
    const wide = s
      .model({
        id: s.string().id(),
        ...Object.fromEntries(
          Array.from({ length: providerShape.fields }, (_, index) => [
            `field${String(index + 1).padStart(3, "0")}`,
            s.string(),
          ])
        ),
      })
      .map(tables.wide);
    return { schema: { wide } };
  }
  if (
    providerShape.kind === "fixed-nested" ||
    providerShape.kind === "relation-count"
  ) {
    const parent = s
      .model({
        id: s.string().id(),
        children: s.toMany(() => child),
      })
      .map(tables.parent);
    const child = s
      .model({
        id: s.string().id(),
        label: s.string(),
        parentId: s.string(),
        parent: s
          .toOne(() => parent)
          .fields("parentId")
          .references("id"),
      })
      .map(tables.child);
    return { schema: { parent, child } };
  }
  if (providerShape.kind === "variant-nested") {
    const article = s
      .model({ id: s.string().id(), title: s.string() })
      .map(tables.article);
    const clip = s
      .model({ id: s.string().id(), title: s.string() })
      .map(tables.clip);
    const comment = s
      .model({
        id: s.string().id(),
        subject: s
          .toOne(
            { article: () => article, clip: () => clip },
            {
              values: {
                article: "bench.provider.article.v1",
                clip: "bench.provider.clip.v1",
              },
            }
          )
          .optional(),
      })
      .map(tables.comment);
    return { schema: { article, clip, comment } };
  }
  const record = s
    .model({
      id: s.string().id(),
      label: s.string(),
      score: s.int(),
      enabled: s.boolean(),
      big: s.bigInt(),
      amount: s.decimal(),
      recordedAt: s.dateTime(),
      status: s.enum(["active", "inactive"]),
      metadata: s.json(),
      optionalText: s.string().nullable(),
      payload: s.blob(),
    })
    .map(tables.record);
  return { schema: { record } };
}

async function insertRows(
  providerName,
  driver,
  tableName,
  columns,
  valuesByRow
) {
  const maximumRows = Math.max(
    1,
    Math.floor(
      (driver.maxBindParametersPerStatement ?? 999) / columns.length
    )
  );
  for (let start = 0; start < valuesByRow.length; start += maximumRows) {
    const chunk = valuesByRow.slice(start, start + maximumRows);
    const values = chunk.flat();
    const markers = placeholders(providerName, values.length);
    const tuples = chunk.map((_, rowIndex) => {
      const offset = rowIndex * columns.length;
      return `(${markers
        .slice(offset, offset + columns.length)
        .join(", ")})`;
    });
    await driver._executeRaw(
      `INSERT INTO ${quote(providerName, tableName)} (${columns
        .map((column) => quote(providerName, column))
        .join(", ")}) VALUES ${tuples.join(", ")}`,
      values
    );
  }
}

function scalarColumnTypes(providerName) {
  const providerDialect = dialect(providerName);
  if (providerDialect === "postgresql") {
    return {
      id: "TEXT",
      bool: "BOOLEAN",
      big: "BIGINT",
      decimal: "NUMERIC",
      date: "TIMESTAMP",
      json: "JSONB",
      blob: "BYTEA",
    };
  }
  if (providerDialect === "mysql") {
    return {
      id: "VARCHAR(64)",
      bool: "BOOLEAN",
      big: "BIGINT",
      decimal: "DECIMAL(30, 6)",
      date: "DATETIME(3)",
      json: "JSON",
      blob: "BLOB",
    };
  }
  return {
    id: "TEXT",
    bool: "INTEGER",
    big: "INTEGER",
    decimal: "TEXT",
    date: "TEXT",
    json: "TEXT",
    blob: "BLOB",
  };
}

async function setupProviderRows(
  providerName,
  driver,
  providerShape,
  tables,
  rows
) {
  if (providerName === "planetscale" || providerName === "neon-http") return;
  const types = scalarColumnTypes(providerName);
  if (providerShape.kind === "wide-scalar") {
    const fields = Array.from(
      { length: providerShape.fields },
      (_, index) => `field${String(index + 1).padStart(3, "0")}`
    );
    await driver._executeRaw(
      `CREATE TABLE IF NOT EXISTS ${quote(providerName, tables.wide)} (${quote(providerName, "id")} ${types.id} PRIMARY KEY, ${fields
        .map((field) => `${quote(providerName, field)} TEXT NOT NULL`)
        .join(", ")})`
    );
    const existing = await driver._executeRaw(
      `SELECT COUNT(*) AS ${quote(providerName, "count")} FROM ${quote(providerName, tables.wide)}`
    );
    if (Number(existing.rows[0]?.count ?? 0) === 0) {
      await insertRows(providerName, driver, tables.wide, ["id", ...fields], [
        ["wide_1", ...Object.values(wideRow(providerShape.fields))],
      ]);
    }
    return;
  }
  if (
    providerShape.kind === "fixed-nested" ||
    providerShape.kind === "relation-count"
  ) {
    await driver._executeRaw(
      `CREATE TABLE IF NOT EXISTS ${quote(providerName, tables.parent)} (${quote(providerName, "id")} ${types.id} PRIMARY KEY)`
    );
    await driver._executeRaw(
      `CREATE TABLE IF NOT EXISTS ${quote(providerName, tables.child)} (${quote(providerName, "id")} ${types.id} PRIMARY KEY, ${quote(providerName, "label")} TEXT NOT NULL, ${quote(providerName, "parentId")} ${types.id} NOT NULL)`
    );
    const existing = await driver._executeRaw(
      `SELECT COUNT(*) AS ${quote(providerName, "count")} FROM ${quote(providerName, tables.parent)}`
    );
    if (Number(existing.rows[0]?.count ?? 0) === 0) {
      await insertRows(
        providerName,
        driver,
        tables.parent,
        ["id"],
        rows.map((_, index) => [`parent_${index}`])
      );
      await insertRows(
        providerName,
        driver,
        tables.child,
        ["id", "label", "parentId"],
        rows.map((row, index) => [
          `child_${index}`,
          row.label,
          `parent_${index}`,
        ])
      );
    }
    return;
  }
  if (providerShape.kind === "variant-nested") {
    for (const tableName of [tables.article, tables.clip]) {
      await driver._executeRaw(
        `CREATE TABLE IF NOT EXISTS ${quote(providerName, tableName)} (${quote(providerName, "id")} ${types.id} PRIMARY KEY, ${quote(providerName, "title")} TEXT NOT NULL)`
      );
    }
    await driver._executeRaw(
      `CREATE TABLE IF NOT EXISTS ${quote(providerName, tables.comment)} (${quote(providerName, "id")} ${types.id} PRIMARY KEY, ${quote(providerName, "subject_type")} TEXT, ${quote(providerName, "subject_id")} ${types.id})`
    );
    const existing = await driver._executeRaw(
      `SELECT COUNT(*) AS ${quote(providerName, "count")} FROM ${quote(providerName, tables.comment)}`
    );
    if (Number(existing.rows[0]?.count ?? 0) === 0) {
      await insertRows(
        providerName,
        driver,
        tables.article,
        ["id", "title"],
        rows
          .map((row, index) => [row, index])
          .filter(([, index]) => index % 2 === 0)
          .map(([row, index]) => [`article_${index}`, row.label])
      );
      await insertRows(
        providerName,
        driver,
        tables.clip,
        ["id", "title"],
        rows
          .map((row, index) => [row, index])
          .filter(([, index]) => index % 2 === 1)
          .map(([row, index]) => [`clip_${index}`, row.label])
      );
      await insertRows(
        providerName,
        driver,
        tables.comment,
        ["id", "subject_type", "subject_id"],
        rows.map((_, index) => [
          `comment_${index}`,
          index % 2 === 0
            ? "bench.provider.article.v1"
            : "bench.provider.clip.v1",
          `${index % 2 === 0 ? "article" : "clip"}_${index}`,
        ])
      );
    }
    return;
  }

  await driver._executeRaw(
    `CREATE TABLE IF NOT EXISTS ${quote(providerName, tables.record)} (${quote(providerName, "id")} ${types.id} PRIMARY KEY, ${quote(providerName, "label")} TEXT NOT NULL, ${quote(providerName, "score")} INTEGER NOT NULL, ${quote(providerName, "enabled")} ${types.bool} NOT NULL, ${quote(providerName, "big")} ${types.big} NOT NULL, ${quote(providerName, "amount")} ${types.decimal} NOT NULL, ${quote(providerName, "recordedAt")} ${types.date} NOT NULL, ${quote(providerName, "status")} TEXT NOT NULL, ${quote(providerName, "metadata")} ${types.json} NOT NULL, ${quote(providerName, "optionalText")} TEXT, ${quote(providerName, "payload")} ${types.blob} NOT NULL)`
  );
  const existing = await driver._executeRaw(
    `SELECT COUNT(*) AS ${quote(providerName, "count")} FROM ${quote(providerName, tables.record)}`
  );
  if (Number(existing.rows[0]?.count ?? 0) === 0) {
    await insertRows(
      providerName,
      driver,
      tables.record,
      [
        "id",
        "label",
        "score",
        "enabled",
        "big",
        "amount",
        "recordedAt",
        "status",
        "metadata",
        "optionalText",
        "payload",
      ],
      rows.map((row) => [
        row.id,
        row.label,
        row.score,
        row.enabled,
        row.big,
        row.amount,
        row.recordedAt.toISOString(),
        row.status,
        JSON.stringify(row.metadata),
        row.optionalText,
        row.payload,
      ])
    );
  }
}

export async function createProviderFixture(
  providerName,
  targetDirectory,
  providerShape
) {
  const skipReason = providerSkipReason(providerName);
  if (skipReason) return { skipReason };
  const rowCount =
    providerShape.rows ?? providerShape.sourceRows ?? 1;
  const rows = providerRows(rowCount);
  const tables = tableNames(providerShape);
  const [{ createClient }, { s }] = await Promise.all([
    builtModule(targetDirectory, "index.mjs"),
    builtModule(targetDirectory, "schema.mjs"),
  ]);
  const { schema } = buildSchema(s, providerShape, tables);
  const created = await createDriver(
    providerName,
    targetDirectory,
    rows,
    providerShape
  );
  const driver = created.driver ?? created;
  const responseBytes = created.responseBytes;
  const client = createClient({ schema, driver });
  await setupProviderRows(providerName, driver, providerShape, tables, rows);
  return { client, driver, responseBytes, tables };
}

export { providerRows };
