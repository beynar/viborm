import { sql } from "@sql";
import { type DatabaseAdapter, postgresAdapter } from "@src/adapters";
import type { DriverResultParser } from "@src/drivers/driver-instrumentation";

const adapter: DatabaseAdapter = postgresAdapter;
const identifierSql = adapter.identifiers.escape("user");
const parameterSql = adapter.literals.value("Ada");
const customInsert: DatabaseAdapter["mutations"]["insert"] = (
  table,
  columns,
  source,
  prefix
) => postgresAdapter.mutations.insert(table, columns, source, prefix);
const insertFromSelect = customInsert(
  sql`"memberships"`,
  ["ownerId", "targetId"],
  { select: sql`SELECT ${"owner"}, ${"target"}` }
);

/**
 * THE RELATION PARSER HOOK, both halves.
 *
 * The declared relation TYPE argument is gone from this contract — a PUBLIC
 * break, and a deliberate one (ruling D17). No built-in parser ever read it,
 * and keeping it would have preserved a topology concept the language no longer
 * has: cardinality and target domain are facts of the resolved edge, not of a
 * name an adapter is handed. Both hooks now take the value and the continuation
 * and nothing else, and the driver's continuation takes only the value.
 */
const adapterParseRelation: DatabaseAdapter["result"]["parseRelation"] = (
  value,
  next
) => (typeof value === "string" ? next(JSON.parse(value)) : next());

const driverParseRelation: NonNullable<DriverResultParser["parseRelation"]> = (
  value,
  next
) => next(value);

/** A third parameter has nowhere to come from. */
// @ts-expect-error - parseRelation takes (value, next), never a relation kind
const _relationKindIsNotAParameter: DatabaseAdapter["result"]["parseRelation"] =
  (value: unknown, _kind: string, next: (value?: unknown) => unknown) =>
    next(value);

export {
  adapterParseRelation,
  driverParseRelation,
  identifierSql,
  insertFromSelect,
  parameterSql,
};
