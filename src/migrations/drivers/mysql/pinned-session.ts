/**
 * MySQL pinned migration session: lock identity, exact lock proofs, and the one
 * admitted target selection.
 *
 * This module is §13's single exempted `USE` producer. Every other `USE` in the
 * shipped source is a defect, and the architecture census enforces that by
 * naming THIS path — `PINNED_ARTIFACT_SESSION_OWNERS` — and nothing else. The
 * exemption is sound only because the statement below can be reached solely
 * from a pinned migration session, where the owner, lifetime, lock, target and
 * cleanup are one physical connection that is destroyed afterwards
 * (`MySQL2Driver.pinnedSession`).
 */

/**
 * MySQL's `GET_LOCK` name limit. Longer names are an error on 8.0+ and were
 * silently truncated before, which would have collapsed two databases onto one
 * lock name — the exact accident the hash below prevents.
 */
const LOCK_NAME_LIMIT = 64;

const LOCK_NAME_PREFIX = "viborm_migration_";

/** `_` + eight hex digits. */
const LOCK_HASH_LENGTH = 9;

const LOCK_NAME_BUDGET =
  LOCK_NAME_LIMIT - LOCK_NAME_PREFIX.length - LOCK_HASH_LENGTH;

/** Every character MySQL identifiers admit that a lock name should not carry. */
const NON_LOCK_NAME_CHARACTERS = /[^a-z0-9_]/g;

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;

/**
 * A deterministic 32-bit FNV-1a hash, as eight lowercase hex digits.
 *
 * The lock name has to survive truncation without two databases colliding, and
 * a cryptographic digest would be a runtime dependency for a value nothing
 * secret depends on: this is a collision-spreading suffix, not a secret.
 */
function hashLockScope(value: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    // FNV-1a IS an XOR followed by a multiply; any other spelling is a
    // different function.
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a is defined as XOR-then-multiply.
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  // The unsigned shift is how JavaScript reads a 32-bit result back as a
  // non-negative integer.
  // biome-ignore lint/suspicious/noBitwiseOperators: reads the 32-bit result as unsigned.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The lock name for one MySQL database.
 *
 * The scope is a CONSERVATIVE lowercase form of the configured database name.
 * Under `lower_case_table_names=1` two spellings of one database are the same
 * database, and letting them take different lock names would let two migration
 * commands run concurrently against it. Lowercasing may also serialize two
 * genuinely distinct case-sensitive databases that differ only in case; that is
 * the deliberate trade — a lock taken too widely is slow, a lock taken too
 * narrowly is wrong.
 *
 * The hash is computed over the WHOLE lowercased name, so two names sharing a
 * truncated prefix still get different locks.
 */
export function mysqlMigrationLockName(namespace: string): string {
  const scope = namespace.toLowerCase();
  const readable = scope
    .replace(NON_LOCK_NAME_CHARACTERS, "_")
    .slice(0, LOCK_NAME_BUDGET);
  return `${LOCK_NAME_PREFIX}${readable}_${hashLockScope(scope)}`;
}

/**
 * `GET_LOCK` with a stable `acquired` alias.
 *
 * The alias exists so the caller reads ONE known column instead of guessing at
 * a provider-shaped name built from the expression text.
 */
export function mysqlAcquireLockStatement(
  namespace: string,
  timeoutSeconds: number,
  quote: (value: string) => string
): string {
  return `SELECT GET_LOCK(${quote(mysqlMigrationLockName(namespace))}, ${timeoutSeconds}) AS acquired`;
}

/** `RELEASE_LOCK` with a stable `released` alias, for the same reason. */
export function mysqlReleaseLockStatement(
  namespace: string,
  quote: (value: string) => string
): string {
  return `SELECT RELEASE_LOCK(${quote(mysqlMigrationLockName(namespace))}) AS released`;
}

/**
 * The exact arms of a MySQL lock answer.
 *
 * `GET_LOCK` returns `1` when the lock was taken, `0` when the wait timed out,
 * and `NULL` on error. Treating all three as success is what made the previous
 * owner report a timeout as an acquired lock. `RELEASE_LOCK` answers the same
 * three ways about a release.
 *
 * The row itself is provider-shaped data: a value may arrive as a number, as a
 * decimal string (mysql2 returns `BIGINT`-family values as strings when
 * `supportBigNumbers` is on), or not at all. Exactly one row carrying a value
 * that parses to the number 1 is the proof; everything else — `0`, `NULL`, a
 * missing column, a missing row, more than one row, unparseable text — is not.
 */
export function mysqlLockAnswer(
  rows: readonly unknown[],
  column: "acquired" | "released"
): boolean {
  if (rows.length !== 1) {
    return false;
  }
  const row = rows[0];
  if (typeof row !== "object" || row === null) {
    return false;
  }
  const value: unknown = Reflect.get(row, column);
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "string") {
    return Number(value) === 1;
  }
  return false;
}

/**
 * Selects the migration target on the pinned session.
 *
 * Generated MySQL artifacts are database-RELATIVE by design (§13): one estate
 * deploys to `app_dev`, `app_test` and `app_prod`. Executing them verbatim on a
 * connection whose default database is something else lands the migration in
 * that other database, which is why the target is selected here — on the one
 * connection that runs the artifact, immediately before it, every time, never
 * once for the session. A manual artifact is allowed to issue its own `USE`
 * precisely because the next artifact re-selects the target anyway.
 *
 * The identifier is quoted with the migration driver's own quoter, and the name
 * itself passed the ASCII database-name grammar at driver construction.
 */
export function mysqlSelectTargetStatement(
  namespace: string,
  quoteIdentifier: (name: string) => string
): string {
  return `USE ${quoteIdentifier(namespace)}`;
}
