export interface SQLStatementToken {
  depth: number;
  kind: "identifier" | "word" | "symbol";
  value: string;
}

export interface SQLStatementTokenOptions {
  /** MySQL string literals may escape the next character with a backslash. */
  backslashEscapes?: boolean;
}

const WHITESPACE_REGEX = /\s/;
const WORD_START_REGEX = /[A-Za-z_]/;
const WORD_PART_REGEX = /[A-Za-z0-9_$]/;

/** Tokenize one SQL statement while ignoring comments, strings, and parameters. */
export function getTopLevelStatementTokens(
  sql: string,
  options: SQLStatementTokenOptions = {}
): SQLStatementToken[] | undefined {
  const tokens: SQLStatementToken[] = [];
  let depth = 0;
  let index = 0;
  let statementEnded = false;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (!char) break;
    if (WHITESPACE_REGEX.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      index = skipLineComment(sql, index + 2);
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = sql.indexOf("*/", index + 2);
      if (commentEnd < 0) return undefined;
      index = commentEnd + 2;
      continue;
    }
    if (char === "'") {
      const quotedEnd = skipQuoted(
        sql,
        index,
        char,
        options.backslashEscapes === true
      );
      if (quotedEnd < 0 || statementEnded) return undefined;
      index = quotedEnd;
      continue;
    }
    if (char === '"' || char === "`" || char === "[") {
      const quote = char === "[" ? "]" : char;
      const identifier = readQuotedIdentifier(sql, index, quote);
      if (!identifier || statementEnded) return undefined;
      tokens.push({
        depth,
        kind: "identifier",
        value: identifier.value.toUpperCase(),
      });
      index = identifier.end;
      continue;
    }
    if (char === ";" && depth === 0) {
      statementEnded = true;
      index += 1;
      continue;
    }
    if (statementEnded) return undefined;
    if (
      (char === ":" || char === "@" || char === "$") &&
      WORD_START_REGEX.test(next ?? "")
    ) {
      index += 2;
      while (index < sql.length && WORD_PART_REGEX.test(sql[index] ?? "")) {
        index += 1;
      }
      continue;
    }
    if (char === "(") {
      tokens.push({ depth, kind: "symbol", value: char });
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth < 0) return undefined;
      tokens.push({ depth, kind: "symbol", value: char });
      index += 1;
      continue;
    }
    if (char === "=") {
      tokens.push({ depth, kind: "symbol", value: char });
      index += 1;
      continue;
    }
    if (WORD_START_REGEX.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && WORD_PART_REGEX.test(sql[index] ?? "")) {
        index += 1;
      }
      tokens.push({
        depth,
        kind: "word",
        value: sql.slice(start, index).toUpperCase(),
      });
      continue;
    }
    index += 1;
  }

  if (depth !== 0) return undefined;
  return tokens.filter((token) => token.depth === 0);
}

function skipLineComment(sql: string, index: number): number {
  const lineEnd = sql.indexOf("\n", index);
  return lineEnd < 0 ? sql.length : lineEnd + 1;
}

function skipQuoted(
  sql: string,
  index: number,
  quote: string,
  backslashEscapes: boolean
): number {
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (backslashEscapes && sql[cursor] === "\\") {
      if (cursor + 1 >= sql.length) return -1;
      cursor += 2;
      continue;
    }
    if (sql[cursor] !== quote) {
      cursor += 1;
      continue;
    }
    if (sql[cursor + 1] === quote) {
      cursor += 2;
      continue;
    }
    return cursor + 1;
  }
  return -1;
}

function readQuotedIdentifier(
  sql: string,
  index: number,
  quote: string
): { end: number; value: string } | undefined {
  let cursor = index + 1;
  let value = "";
  while (cursor < sql.length) {
    const char = sql[cursor];
    if (char !== quote) {
      value += char;
      cursor += 1;
      continue;
    }
    if (sql[cursor + 1] === quote) {
      value += quote;
      cursor += 2;
      continue;
    }
    return { end: cursor + 1, value };
  }
  return undefined;
}
