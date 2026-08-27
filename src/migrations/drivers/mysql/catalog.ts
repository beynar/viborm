/**
 * MySQL catalog targeting (plan §5.2).
 *
 * Every MySQL migration catalog read filters on ONE exact database, and this
 * module owns which database that is. It replaces `DATABASE()`, whose answer is
 * the connection's ambient default — a fact the ORM never configured and a
 * proxy or a pooled session can change under it.
 */

import { MigrationError, VibORMErrorCode } from "../../../errors";

/**
 * The configured database name, on the shared safe-metadata allowlist's own
 * `namespace` key (`src/errors/diagnostics.ts`). The message states which
 * database it is; this makes it readable programmatically too.
 */
const namespaceMeta = (namespace: string) => ({
  dialect: "mysql",
  namespace,
});

/**
 * The one existence proof. `SCHEMA_NAME` comes back so the caller can speak the
 * server's own spelling in later catalog filters.
 *
 * The comparison is case-insensitive because `lower_case_table_names` can make
 * a differently cased configured value name the same physical database; the
 * candidate set it produces is then resolved by the rules below, never guessed.
 */
const SCHEMATA_QUERY = `
SELECT SCHEMA_NAME
FROM information_schema.SCHEMATA
WHERE LOWER(SCHEMA_NAME) = LOWER(?)
ORDER BY SCHEMA_NAME
`;

/**
 * One catalog row, as UNTRUSTED transport data.
 *
 * `SCHEMA_NAME` is typed `unknown` on purpose. MySQL declares the column NOT
 * NULL, but the value reaching this module has crossed a driver: a
 * serverless/HTTP MySQL transport, or any custom `_executeRaw`, can answer with
 * `null` or a number. Declaring the server's own DDL here would be a claim this
 * module cannot make, so the narrowing below makes it instead.
 */
interface SchemataRow {
  SCHEMA_NAME: unknown;
}

/** Executes one catalog statement with its bound values. */
export type CatalogReader = <T>(
  sql: string,
  params?: unknown[]
) => Promise<{ rows: T[] }>;

/**
 * Proves the configured database exists and returns the catalog's own spelling
 * of it (§5.2).
 *
 * Three refusals, all before any snapshot, tracking or DDL effect:
 *
 * 1. no configured database — a MySQL estate is database-relative on purpose,
 *    so an unbound driver has nothing to read a catalog against. Every COMMAND
 *    that reaches here has already been refused by the shared live-capability
 *    admission owner (`src/migrations/admission.ts`), `introspect(client)`
 *    included. This arm's unique coverage is the UNBOUND REGISTERED SINGLETON,
 *    which the migration layer deliberately keeps usable by name for
 *    artifact-only work: `mysqlMigrationDriver.introspect(reader)` reaches this
 *    reader with no client, no context and therefore no admission owner in
 *    front of it. It is also what narrows the base class's optional
 *    `namespace?: string` to the `string` every filter below binds, without an
 *    assertion.
 * 2. no candidate row — a missing database is not an empty database, and
 *    publishing an empty inventory for one would plan a full rebuild against a
 *    database that does not exist.
 * 3. more than one case-only candidate and none byte-exact — the server would
 *    pick one by its own collation rules; choosing for it would silently bind
 *    the estate to a database the configuration never named.
 *
 * The returned spelling is command-local: it is a projection of the configured
 * target under this server's identity rules, it is never stored, and it
 * disappears with the pinned session that resolved it. Within that command it
 * is what EVERY statement naming the database renders from — the `USE`, the
 * catalog filters, the tracking table and the live DDL alike — because refusal
 * 3 has already established that only one database answers to the configured
 * name here, and the server accepts only its own spelling of it. Runtime ORM
 * SQL is outside this: it renders from the adapter's immutable configured
 * value, which nothing in this module projects.
 */
export async function resolveCatalogNamespace(
  executeRaw: CatalogReader,
  namespace: string | undefined
): Promise<string> {
  if (namespace === undefined) {
    throw new MigrationError(
      "This MySQL client's adapter declares no database, so there is no catalog to read. " +
        "MySQL migration artifacts are database-relative on purpose: supply the live destination explicitly, in the connection URL, or through the driver's database option.",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { meta: { dialect: "mysql", type: "unbound-database" } }
    );
  }

  const { rows } = await executeRaw<SchemataRow>(SCHEMATA_QUERY, [namespace]);
  // A present-but-non-string name is the same as absent: unproven. Keeping one
  // would publish it as "the resolved catalog spelling", bind it into all five
  // subsequent filters, match nothing, and report an ABSENT database as an
  // empty one — the single outcome refusal 2 exists to prevent. Dropping it
  // here leaves that refusal owning the outcome. (Same doctrine as
  // `src/migrations/target.ts`'s reader of `adapter.namespace`.)
  const candidates = rows
    .map((row) => row.SCHEMA_NAME)
    .filter((name): name is string => typeof name === "string");

  if (candidates.length === 0) {
    throw new MigrationError(
      `The MySQL database "${namespace}" does not exist or is not visible to this connection. ` +
        "VibORM never creates or drops a database: create it, or grant this user access to it, before running migration work against it.",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { meta: { ...namespaceMeta(namespace), type: "missing-database" } }
    );
  }

  const exact = candidates.find((candidate) => candidate === namespace);
  if (exact !== undefined) {
    return exact;
  }

  const [folded] = candidates;
  if (candidates.length === 1 && folded !== undefined) {
    return folded;
  }

  throw new MigrationError(
    `The MySQL database "${namespace}" matches ${candidates.length} existing databases that differ only by case (${candidates.join(", ")}). ` +
      "Configure the exact name this server reports so migration work cannot land in the wrong one.",
    VibORMErrorCode.MIGRATION_INVALID_STATE,
    {
      meta: {
        ...namespaceMeta(namespace),
        type: "ambiguous-database",
        candidates,
      },
    }
  );
}
