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
  if (!topLevel) {
    return "unknown";
  }
  const first = topLevel[0];
  if (!first || first.kind !== "word") {
    return "unknown";
  }

  let commandIndex = 0;
  if (first.value === "WITH") {
    commandIndex = topLevel.findIndex(
      (token, index) =>
        index > 0 && token.kind === "word" && WITH_COMMANDS.has(token.value)
    );
    if (commandIndex < 0) {
      return "unknown";
    }
  }

  const command = topLevel[commandIndex]?.value;
  if (!command) {
    return "unknown";
  }
  if (ROW_COMMANDS.has(command)) {
    return "rows";
  }
  if (MUTATION_COMMANDS.has(command)) {
    return topLevel
      .slice(commandIndex + 1)
      .some((token) => token.kind === "word" && token.value === "RETURNING")
      ? "rows"
      : "no-rows";
  }
  if (command === "PRAGMA") {
    return classifyPragma(topLevel);
  }
  return NO_ROW_COMMANDS.has(command) ? "no-rows" : "unknown";
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
