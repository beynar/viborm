// Catalog metadata and relation names used to describe a query plan.
export type Dialect = "postgresql" | "mysql" | "sqlite";

export interface TableIndex {
  readonly name: string;
  readonly columns: readonly string[];
  /** Key directions, in the same positions as columns. Unknown directions cannot prove an order. */
  readonly descending?: readonly boolean[];
  readonly unique: boolean;
  /** A b-tree, which serves equalities, ranges and order; a hash, a GIN or a full-text index serves less. */
  readonly ordered: boolean;
  /** It holds only the rows its predicate keeps. */
  readonly partial: boolean;
  /** The statement that builds it, when the database says it. */
  readonly definition?: string;
}

const KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "case",
  "when",
  "then",
  "else",
  "end",
  "null",
  "true",
  "false",
  "select",
  "where",
  "on",
  "as",
  "escape",
  "in",
  "is",
  "like",
  "any",
]);
const TABLE_NAME = '(?:"(?:""|[^"])*"|`(?:``|[^`])*`|\\w+)';
const ALIAS = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(?:(${TABLE_NAME})\\.)?(${TABLE_NAME})\\s+(?:AS\\s+)?(${TABLE_NAME})`,
  "gi"
);
const identifierOf = (name: string) =>
  name.startsWith('"')
    ? name.slice(1, -1).replaceAll('""', '"')
    : name.startsWith("`")
      ? name.slice(1, -1).replaceAll("``", "`")
      : name;
/** The tables a statement reads, by the alias it gives them (`FROM "public"."orders" AS "q0"`). */
export function aliasesOf(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, , table = "", alias = ""] of sql.matchAll(ALIAS)) {
    if (!KEYWORDS.has(alias.toLowerCase()))
      out[identifierOf(alias)] = identifierOf(table);
  }
  return out;
}
/** The schema a statement names for each table it reads (`"public"."orders"`), when it names one. */
export function schemasOf(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, schema, table = ""] of sql.matchAll(ALIAS)) {
    if (schema) out[identifierOf(table)] = identifierOf(schema);
  }
  return out;
}
