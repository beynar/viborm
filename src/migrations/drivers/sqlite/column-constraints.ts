import {
  isSqliteBareIdentifierCharacter,
  readSqliteIdentifier,
  skipSqlNonStructuralRegion,
} from "./sql-lexing";

/** One top-level entry of a `CREATE TABLE` definition list. */
export interface SqliteTableDefinition {
  readonly text: string;
  /** The column this entry defines, or `undefined` for a table constraint. */
  readonly columnName: string | undefined;
}

/** A `CONSTRAINT <name>` at the top level of one definition. */
export interface SqliteConstraintClause {
  readonly name: string;
  /** Where the `CONSTRAINT` keyword starts inside the definition text. */
  readonly offset: number;
}

/** Keywords that open a table constraint rather than a column definition. */
const TABLE_CONSTRAINT_KEYWORDS = new Set([
  "CONSTRAINT",
  "PRIMARY",
  "UNIQUE",
  "CHECK",
  "FOREIGN",
]);

/**
 * Every top-level entry of the definition list, with the column each one
 * defines. Quoted tokens and comments are skipped before structural commas and
 * parentheses are interpreted.
 */
export function sqliteTableDefinitions(sql: string): SqliteTableDefinition[] {
  let open = -1;
  let scan = 0;
  while (scan < sql.length) {
    const skipped = skipSqlNonStructuralRegion(sql, scan);
    if (skipped !== scan) {
      scan = skipped;
      continue;
    }
    if (sql[scan] === "(") {
      open = scan;
      break;
    }
    scan++;
  }
  if (open === -1) return [];

  const definitions: SqliteTableDefinition[] = [];
  let depth = 1;
  let start = open + 1;
  let cursor = start;
  while (cursor < sql.length) {
    const skipped = skipSqlNonStructuralRegion(sql, cursor);
    if (skipped !== cursor) {
      cursor = skipped;
      continue;
    }
    const char = sql[cursor];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) break;
    } else if (char === "," && depth === 1) {
      definitions.push(describeDefinition(sql.slice(start, cursor)));
      start = cursor + 1;
    }
    cursor++;
  }
  definitions.push(describeDefinition(sql.slice(start, cursor)));
  return definitions;
}

function describeDefinition(raw: string): SqliteTableDefinition {
  const text = raw.trim();
  const first = readSqliteIdentifier(text, 0);
  if (first === undefined) return { text, columnName: undefined };
  if (first.quoted) return { text, columnName: first.value };
  return {
    text,
    columnName: TABLE_CONSTRAINT_KEYWORDS.has(first.value.toUpperCase())
      ? undefined
      : first.value,
  };
}

/** Every structural `CONSTRAINT <name>` at depth zero of one definition. */
export function sqliteConstraintClauses(
  definition: string
): SqliteConstraintClause[] {
  const clauses: SqliteConstraintClause[] = [];
  let depth = 0;
  let cursor = 0;
  while (cursor < definition.length) {
    const skipped = skipSqlNonStructuralRegion(definition, cursor);
    if (skipped !== cursor) {
      cursor = skipped;
      continue;
    }
    const char = definition[cursor] ?? "";
    if (isSqliteBareIdentifierCharacter(char)) {
      const word = readSqliteIdentifier(definition, cursor);
      if (word === undefined) {
        cursor++;
        continue;
      }
      if (depth === 0 && word.value.toUpperCase() === "CONSTRAINT") {
        const name = readSqliteIdentifier(definition, word.end);
        if (name) {
          clauses.push({ name: name.value, offset: cursor });
          cursor = name.end;
          continue;
        }
      }
      cursor = word.end;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    cursor++;
  }
  return clauses;
}
