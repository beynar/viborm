import type { ReadTransport } from "@query-engine/raptor3/shared/query";
import type { Leaf } from "@query-engine/result/projection-shape";
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
const object = (pairs: [string, Sql][]): Sql =>
  pairs.length === 0
    ? sql.raw`'{}'::json`
    : sql.join(
        pairs.map(
          ([key, value]) =>
            sql`${`${JSON.stringify(key)}:`}::text || ${token(value)}`
        ),
        " || ',' || ",
        "('{' || ",
        " || '}')::json"
      );
const array = (items: Sql[]): Sql =>
  items.length === 0
    ? sql.raw`'[]'::json`
    : sql.join(items.map(token), " || ',' || ", "('[' || ", " || ']')::json");

function carry(adapter: DatabaseAdapter, leaf: Leaf, value: Sql): Sql {
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
}

const transports = new WeakMap<DatabaseAdapter, ReadTransport>();

/**
 * The PostgreSQL adapter's spelling for a Neon Realtime read: the same
 * statement with its JSON built from text and its pages ranked, because the
 * live result is a set of rows with no order of its own.
 */
export function postgresTransport(adapter: DatabaseAdapter): ReadTransport {
  let transport = transports.get(adapter);
  if (transport) return transport;
  const spelling: DatabaseAdapter = Object.create(adapter, {
    json: {
      value: { ...adapter.json, object, objectFromColumns: object, array },
    },
  });
  const internals = getAdapterInternals(adapter);
  installAdapterInternals(spelling, {
    ...internals,
    select: (parts) => {
      if (parts.ordinal === undefined || parts.orderBy === undefined)
        return internals.select(parts);
      const ordinal = adapter.identifiers.escape(parts.ordinal);
      return internals.select({
        ...parts,
        columns: sql`${parts.columns}, ROW_NUMBER() OVER (ORDER BY ${parts.orderBy}) AS ${ordinal}`,
        distinctColumnAliases: parts.distinctColumnAliases && [
          ...parts.distinctColumnAliases,
          parts.ordinal,
        ],
      });
    },
  });
  transport = {
    adapter: spelling,
    carry: (leaf, value) => carry(adapter, leaf, value),
    agg: (element, orderBy) =>
      sql`('[' || COALESCE(string_agg(${token(element)}, ',' ORDER BY ${orderBy ?? token(element)}), '') || ']')::json`,
  };
  transports.set(adapter, transport);
  return transport;
}
