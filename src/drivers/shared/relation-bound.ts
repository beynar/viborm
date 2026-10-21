import type { DatabaseAdapter } from "@adapters/database-adapter";

/**
 * What a PostgreSQL server says of itself that bounds the relations one
 * statement may reference (`capabilities.relationsPerStatement`). PlanetScale's
 * Neki refuses a statement referencing more than 256; it names itself in the
 * `server_version` of every connection's startup (`18.6 (…) (Neki)`), which
 * node-postgres and postgres.js receive with no statement of their own, and in
 * its refusal (SQLSTATE 54000, "the statement references more than 256
 * relations, the limit for one statement").
 *
 * Either fills an ABSENT bound only, and only where bodies are shared: a
 * `relationsPerStatement` the caller stated always wins, and
 * `sharedRelationBodies: false` keeps every statement's form.
 */
function bound(adapter: DatabaseAdapter, relations: number): void {
  const capabilities = adapter.capabilities;
  if (
    capabilities.sharesRelationBodies === true &&
    capabilities.relationsPerStatement === undefined
  )
    capabilities.relationsPerStatement = relations;
}

/** Neki's bound, where a connection's startup `server_version` names it. */
export function learnServerVersion(
  adapter: DatabaseAdapter,
  serverVersion: unknown
): void {
  if (typeof serverVersion === "string" && serverVersion.endsWith("(Neki)"))
    bound(adapter, 256);
}

const RELATION_LIMIT = /references more than (\d+) relations/;

/**
 * The bound a refusal names, for a transport whose startup is unread (Bun SQL,
 * a supplied pg pool): the refused statement fails, the next ones fit. The
 * code is node-postgres's and postgres.js's `code`, Bun SQL's `errno`.
 */
export function learnRelationLimit(
  adapter: DatabaseAdapter,
  error: unknown
): void {
  if (
    adapter.capabilities.relationsPerStatement !== undefined ||
    typeof error !== "object" ||
    error === null
  )
    return;
  const refused =
    Reflect.get(error, "code") === "54000" ||
    Reflect.get(error, "errno") === "54000";
  const limit = RELATION_LIMIT.exec(String(Reflect.get(error, "message")));
  if (refused && limit !== null) bound(adapter, Number(limit[1]));
}
