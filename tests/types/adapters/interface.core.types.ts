import { sql } from "@sql";
import { type DatabaseAdapter, postgresAdapter } from "@src/adapters";

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

export { identifierSql, insertFromSelect, parameterSql };
