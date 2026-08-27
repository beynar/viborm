/**
 * Public migration estate types.
 *
 * `MigrationTarget` and the version-3 `MigrationJournal` are exported because
 * the public storage driver and journal accessors name them. The internal
 * context and its options type are not exported at all.
 */

import type {
  MigrationEntry,
  MigrationJournal,
  MigrationTarget,
} from "@src/migrations";

// The migration context is internal: exporting it would be a public route
// around the one estate gate and the one live-capability admission decision.
// Its options type is internal too — the concrete public command-option types
// inline their fields rather than extending it. Written as type queries so the
// absence survives import organization.
// @ts-expect-error - `MigrationContext` is not exported from viborm/migrations
export type _NoContext = import("@src/migrations").MigrationContext;
// @ts-expect-error - `MigrationContextOptions` is not exported either
export type _NoOptions = import("@src/migrations").MigrationContextOptions;

type Expect<Value extends true> = Value;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

// The target is a discriminated union with exactly three arms; PostgreSQL is
// the only one carrying a namespace, because it is the only dialect whose
// generated artifacts contain it.
type _postgresArm = Expect<
  Equal<
    Extract<MigrationTarget, { dialect: "postgresql" }>,
    { readonly dialect: "postgresql"; readonly namespace: string }
  >
>;
type _mysqlArm = Expect<
  Equal<
    Extract<MigrationTarget, { dialect: "mysql" }>,
    { readonly dialect: "mysql" }
  >
>;
type _sqliteArm = Expect<
  Equal<
    Extract<MigrationTarget, { dialect: "sqlite" }>,
    { readonly dialect: "sqlite" }
  >
>;

// The journal version is the literal "3": there is no legacy reader, so no
// other version is expressible.
type _journalVersion = Expect<Equal<MigrationJournal["version"], "3">>;
type _journalTarget = Expect<
  Equal<MigrationJournal["target"], MigrationTarget>
>;
type _journalEntries = Expect<
  Equal<MigrationJournal["entries"], readonly MigrationEntry[]>
>;

declare const entry: MigrationEntry;

export const postgresEstate: MigrationJournal = {
  version: "3",
  target: { dialect: "postgresql", namespace: "billing" },
  entries: [entry],
};

export const mysqlEstate: MigrationJournal = {
  version: "3",
  target: { dialect: "mysql" },
  entries: [],
};

// A version-2 journal is not a journal.
export const staleVersion: MigrationJournal = {
  // @ts-expect-error - version "2" is refused, not upgraded
  version: "2",
  target: { dialect: "sqlite" },
  entries: [],
};

// The retired top-level dialect is not an alias for the target.
export const aliasedEstate: MigrationJournal = {
  version: "3",
  target: { dialect: "sqlite" },
  // @ts-expect-error - a journal states its estate exactly once
  dialect: "sqlite",
  entries: [],
};

// A PostgreSQL estate cannot omit its schema.
export const schemalessPostgres: MigrationJournal = {
  version: "3",
  // @ts-expect-error - the PostgreSQL arm requires its namespace
  target: { dialect: "postgresql" },
  entries: [],
};

// A MySQL estate cannot carry one: portability is the contract.
export const namespacedMysql: MigrationJournal = {
  version: "3",
  // @ts-expect-error - the MySQL arm is exactly { dialect }
  target: { dialect: "mysql", namespace: "app_prod" },
  entries: [],
};

// A held journal's entries cannot be mutated in place.
declare const heldJournal: MigrationJournal;
// @ts-expect-error - entries are readonly
heldJournal.entries.push(entry);
// @ts-expect-error - the target is readonly
heldJournal.target = { dialect: "sqlite" };
