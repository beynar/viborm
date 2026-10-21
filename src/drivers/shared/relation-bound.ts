import type { DatabaseAdapter } from "@adapters/database-adapter";

/**
 * What a PostgreSQL server says of itself that bounds the relations one
 * statement may reference (`capabilities.relationsPerStatement`). PlanetScale's
 * Neki refuses a statement referencing more than 256; it names itself in the
 * `server_version` of every connection's startup (`18.6 (…) (Neki)`), which
 * node-postgres (through the `Client` a driver's own pool makes) and
 * postgres.js (`sql.parameters`) receive with no statement of their own, and
 * in its refusal (SQLSTATE 54000, "the statement references more than 256
 * relations, the limit for one statement").
 *
 * Each fills an ABSENT bound only, and only where bodies are shared: a
 * `relationsPerStatement` the caller stated always wins, and
 * `sharedRelationBodies: false` keeps every statement's form.
 */
const NEKI_RELATIONS = 256;

/**
 * The bound of a driver that reads its server's startup, `serverVersion`
 * (undefined until a connection opened): read as each statement is built, so
 * a statement built once a connection said what server it is, a transaction's
 * included, takes Neki's bound or none, and one built before (a driver's first
 * statement, an array transaction's members) takes Neki's, which costs only
 * plans elsewhere and only past 256 relations. Whether the bound is the
 * server's to say (no bound stated, bodies shared).
 */
export function boundByServer(
  adapter: DatabaseAdapter,
  serverVersion: () => unknown
): boolean {
  const capabilities = adapter.capabilities;
  if (
    capabilities.sharesRelationBodies !== true ||
    capabilities.relationsPerStatement !== undefined
  )
    return false;
  Object.defineProperty(capabilities, "relationsPerStatement", {
    configurable: true,
    enumerable: true,
    get() {
      const version = serverVersion();
      return version === undefined ||
        (typeof version === "string" && version.endsWith("(Neki)"))
        ? NEKI_RELATIONS
        : undefined;
    },
  });
  return true;
}

const RELATION_LIMIT = /references more than (\d+) relations/;

/**
 * The bound a refusal names, for a transport whose startup is unread (Bun SQL,
 * a supplied pool): the refused statement fails, the next ones fit. The code
 * is node-postgres's and postgres.js's `code`, Bun SQL's `errno`.
 */
export function learnRelationLimit(
  adapter: DatabaseAdapter,
  error: unknown
): void {
  const capabilities = adapter.capabilities;
  if (
    capabilities.sharesRelationBodies !== true ||
    capabilities.relationsPerStatement !== undefined ||
    typeof error !== "object" ||
    error === null
  )
    return;
  const refused =
    Reflect.get(error, "code") === "54000" ||
    Reflect.get(error, "errno") === "54000";
  const limit = RELATION_LIMIT.exec(String(Reflect.get(error, "message")));
  // A value, replacing a startup reader whose server did not say Neki.
  if (refused && limit !== null)
    Object.defineProperty(capabilities, "relationsPerStatement", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: Number(limit[1]),
    });
}
