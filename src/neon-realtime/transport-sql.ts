import { READ_ORDINAL_RESULT_KEY } from "@query-engine/result-aliases";
import { type Sql, sql } from "@sql";
import {
  getAdapterInternals,
  installAdapterInternals,
} from "../adapters/adapter-internals";
import type { DatabaseAdapter } from "../adapters/database-adapter";

/*
 * Neon Realtime admits only immutable expressions, so it refuses
 * json_build_object, row_to_json and json_agg. A transport read builds the
 * same documents by concatenating JSON text: json_object(text[]) escapes one
 * string, and every other member is its own text (a number, a boolean, a
 * document), or `null`.
 */
const jsonString = (value: Sql): Sql =>
  sql`json_object(ARRAY['v', (${value})::text])->'v'`;
const token = (value: Sql): Sql => sql`COALESCE((${value})::text, 'null')`;
// The engine never builds an empty document here: each has a member.
const object = (pairs: [string, Sql][]): Sql =>
  sql.join(
    pairs.map(
      ([key, value]) =>
        sql`${`${JSON.stringify(key)}:`}::text || ${token(value)}`
    ),
    " || ',' || ",
    "('{' || ",
    " || '}')::json"
  );
const array = (items: Sql[]): Sql =>
  sql.join(items.map(token), " || ',' || ", "('[' || ", " || ']')::json");

/**
 * The PostgreSQL adapter's spelling for a Neon Realtime read: the same
 * statement with its JSON built from text and its pages ranked, because the
 * live result is a set of rows with no order of its own.
 */
export function postgresTransport(adapter: DatabaseAdapter): DatabaseAdapter {
  const carry: DatabaseAdapter["json"]["carry"] = (leaf, value) => {
    // A list travels as PostgreSQL's own array text (array_to_json is refused).
    if (leaf.list) return jsonString(value);
    switch (leaf.type) {
      // Their text is already JSON.
      case "int":
      case "boolean":
      case "json":
        return value;
      case "number":
        return sql`CASE WHEN (${value})::text IN ('NaN', 'Infinity', '-Infinity') THEN ${jsonString(value)} ELSE (${value})::text::json END`;
      case "blob":
        return jsonString(adapter.expressions.blobToHex(value));
      default:
        return jsonString(value);
    }
  };
  const row = (key: readonly Sql[]) => sql.join(key, ", ", "ROW(", ")");
  const node = adapter.identifiers.escape("0viborm_node");
  // A recursive carrier's root is 0, every other row 1 + the number of
  // reached keys below its own: an ordinal, never the key.
  const identity: DatabaseAdapter["json"]["identity"] = (key, root, nodes) =>
    array([
      key === root
        ? sql`0`
        : sql`CASE WHEN ${row(key)} = ${row(root)} THEN 0 ELSE 1 + (SELECT count(*) FROM (${nodes}) AS ${node} WHERE ROW(${node}.*) < ${row(key)}) END`,
    ]);
  const spelling: DatabaseAdapter = Object.create(adapter, {
    json: {
      value: {
        ...adapter.json,
        object,
        objectFromColumns: object,
        array,
        carry,
        identity,
        // Rows aggregated in their page's rank, else in their own text order.
        agg: (element: Sql, rankedPage?: string) =>
          sql`('[' || COALESCE(string_agg(${token(element)}, ',' ORDER BY ${rankedPage === undefined ? token(element) : adapter.identifiers.column(rankedPage, READ_ORDINAL_RESULT_KEY)}), '') || ']')::json`,
      },
    },
  });
  const internals = getAdapterInternals(adapter);
  installAdapterInternals(spelling, {
    ...internals,
    select: (parts) =>
      internals.select(
        parts.ranked && parts.orderBy
          ? {
              ...parts,
              columns: sql`${parts.columns}, ROW_NUMBER() OVER (ORDER BY ${parts.orderBy}) AS ${adapter.identifiers.escape(READ_ORDINAL_RESULT_KEY)}`,
              distinctColumnAliases: parts.distinctColumnAliases && [
                ...parts.distinctColumnAliases,
                READ_ORDINAL_RESULT_KEY,
              ],
            }
          : parts
      ),
  });
  return spelling;
}
