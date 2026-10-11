/**
 * The driver-option boundary.
 *
 * Every public `namespace` and MySQL2's `migrationNamespaceAttestation` reach
 * VibORM through a caller-owned object, which may be a proxy or carry an
 * accessor. This module is the one place those properties are read: exactly
 * once, with a thrown accessor turned into the client-construction failure the
 * rest of the surface already raises. A second read is what would let a value
 * that passed validation be swapped for one that did not before it is used.
 *
 * Convenience wrappers read the caller's configuration here and hand their
 * driver a plain primitive; direct driver construction reads its own options
 * object here. Both entries reach this owner, and neither reaches a provider
 * before it answers.
 */

import type { DriverConfig } from "@client/client";
import { ClientInitializationError } from "@errors";
import { isError } from "../../errors/diagnostic-safety";
import type { MigrationSessionAttestation } from "../driver";

/**
 * MySQL2's transport assertion. It selects nothing: it states that qualified
 * `database.table` references and the pinned migration session's `USE` cannot
 * be remapped by VTGate schema-routing rules or an equivalent proxy.
 */
export type MigrationNamespaceAttestation = "non-redirecting";

const MIGRATION_NAMESPACE_ATTESTATION: MigrationNamespaceAttestation =
  "non-redirecting";

const MIGRATION_SESSION_ATTESTATION: MigrationSessionAttestation =
  "dedicated-session";

/**
 * The ONE normalizer for a thrown value that has to become an error's cause.
 *
 * A thrown `Error` stays the cause. Anything else becomes one deterministic
 * `Error` that keeps the thrown value as its own cause and never renders it —
 * rendering runs `toString` on a value chosen by whoever wrote the accessor.
 *
 * TOTAL, which a bare `thrown instanceof Error` is not: `instanceof` walks the
 * prototype chain through `[[GetPrototypeOf]]`, so a Proxy trap that throws
 * makes the TEST fail rather than the value. Every caller runs this inside the
 * `catch` that is building a typed error, so a throw here does not lose the
 * cause — it replaces the typed boundary with the trap's own error, and a
 * caller catching that boundary catches nothing. `isError` is the project's
 * existing guarded predicate; this is its one driver-side consumer, so the
 * option boundary, the pinned session's condemnation and the migration reset
 * all normalize the same way rather than each writing the test again.
 */
export function errorCause(thrown: unknown): Error {
  if (isError(thrown)) return thrown;
  return new Error("A non-Error value was thrown.", { cause: thrown });
}

/** Read one caller-owned option, exactly once, from the object itself. */
function readOptionOnce(source: object, key: string): unknown {
  try {
    // Own properties only. An inherited value is `Object.prototype` pollution
    // or a carrier's prototype, never a request this caller wrote down, and
    // honouring one forges the target and the transport assertion for every
    // driver constructed with no options at all. The presence test shares this
    // `try` so a hostile trap fails exactly like a hostile accessor, and it is
    // not a second read of the value: it consults the descriptor, not the
    // getter.
    if (!Object.hasOwn(source, key)) return undefined;
    return Reflect.get(source, key);
  } catch (thrown) {
    throw new ClientInitializationError(
      `The "${key}" option could not be read.`,
      { cause: errorCause(thrown) }
    );
  }
}

/**
 * The namespace this configuration asks for, or `undefined` when it asks for
 * none. An explicit `undefined` and an absent property are the same request.
 *
 * The value is narrowed here, not validated: the name's grammar, length limit,
 * and system names have one owner — `installAdapterNamespace` — which every
 * value returned here reaches through its adapter constructor. What the
 * `typeof` test uniquely buys is this function's declared `string | undefined`
 * return, which is what lets seven driver constructors hand the value to an
 * adapter without a cast; a value that cannot be narrowed also cannot be
 * dropped, because dropping it would silently turn `namespace: 5` into
 * PostgreSQL's `public` default.
 */
export function resolveNamespaceOption(source: object): string | undefined {
  const value = readOptionOnce(source, "namespace");
  if (value === undefined || typeof value === "string") return value;
  throw new ClientInitializationError(
    `The "namespace" option must be a string; received type "${typeof value}".`
  );
}

/**
 * The attestation this configuration makes under `key`, or `undefined` when it
 * makes none. Only the exact literal is admitted: a truthy value, a near-miss
 * spelling, or any other literal is a refusal, because this is a safety claim
 * and a mistyped claim must not read as an approximate one.
 */
function resolveAttestationOption<T extends string>(
  source: object,
  key: string,
  literal: T
): T | undefined {
  const value = readOptionOnce(source, key);
  if (value === undefined) return undefined;
  if (value === literal) return literal;
  throw new ClientInitializationError(
    `The "${key}" option admits only "${literal}".`
  );
}

/** MySQL2's `migrationNamespaceAttestation`, read once. */
export function resolveMigrationNamespaceAttestationOption(
  source: object
): MigrationNamespaceAttestation | undefined {
  return resolveAttestationOption(
    source,
    "migrationNamespaceAttestation",
    MIGRATION_NAMESPACE_ATTESTATION
  );
}

/**
 * A PostgreSQL driver's `migrationSessionAttestation`, read once: the caller's
 * claim that every connection is one server session for its whole life, which
 * lifts migration admission's pooler-host refusal at their risk.
 */
export function resolveMigrationSessionAttestationOption(
  source: object
): MigrationSessionAttestation | undefined {
  return resolveAttestationOption(
    source,
    "migrationSessionAttestation",
    MIGRATION_SESSION_ATTESTATION
  );
}

/**
 * Refuses a `databaseUrl` key that is present but empty or undefined — almost
 * always an unset environment variable — when nothing else in the
 * configuration names a target. The PostgreSQL clients would otherwise fall
 * back to libpq's defaults (the `PG*` environment, then localhost:5432) and
 * connect to a server nobody named. An absent key keeps those defaults.
 */
export function refuseEmptyDatabaseUrl(
  driver: string,
  source: { databaseUrl?: string },
  namesTarget: boolean
): void {
  if (
    namesTarget ||
    source.databaseUrl ||
    !Object.hasOwn(source, "databaseUrl")
  )
    return;
  throw new ClientInitializationError(
    `Driver "${driver}" was given an empty databaseUrl and no host; set the URL or name the host in options.`,
    { meta: { driver, operation: "configuration" } }
  );
}

/**
 * Install one driver fact as an own, non-writable, non-configurable property.
 *
 * `readonly` is erased at run time, and query rendering, migrations, cache
 * scope and instrumentation all re-read these members per operation: a
 * writable adapter reference is a swap vector between binding a cache scope and
 * executing the statement, and a writable attestation is a migration-admission
 * bypass. An absent attestation is installed too, so it cannot be added later.
 */
export function defineImmutableDriverFact(
  driver: object,
  key: string,
  value: unknown
): void {
  Object.defineProperty(driver, key, {
    value,
    writable: false,
    enumerable: true,
    configurable: false,
  });
}

/** The keys every convenience wrapper reads beside its driver's own. */
const CLIENT_CONFIG_KEYS: Readonly<Record<keyof DriverConfig, true>> = {
  schema: true,
  skipSchemaValidation: true,
};

/**
 * Refuse a key a driver's `createClient` does not read.
 *
 * The types refuse it already, but a JavaScript caller, or a configuration
 * written for another driver, reaches run time with it: `databaseUrl` on
 * viborm/sqlite3 used to open an in-memory database while its caller believed
 * a file was named. A present own key is refused whatever its value; an
 * inherited one is not a request (see `readOptionOnce`). Each driver types its
 * `accepted` record as `Record<keyof ItsOptions, true>`, so the run-time list
 * cannot drift from the options interface the types check.
 */
export function refuseUnknownDriverConfigKeys(
  config: object,
  driver: string,
  accepted: Readonly<Record<string, true>>,
  hints: Readonly<Record<string, string>> = {}
): void {
  for (const key of Object.keys(config)) {
    if (Object.hasOwn(CLIENT_CONFIG_KEYS, key) || Object.hasOwn(accepted, key))
      continue;
    const hint = Object.hasOwn(hints, key) ? hints[key] : undefined;
    const keys = [...Object.keys(CLIENT_CONFIG_KEYS), ...Object.keys(accepted)];
    throw new ClientInitializationError(
      `viborm/${driver} does not accept "${key}"; ${hint ?? `it accepts ${keys.join(", ")}`}.`,
      { meta: { driver, operation: "configuration" } }
    );
  }
}
