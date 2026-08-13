import {
  getTopLevelStatementTokens,
  type SQLStatementToken,
} from "./sql-statement-tokens";

export type SQLiteStatementResultKind = "rows" | "no-rows" | "unknown";

const ROW_COMMANDS = new Set(["EXPLAIN", "SELECT", "VALUES"]);
const MUTATION_COMMANDS = new Set(["DELETE", "INSERT", "REPLACE", "UPDATE"]);
const NO_ROW_COMMANDS = new Set([
  "ALTER",
  "ANALYZE",
  "ATTACH",
  "BEGIN",
  "COMMIT",
  "CREATE",
  "DETACH",
  "DROP",
  "END",
  "REINDEX",
  "RELEASE",
  "ROLLBACK",
  "SAVEPOINT",
  "VACUUM",
]);
const NO_ROW_PRAGMA_SETTERS = new Set([
  "CASE_SENSITIVE_LIKE",
  "DEFER_FOREIGN_KEYS",
  "FOREIGN_KEYS",
  "IGNORE_CHECK_CONSTRAINTS",
  "LEGACY_ALTER_TABLE",
  "RECURSIVE_TRIGGERS",
  "REVERSE_UNORDERED_SELECTS",
]);
const NO_ROW_PRAGMA_COMMANDS = new Set(["OPTIMIZE"]);
const WITH_COMMANDS = new Set([...ROW_COMMANDS, ...MUTATION_COMMANDS]);

/** Classify whether one SQLite statement is contractually row-producing. */
export function classifySQLiteStatementResult(
  sql: string
): SQLiteStatementResultKind {
  const topLevel = getTopLevelStatementTokens(sql);
  if (!topLevel) return "unknown";
  const resolved = topLevelCommand(topLevel);
  const command = resolved?.value;
  if (!command) return "unknown";
  if (ROW_COMMANDS.has(command)) {
    return "rows";
  }
  if (MUTATION_COMMANDS.has(command)) {
    return topLevel
      .slice(resolved.index + 1)
      .some((token) => token.kind === "word" && token.value === "RETURNING")
      ? "rows"
      : "no-rows";
  }
  if (command === "PRAGMA") {
    return classifyPragma(topLevel);
  }
  return NO_ROW_COMMANDS.has(command) ? "no-rows" : "unknown";
}

/** Whether D1/SQLite's statement-local generated-row metadata belongs to this SQL. */
export function isSQLiteInsertStatement(sql: string): boolean {
  const command = topLevelCommand(getTopLevelStatementTokens(sql))?.value;
  return command === "INSERT" || command === "REPLACE";
}

function topLevelCommand(
  topLevel: SQLStatementToken[] | undefined
): { readonly index: number; readonly value: string } | undefined {
  const first = topLevel?.[0];
  if (!first || first.kind !== "word") return undefined;
  if (first.value !== "WITH") return { index: 0, value: first.value };
  const index = topLevel.findIndex(
    (token, tokenIndex) =>
      tokenIndex > 0 && token.kind === "word" && WITH_COMMANDS.has(token.value)
  );
  const command = topLevel[index];
  return command?.kind === "word" ? { index, value: command.value } : undefined;
}

function classifyPragma(
  tokens: SQLStatementToken[]
): SQLiteStatementResultKind {
  const assignmentIndex = tokens.findIndex(
    (token) => token.kind === "symbol" && token.value === "="
  );
  const argumentIndex = tokens.findIndex(
    (token) => token.kind === "symbol" && token.value === "("
  );
  const setterBoundaryIndex =
    assignmentIndex >= 0 ? assignmentIndex : argumentIndex;
  const pragmaNameBoundary =
    setterBoundaryIndex < 0 ? tokens.length : setterBoundaryIndex;

  let pragmaName: string | undefined;
  for (let index = pragmaNameBoundary - 1; index > 0; index -= 1) {
    const token = tokens[index];
    if (token && (token.kind === "word" || token.kind === "identifier")) {
      pragmaName = token.value;
      break;
    }
  }
  if (setterBoundaryIndex < 0) {
    return pragmaName && NO_ROW_PRAGMA_COMMANDS.has(pragmaName)
      ? "no-rows"
      : "rows";
  }
  return pragmaName && NO_ROW_PRAGMA_SETTERS.has(pragmaName)
    ? "no-rows"
    : "rows";
}
