/**
 * `identifiers.table()` publishes an OPTIONAL alias.
 *
 * The one-argument form is the whole reason the signature widened: a call site
 * that splices its own alias must still reach the persistent-table renderer.
 * No legacy two-argument-only overload survives, so a trusted custom adapter
 * has to accept the call the engine now makes.
 */

import type { Sql } from "@sql";
import { type DatabaseAdapter, postgresAdapter } from "@src/adapters";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type TableRenderer = DatabaseAdapter["identifiers"]["table"];

type _aliasIsOptional = Expect<
  Equal<TableRenderer, (tableName: string, alias?: string) => Sql>
>;
type _oneArgumentIsCallable = Expect<
  Equal<Parameters<TableRenderer>["length"], 1 | 2>
>;

// Both forms are public and both return `Sql`.
const _qualifiedOnly: Sql = postgresAdapter.identifiers.table("users");
const _qualifiedWithAlias: Sql = postgresAdapter.identifiers.table(
  "users",
  "t0"
);
// @ts-expect-error - the object name is still required
const _tableNameIsRequired = postgresAdapter.identifiers.table();
// @ts-expect-error - there is no third component to name
const _noThirdComponent = postgresAdapter.identifiers.table("s", "users", "t0");

/**
 * A trusted custom adapter, per the plan's custom-adapter obligation: its
 * renderer must serve the one-argument call the engine makes and supply the
 * namespace itself.
 */
const customIdentifiers: DatabaseAdapter["identifiers"] = {
  escape: (name: string): Sql => postgresAdapter.identifiers.escape(name),
  column: (alias: string, field: string): Sql =>
    postgresAdapter.identifiers.column(alias, field),
  table: (tableName: string, alias?: string): Sql =>
    postgresAdapter.identifiers.table(tableName, alias),
  aliased: (expression: Sql, alias: string): Sql =>
    postgresAdapter.identifiers.aliased(expression, alias),
};

const _customServesBothForms: Sql[] = [
  customIdentifiers.table("users"),
  customIdentifiers.table("users", "t0"),
];
