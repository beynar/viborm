import { QueryError } from "@errors";
import {
  createNormalizedResultMeta,
  type NormalizedResultContext,
  normalizeProviderRowCount,
} from "../normalized-result";

const COMMAND_SEPARATOR_REGEX = /\s+/;
const COMMAND_TOKEN_REGEX = /^[A-Za-z]+$/;

const COUNTED_COMMANDS = new Set([
  "COPY",
  "DELETE",
  "FETCH",
  "INSERT",
  "MERGE",
  "MOVE",
  "SELECT",
  "UPDATE",
]);

const NULLABLE_COUNT_COMMANDS = new Set([
  "ALTER",
  "ANALYZE",
  "BEGIN",
  "CALL",
  "CHECKPOINT",
  "CLOSE",
  "CLUSTER",
  "COMMENT",
  "COMMIT",
  "CREATE",
  "DEALLOCATE",
  "DECLARE",
  "DISCARD",
  "DO",
  "DROP",
  "END",
  "EXPLAIN",
  "GRANT",
  "IMPORT",
  "LISTEN",
  "LOAD",
  "LOCK",
  "NOTIFY",
  "PREPARE",
  "REASSIGN",
  "REFRESH",
  "REINDEX",
  "RELEASE",
  "RESET",
  "REVOKE",
  "ROLLBACK",
  "SAVEPOINT",
  "SECURITY",
  "SET",
  "SHOW",
  "START",
  "TRUNCATE",
  "UNLISTEN",
  "VACUUM",
]);

function malformedPostgresResult(
  context: NormalizedResultContext,
  reason: string
): QueryError {
  return new QueryError(
    `Driver "${context.provider}" returned malformed PostgreSQL result metadata for operation "${context.operation}": ${reason}.`,
    { meta: createNormalizedResultMeta(context) }
  );
}

/**
 * PostgreSQL command tags carry a numeric count only for a defined set of
 * commands. Other known tags legitimately expose null, while missing metadata
 * and null counts for counted commands are malformed provider successes.
 */
export function normalizePostgresRowCount(
  value: unknown,
  command: unknown,
  rows: unknown,
  context: NormalizedResultContext
): number {
  if (!Array.isArray(rows)) {
    throw malformedPostgresResult(context, "the rows payload is not an array");
  }
  if (typeof command !== "string" || command.trim() === "") {
    throw malformedPostgresResult(context, "the command tag is invalid");
  }
  const [commandToken] = command.trim().split(COMMAND_SEPARATOR_REGEX, 1);
  if (!(commandToken && COMMAND_TOKEN_REGEX.test(commandToken))) {
    throw malformedPostgresResult(context, "the command tag is invalid");
  }
  const normalizedCommand = commandToken.toUpperCase();
  const isCountedCommand = COUNTED_COMMANDS.has(normalizedCommand);
  const isNullableCountCommand = NULLABLE_COUNT_COMMANDS.has(normalizedCommand);
  if (!(isCountedCommand || isNullableCountCommand)) {
    throw malformedPostgresResult(context, "the command tag is unknown");
  }
  if (value !== null) {
    return normalizeProviderRowCount(value, context);
  }
  if (isCountedCommand) {
    throw malformedPostgresResult(
      context,
      `command ${normalizedCommand} requires a numeric row count`
    );
  }
  return rows.length;
}
