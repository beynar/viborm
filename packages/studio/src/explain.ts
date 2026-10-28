/**
 * A read's plan, asked of the database through the client's own raw SQL: the statement the client ran, with the
 * values it bound, under PostgreSQL's `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, MySQL's `EXPLAIN ANALYZE` or
 * SQLite's `EXPLAIN QUERY PLAN`; or, asked to estimate only, the plan without running it. Then what the database
 * holds for the tables it reads (their columns, their indexes and what kind, how many rows), and the advice the
 * plan calls for. `ANALYZE` runs the statement once more, under a time limit: the query page runs reads only.
 */

import type { StudioStatement } from "./api";
import {
  mysqlPlan,
  type PlanNode,
  type PlanTree,
  postgresPlan,
  sqlitePlan,
  walk,
} from "./plan";
import {
  adviseOn,
  aliasesOf,
  type Dialect,
  type PlanAdvice,
  schemasOf,
  type TableIndex,
} from "./plan-advice";
import type { StudioModel } from "./schema";

export interface StudioPlan extends PlanTree {
  readonly dialect: Dialect;
  readonly advice: readonly PlanAdvice[];
  readonly indexes: Readonly<Record<string, readonly TableIndex[]>>;
  readonly columns: Readonly<Record<string, readonly string[]>>;
  readonly tableRows: Readonly<Record<string, number>>;
  /** What the database answered, as it answered it: to export. */
  readonly raw: string;
}

export interface StudioExplained {
  readonly sql: string;
  readonly plan?: StudioPlan;
  readonly error?: string;
}

/** How long `ANALYZE` may run the statement again before the database stops it. */
export const ANALYZE_LIMIT_MS = 30_000;

type Row = Record<string, unknown>;
type Raw = (sql: string, ...params: unknown[]) => Promise<Row[]>;
const rowsOf = (answer: unknown): Row[] =>
  Array.isArray(answer)
    ? answer.filter(
        (row): row is Row => typeof row === "object" && row !== null
      )
    : [];
const SELECT = /^\s*SELECT\b/i;

/** A method of the client, called on it; undefined when it has none. */
function methodOf(
  target: object,
  name: string
): ((...args: unknown[]) => Promise<unknown>) | undefined {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function") return undefined;
  return async (...args) => await method.apply(target, args);
}
const rawOf = (client: object): Raw => {
  const query = methodOf(client, "$queryRawUnsafe");
  return async (sql, ...params) => rowsOf(await query?.(sql, ...params));
};

/** The dialect a driver says it speaks, as a plan reads it. */
export function dialectOf(name: string): Dialect | undefined {
  const lower = name.toLowerCase();
  if (lower.includes("postgres")) return "postgresql";
  if (lower.includes("mysql") || lower.includes("maria")) return "mysql";
  if (
    lower.includes("sqlite") ||
    lower.includes("libsql") ||
    lower.includes("d1")
  )
    return "sqlite";
  return undefined;
}

async function planOf(
  client: object,
  dialect: Dialect,
  statement: StudioStatement,
  analyze: boolean
): Promise<{ tree: PlanTree; raw: string }> {
  const sql = statement.sql ?? "";
  const params = statement.params ?? [];
  if (dialect === "postgresql") {
    const explain = `EXPLAIN (${analyze ? "ANALYZE, BUFFERS, FORMAT JSON" : "FORMAT JSON"}) ${sql}`;
    const transaction = methodOf(client, "$transaction");
    // Run again under a time limit that holds for this statement only: SET LOCAL ends with its transaction.
    const rows =
      analyze && transaction
        ? rowsOf(
            await transaction(async (tx: object) => {
              await rawOf(tx)(
                `SET LOCAL statement_timeout = ${ANALYZE_LIMIT_MS}`
              );
              return rawOf(tx)(explain, ...params);
            })
          )
        : await rawOf(client)(explain, ...params);
    const answer = rows[0] ? Object.values(rows[0])[0] : undefined;
    const parsed: unknown =
      typeof answer === "string" ? JSON.parse(answer) : answer;
    return {
      tree: postgresPlan(parsed),
      raw: JSON.stringify(parsed, null, 2),
    };
  }
  if (dialect === "mysql") {
    // MySQL stops a SELECT that outlives its hint.
    const limited = sql.replace(
      SELECT,
      `SELECT /*+ MAX_EXECUTION_TIME(${ANALYZE_LIMIT_MS}) */`
    );
    const [row] = await rawOf(client)(
      analyze ? `EXPLAIN ANALYZE ${limited}` : `EXPLAIN FORMAT=TREE ${sql}`,
      ...params
    );
    const text = String(row ? Object.values(row)[0] : "");
    return { tree: mysqlPlan(text), raw: text };
  }
  const rows = await rawOf(client)(`EXPLAIN QUERY PLAN ${sql}`, ...params);
  const tree = sqlitePlan(
    rows.map((row) => ({ id: row.id, parent: row.parent, detail: row.detail }))
  );
  // SQLite says no time of its own: the statement's, as the client measured it.
  return {
    tree:
      statement.duration === undefined
        ? tree
        : { ...tree, executionTime: statement.duration },
    raw: rows
      .map(
        (row) =>
          `${String(row.id)}\t${String(row.parent)}\t${String(row.detail)}`
      )
      .join("\n"),
  };
}

const sqliteName = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Catalog = Pick<StudioPlan, "indexes" | "columns" | "tableRows">;
const strings = (value: unknown) =>
  Array.isArray(value) ? value.map(String) : [];

async function postgresCatalog(
  raw: Raw,
  tables: readonly string[],
  schemas: Readonly<Record<string, string>>
): Promise<Catalog> {
  const indexes: Record<string, TableIndex[]> = {};
  const columns: Record<string, string[]> = {};
  const tableRows: Record<string, number> = {};
  // The relation the statement named: its schema when it names one, else the search path's.
  const qualified = tables.map((table) =>
    schemas[table] ? `"${schemas[table]}"."${table}"` : `"${table}"`
  );
  const relations =
    "(SELECT to_regclass(name) FROM unnest($1::text[]) AS name)";
  for (const row of await raw(
    `SELECT t.relname AS "table", i.relname AS "name", ix.indisunique AS "unique", am.amname AS "method",
         ix.indpred IS NOT NULL AS "partial", pg_get_indexdef(ix.indexrelid) AS "definition",
         ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
           LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
           WHERE k.n <= ix.indnkeyatts ORDER BY k.n) AS "columns",
         ARRAY(SELECT (option & 1) = 1 FROM unnest(ix.indoption) WITH ORDINALITY AS k(option, n) ORDER BY k.n) AS "descending"
       FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       WHERE t.oid IN ${relations}`,
    qualified
  )) {
    const table = String(row.table);
    indexes[table] = [
      ...(indexes[table] ?? []),
      {
        name: String(row.name),
        unique: row.unique === true,
        ordered: row.method === "btree",
        partial: row.partial === true,
        definition: String(row.definition),
        columns: strings(row.columns),
        descending: Array.isArray(row.descending)
          ? row.descending.map((value) => value === true)
          : [],
      },
    ];
  }
  for (const row of await raw(
    `SELECT c.relname AS "table", c.reltuples::bigint AS "rows",
         ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum) AS "columns"
       FROM pg_class c WHERE c.oid IN ${relations}`,
    qualified
  )) {
    const table = String(row.table);
    tableRows[table] = Math.max(0, Number(row.rows));
    columns[table] = strings(row.columns);
  }
  return { indexes, columns, tableRows };
}

async function mysqlCatalog(
  raw: Raw,
  tables: readonly string[],
  schemas: Readonly<Record<string, string>>
): Promise<Catalog> {
  const indexes: Record<string, TableIndex[]> = {};
  const columns: Record<string, string[]> = {};
  const tableRows: Record<string, number> = {};
  const target = tables
    .map(() => "(TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?)")
    .join(" OR ");
  const parameters = tables.flatMap((table) => [schemas[table] ?? null, table]);
  const grouped = new Map<
    string,
    {
      table: string;
      index: TableIndex & { columns: string[]; descending: boolean[] };
    }
  >();
  for (const row of await raw(
    `SELECT TABLE_NAME AS t, INDEX_NAME AS n, NON_UNIQUE AS nu, COLUMN_NAME AS c, INDEX_TYPE AS k, COLLATION AS d FROM information_schema.STATISTICS WHERE (${target}) ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    ...parameters
  )) {
    const key = `${String(row.t)}.${String(row.n)}`;
    const entry = grouped.get(key) ?? {
      table: String(row.t),
      index: {
        name: String(row.n),
        unique: Number(row.nu) === 0,
        ordered: String(row.k) === "BTREE",
        partial: false,
        columns: [],
        descending: [],
      },
    };
    entry.index.columns.push(String(row.c));
    entry.index.descending.push(row.d === "D");
    grouped.set(key, entry);
  }
  for (const { table, index } of grouped.values())
    indexes[table] = [...(indexes[table] ?? []), index];
  for (const row of await raw(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE (${target}) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    ...parameters
  )) {
    const table = String(row.t);
    columns[table] = [...(columns[table] ?? []), String(row.c)];
  }
  for (const row of await raw(
    `SELECT TABLE_NAME AS t, TABLE_ROWS AS r FROM information_schema.TABLES WHERE (${target})`,
    ...parameters
  )) {
    tableRows[String(row.t)] = Number(row.r);
  }
  return { indexes, columns, tableRows };
}

async function sqliteCatalog(
  raw: Raw,
  tables: readonly string[]
): Promise<Catalog> {
  const indexes: Record<string, TableIndex[]> = {};
  const columns: Record<string, string[]> = {};
  const tableRows: Record<string, number> = {};
  for (const table of tables) {
    const info = await raw(`PRAGMA table_info(${sqliteName(table)})`);
    columns[table] = info.map((column) => String(column.name));
    // The primary key, which index_list leaves out when it is the rowid.
    const key = info
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => String(column.name));
    const held: TableIndex[] =
      key.length === 1 &&
      info.some(
        (column) =>
          Number(column.pk) === 1 &&
          String(column.type).toUpperCase() === "INTEGER"
      )
        ? [
            {
              name: "PRIMARY KEY",
              unique: true,
              ordered: true,
              partial: false,
              columns: key,
              descending: [false],
            },
          ]
        : [];
    for (const index of await raw(`PRAGMA index_list(${sqliteName(table)})`)) {
      const name = String(index.name);
      const keys = (
        await raw(`PRAGMA index_xinfo(${sqliteName(name)})`)
      ).filter((column) => Number(column.key) === 1);
      held.push({
        name,
        unique: Number(index.unique) === 1,
        ordered: true,
        partial: Number(index.partial) === 1,
        columns: keys.map((column) => String(column.name)),
        descending: keys.map((column) => Number(column.desc) === 1),
      });
    }
    indexes[table] = held;
    const [counted] = await raw(
      `SELECT count(*) AS "rows" FROM ${sqliteName(table)}`
    );
    tableRows[table] = Number(counted?.rows ?? 0);
  }
  return { indexes, columns, tableRows };
}

/** Each statement the read ran, explained; one the database refuses to explain says why. */
export async function explainStatements(
  client: object,
  dialect: Dialect,
  statements: readonly StudioStatement[],
  models: readonly StudioModel[],
  analyze = true
): Promise<StudioExplained[]> {
  const raw = rawOf(client);
  const explained: StudioExplained[] = [];
  for (const statement of statements) {
    const sql = statement.sql ?? "";
    try {
      const found = await planOf(client, dialect, statement, analyze);
      // MySQL and SQLite name a table by the alias the statement gave it: the table, read from the statement.
      const aliases = aliasesOf(sql);
      const named = (node: PlanNode): PlanNode => {
        const relation =
          node.relation ?? (node.alias ? aliases[node.alias] : undefined);
        return {
          ...node,
          ...(relation ? { relation } : {}),
          // A scan of a subquery's rows (a derived table) reads what the subquery made, not a table.
          fullScan: node.fullScan && relation !== undefined,
          children: node.children.map(named),
        };
      };
      const tree = { ...found.tree, root: named(found.tree.root) };
      const tables = [
        ...new Set([
          ...[...walk(tree.root)].flatMap((node) =>
            node.relation ? [node.relation] : []
          ),
          ...Object.values(aliases),
        ]),
      ];
      const catalog =
        tables.length === 0
          ? { indexes: {}, columns: {}, tableRows: {} }
          : dialect === "postgresql"
            ? await postgresCatalog(raw, tables, schemasOf(sql))
            : dialect === "mysql"
              ? await mysqlCatalog(raw, tables, schemasOf(sql))
              : await sqliteCatalog(raw, tables);
      explained.push({
        sql,
        plan: {
          ...tree,
          dialect,
          ...catalog,
          raw: found.raw,
          advice: adviseOn(tree, {
            dialect,
            sql,
            params: statement.params,
            models,
            ...catalog,
          }),
        },
      });
    } catch (error) {
      explained.push({
        sql,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return explained;
}
