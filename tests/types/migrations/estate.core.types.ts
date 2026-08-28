/**
 * Public V1 estate types. The journal is gone.
 */

import type {
  MigrationEstateDescriptorV1,
  MigrationStateManifestV1,
  MigrationTarget,
  StateSelector,
} from "@src/migrations";

// @ts-expect-error - `MigrationContext` is not exported from viborm/migrations
export type _NoContext = import("@src/migrations").MigrationContext;
// @ts-expect-error - `MigrationJournal` is not exported
export type _NoJournal = import("@src/migrations").MigrationJournal;
// @ts-expect-error - `MigrationContextOptions` is not exported
export type _NoOptions = import("@src/migrations").MigrationContextOptions;
// @ts-expect-error - `MigrationEntry` is not exported
export type _NoEntry = import("@src/migrations").MigrationEntry;

type Expect<Value extends true> = Value;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

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

type _estateFormat = Expect<Equal<MigrationEstateDescriptorV1["format"], "1">>;
type _estateHashAlg = Expect<
  Equal<MigrationEstateDescriptorV1["hash"], "sha256">
>;
type _stateFormat = Expect<Equal<MigrationStateManifestV1["format"], "1">>;

type _selectorId = Expect<
  Equal<Extract<StateSelector, { id: string }>["id"], string>
>;
type _selectorPrefix = Expect<
  Equal<Extract<StateSelector, { prefix: string }>["prefix"], string>
>;
type _selectorName = Expect<
  Equal<Extract<StateSelector, { name: string }>["name"], string>
>;

export const postgresEstate: MigrationEstateDescriptorV1 = {
  format: "1",
  hash: "sha256",
  target: { dialect: "postgresql", namespace: "billing" },
};

export const mysqlEstate: MigrationEstateDescriptorV1 = {
  format: "1",
  hash: "sha256",
  target: { dialect: "mysql" },
};

export const staleFormat: MigrationEstateDescriptorV1 = {
  // @ts-expect-error - only format "1" is V1
  format: "3",
  hash: "sha256",
  target: { dialect: "sqlite" },
};

export const namespacedMysql: MigrationEstateDescriptorV1 = {
  format: "1",
  hash: "sha256",
  // @ts-expect-error - the MySQL arm is exactly { dialect }
  target: { dialect: "mysql", namespace: "app_prod" },
};

export const selectorByName: StateSelector = { name: "add-users" };
export const selectorByPrefix: StateSelector = { prefix: "a1b2c3d4" };
// @ts-expect-error - numeric indexes are not state selectors
export const selectorByIndex: StateSelector = { index: 0 };
