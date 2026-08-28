/**
 * Migration Estate Target
 *
 * ONE resolver derives the durable estate target from a concrete execution
 * driver, and ONE pair of readers reaches the two runtime facts installed on
 * the adapter and the driver (`adapter.namespace`,
 * `driver.migrationNamespaceAttestation`). Every migration verb, the registry
 * binding, and the live-capability admission owner reach those facts through
 * here, so no command re-decides dialect, namespace or attestation for itself.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import type { MigrationTarget } from "./types";
import { normalizeDialect } from "./utils";

/**
 * The live namespace the adapter is bound to, or undefined when the adapter
 * exposes none.
 *
 * Module-private on purpose: `resolveMigrationEstate` is the ONE reader of this
 * fact in the whole migration layer, so no second caller can take a second look
 * at a value a custom adapter may answer differently each time.
 *
 * The property is read reflectively for one reason: it is an OPTIONAL runtime
 * fact whose declaration lives on the adapter contract, and reading it as
 * untyped data keeps the migration layer from claiming any adapter it is handed
 * — including a caller-supplied custom adapter — has already declared it. A
 * present-but-non-string value is the same as absent: unproven.
 *
 * So is the EMPTY STRING. §1.3 settles it for the shipped path — an empty
 * candidate "is not passed to identifier validation" and preserves unbound mode
 * — and `normalizeNamespace` (`src/schema/identifier.ts`) rejects `""` against
 * the identifier grammar, so no stock constructor can produce one. A custom
 * adapter can, and this reader is the seam that admits it: an empty name proves
 * no schema and no database, and reading it as proven would qualify every live
 * statement with an EMPTY quoted segment (`""."users"`).
 */
function readAdapterNamespace(driver: AnyDriver): string | undefined {
  const value: unknown = Reflect.get(driver.adapter, "namespace");
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The driver's immutable non-redirecting migration-namespace attestation, or
 * undefined when the driver makes no such claim.
 *
 * Only the exact string `"non-redirecting"` is an attestation. There is no
 * provider-name fallback and no inference from class, URL, handshake or
 * server version: a driver that does not carry this exact value is unproven,
 * which is what keeps PlanetScale (and any MySQL2 connection reaching Vitess
 * through the ordinary MySQL protocol) out of effectful migration work.
 */
export function readNamespaceAttestation(
  driver: AnyDriver
): "non-redirecting" | undefined {
  const value: unknown = Reflect.get(driver, "migrationNamespaceAttestation");
  return value === "non-redirecting" ? value : undefined;
}

/**
 * Reads one catalog statement with its bound values.
 *
 * The same shape the dialect base class's `proveNamespaceExists` takes, spelled
 * here so the migration layer's shared owners can name a catalog read without
 * importing a dialect module for the type.
 */
export type CatalogRead = <T>(
  sql: string,
  params?: unknown[]
) => Promise<{ rows: T[] }>;

/**
 * A dialect whose CONFIGURED namespace and the server's own spelling of it can
 * differ, and which therefore answers one command-local spelling (§5.2).
 *
 * MySQL is the only such dialect: `lower_case_table_names` can make a
 * differently cased configured value name the same physical database, so
 * catalog resolution accepts a single case-folded candidate — and every later
 * statement of that command has to speak the spelling the SERVER answered with,
 * not the one the configuration carried. `information_schema` rows carry the
 * server's spelling, and on a case-sensitive server so does `USE`.
 *
 * PostgreSQL has no such projection (its `pg_namespace` proof is byte-exact)
 * and SQLite has no namespace at all, so both answer nothing here and their
 * commands keep the exact bound driver they started with.
 *
 * The capability is STRUCTURAL, exactly like the pinned-session hook: a dialect
 * declares it by implementing it. This interface is what the implementation is
 * checked against; {@link readsCommandNamespace} is what a shared owner asks.
 */
export interface CommandNamespaceResolver {
  resolveCommandNamespace(read: CatalogRead): Promise<string>;
}

/**
 * Whether this migration driver resolves a command-local namespace spelling.
 *
 * Read as an optional runtime capability rather than declared on the dialect
 * base class, for the same reason `adapter.namespace` is read reflectively
 * above: it is a fact only one dialect has, and a base-class declaration would
 * make every dialect — including a caller-supplied one — answer for it.
 */
export function readsCommandNamespace<T extends object>(
  migrationDriver: T
): migrationDriver is T & CommandNamespaceResolver {
  return (
    typeof Reflect.get(migrationDriver, "resolveCommandNamespace") ===
    "function"
  );
}

/**
 * The two estate facts a bound migration driver carries, derived together.
 *
 * `target` is the DURABLE estate generated artifacts claim;
 * `namespace` is the LIVE execution destination. They coincide for PostgreSQL
 * and deliberately differ for MySQL, whose artifacts are database-relative, so
 * both have to be published — but both come from ONE read of the adapter.
 */
export interface MigrationEstate {
  readonly target: MigrationTarget;
  readonly namespace: string | undefined;
}

/**
 * Derives the one frozen estate target and the one live namespace for a
 * concrete execution driver, from a SINGLE read of `adapter.namespace`.
 *
 * The single read is load-bearing, not tidiness. A custom adapter may expose
 * `namespace` as an accessor; two reads could answer two different strings, and
 * the durable target would then name one estate while live DDL rendered
 * another. Reading once and publishing both facts from that one value makes the
 * disagreement structurally impossible (plan §14).
 *
 * The dialect goes through `normalizeDialect` here and nowhere else in the
 * migration layer's target decisions, so a driver cannot resolve to two targets
 * by being read raw on one path and normalized on another.
 *
 * A PostgreSQL driver whose adapter exposes no namespace is UNPROVEN and
 * refused. It must not silently acquire the `"public"` default: generated
 * PostgreSQL SQL contains the schema, so a defaulted target would write a
 * durable claim nothing established.
 */
export function resolveMigrationEstate(driver: AnyDriver): MigrationEstate {
  const dialect = normalizeDialect(driver.dialect);
  const namespace = readAdapterNamespace(driver);

  if (dialect === "postgresql") {
    if (namespace === undefined) {
      throw new MigrationError(
        `The PostgreSQL driver "${driver.driverName}" exposes no adapter namespace, so its migration estate has no proven schema. ` +
          'Generated PostgreSQL migration SQL is schema-qualified, so the estate cannot fall back to "public": construct the driver with an explicit `namespace`, or supply an adapter that declares one.',
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { driver: driver.driverName, dialect } }
      );
    }
    return { target: Object.freeze({ dialect, namespace }), namespace };
  }

  // MySQL and SQLite estates are namespace-free BY DESIGN. MySQL artifacts are
  // database-relative so one history deploys to several database names; SQLite
  // has no namespace concept at all. The live MySQL destination rides beside
  // the target on the bound view, never inside it.
  return { target: Object.freeze({ dialect }), namespace };
}

/**
 * Human-readable estate description for refusal messages and safe metadata.
 *
 * The live namespace is a SECOND argument because the two facts are separate
 * for MySQL: its durable target is namespace-free by design (§3.1), so the
 * database a command actually touches rides beside it on the bound view. A
 * caller that has it passes it; a caller describing a stored estate target —
 * which carries no database name and must not appear to — does not.
 *
 * Naming it matters wherever the description is what a person consents to: the
 * CLI's `--force-reset` confirmation used to read "This will DROP ALL TABLES in
 * mysql", which identifies nothing on the one dialect whose estate target is
 * namespace-free (DECISIONS N6: the confirmation "must name the target
 * namespace").
 */
export function formatMigrationTarget(
  target: MigrationTarget,
  namespace?: string
): string {
  if (target.dialect === "postgresql") {
    return `${target.dialect} schema "${target.namespace}"`;
  }
  return namespace === undefined
    ? target.dialect
    : `${target.dialect} database "${namespace}"`;
}

/**
 * A stored estate is bound to one durable target. PostgreSQL artifacts are
 * schema-qualified, so `alpha` cannot generate or apply as `beta`. MySQL and
 * SQLite compare dialect only.
 */
export function assertEstateTargetMatches(
  stored: MigrationTarget,
  live: MigrationTarget
): void {
  if (stored.dialect !== live.dialect) {
    throw new MigrationError(
      "Estate target dialect does not match this client",
      VibORMErrorCode.MIGRATION_DIALECT_MISMATCH
    );
  }
  if (
    stored.dialect === "postgresql" &&
    live.dialect === "postgresql" &&
    stored.namespace !== live.namespace
  ) {
    throw new MigrationError(
      "Estate target namespace does not match this client",
      VibORMErrorCode.MIGRATION_DIALECT_MISMATCH
    );
  }
}
