import type { DiffOperation, SchemaSnapshot, TableDef } from "./types";

const DOLLAR_QUOTE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const BARE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;
const SQL_WHITESPACE = /\s/;

export type NativeRenameOperation = Extract<
  DiffOperation,
  { type: "renameTable" | "renameColumn" }
>;

/**
 * Applies the schema-wide effect a database native rename has already made.
 *
 * The resolver uses this as its next differ input, generated down migrations
 * use it to address definitions before the inverse rename runs, and SQLite's
 * batch replay uses it before a later table reconstruction. It never mutates
 * the snapshot supplied by the caller.
 */
export function applyNativeRename(
  snapshot: SchemaSnapshot,
  operation: NativeRenameOperation
): SchemaSnapshot {
  return {
    ...snapshot,
    tables:
      operation.type === "renameTable"
        ? renameTable(snapshot.tables, operation.from, operation.to)
        : renameColumn(
            snapshot.tables,
            operation.tableName,
            operation.from,
            operation.to
          ),
  };
}

function renameTable(
  tables: readonly TableDef[],
  from: string,
  to: string
): TableDef[] {
  return tables.map((table) => ({
    ...table,
    name: table.name === from ? to : table.name,
    foreignKeys: table.foreignKeys.map((foreignKey) =>
      foreignKey.referencedTable === from
        ? { ...foreignKey, referencedTable: to }
        : foreignKey
    ),
  }));
}

function renameColumn(
  tables: readonly TableDef[],
  tableName: string,
  from: string,
  to: string
): TableDef[] {
  const renamed = (name: string) => (name === from ? to : name);

  return tables.map((table) => {
    const ownsColumn = table.name === tableName;
    return {
      ...table,
      columns: ownsColumn
        ? table.columns.map((column) =>
            column.name === from ? { ...column, name: to } : column
          )
        : table.columns,
      ...(ownsColumn && table.primaryKey
        ? {
            primaryKey: {
              ...table.primaryKey,
              columns: table.primaryKey.columns.map(renamed),
            },
          }
        : {}),
      indexes: ownsColumn
        ? table.indexes.map((index) => ({
            ...index,
            columns: index.columns.map(renamed),
            ...(index.where === undefined
              ? {}
              : { where: renameSqlIdentifier(index.where, from, to) }),
          }))
        : table.indexes,
      foreignKeys: table.foreignKeys.map((foreignKey) => ({
        ...foreignKey,
        columns: ownsColumn
          ? foreignKey.columns.map(renamed)
          : foreignKey.columns,
        referencedColumns:
          foreignKey.referencedTable === tableName
            ? foreignKey.referencedColumns.map(renamed)
            : foreignKey.referencedColumns,
      })),
      uniqueConstraints: ownsColumn
        ? table.uniqueConstraints.map((constraint) => ({
            ...constraint,
            columns: constraint.columns.map(renamed),
          }))
        : table.uniqueConstraints,
    };
  });
}

/**
 * Rewrites one identifier in an opaque SQL expression without touching values.
 *
 * PostgreSQL and SQLite persist partial-index predicates as SQL text, but a
 * native column rename changes the parsed column references in those
 * predicates. Snapshot replay must model the same effect before a later table
 * recreation. Quoted identifiers retain their delimiter; ordinary identifiers
 * retain their spelling style when the target can be written bare. Strings,
 * dollar-quoted bodies, and comments are copied byte-for-byte.
 */
function renameSqlIdentifier(sql: string, from: string, to: string): string {
  let rewritten = "";
  let cursor = 0;

  while (cursor < sql.length) {
    const quote = sql[cursor];

    if (quote === "'") {
      const end = quotedRegionEnd(sql, cursor, "'", "'");
      rewritten += sql.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (quote === '"' || quote === "`") {
      const end = quotedRegionEnd(sql, cursor, quote, quote);
      if (sql[end - 1] !== quote) {
        rewritten += sql.slice(cursor, end);
        cursor = end;
        continue;
      }
      const body = sql.slice(cursor + 1, end - 1);
      const identifier = body.replaceAll(`${quote}${quote}`, quote);
      rewritten +=
        identifier === from && !isNonColumnIdentifier(sql, cursor, end)
          ? `${quote}${to.replaceAll(quote, `${quote}${quote}`)}${quote}`
          : sql.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (quote === "[") {
      const end = quotedRegionEnd(sql, cursor, "]", "]");
      if (sql[end - 1] !== "]") {
        rewritten += sql.slice(cursor, end);
        cursor = end;
        continue;
      }
      const body = sql.slice(cursor + 1, end - 1);
      const identifier = body.replaceAll("]]", "]");
      rewritten +=
        identifier === from && !isNonColumnIdentifier(sql, cursor, end)
          ? `[${escapeBracketIdentifier(to)}]`
          : sql.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (quote === "-" && sql[cursor + 1] === "-") {
      const newline = sql.indexOf("\n", cursor + 2);
      const end = newline < 0 ? sql.length : newline;
      rewritten += sql.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (quote === "/" && sql[cursor + 1] === "*") {
      const end = blockCommentEnd(sql, cursor);
      rewritten += sql.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (quote === "$") {
      const delimiter = dollarQuoteDelimiter(sql, cursor);
      if (delimiter !== undefined) {
        const closing = sql.indexOf(delimiter, cursor + delimiter.length);
        const end = closing < 0 ? sql.length : closing + delimiter.length;
        rewritten += sql.slice(cursor, end);
        cursor = end;
        continue;
      }
    }
    if (isIdentifierStart(quote)) {
      let end = cursor + 1;
      while (end < sql.length && isIdentifierPart(sql[end]!)) end += 1;
      const identifier = sql.slice(cursor, end);
      const lowercaseIdentifier = identifier.toLowerCase();
      const escapeStringQuote =
        lowercaseIdentifier === "e" && sql[end] === "'"
          ? end
          : lowercaseIdentifier === "u" &&
              sql[end] === "&" &&
              sql[end + 1] === "'"
            ? end + 1
            : undefined;
      if (escapeStringQuote !== undefined) {
        const literalEnd = quotedRegionEnd(
          sql,
          escapeStringQuote,
          "'",
          "'",
          true
        );
        rewritten += sql.slice(cursor, literalEnd);
        cursor = literalEnd;
        continue;
      }
      const isStringPrefix =
        sql[end] === "'" ||
        (lowercaseIdentifier === "u" &&
          sql[end] === "&" &&
          sql[end + 1] === "'");
      rewritten +=
        !(isStringPrefix || isNonColumnIdentifier(sql, cursor, end)) &&
        unquotedIdentifierMatches(identifier, from)
          ? bareIdentifierOrQuoted(to)
          : identifier;
      cursor = end;
      continue;
    }

    rewritten += quote;
    cursor += 1;
  }

  return rewritten;
}

function quotedRegionEnd(
  sql: string,
  start: number,
  closingQuote: string,
  escapedQuote: string,
  backslashEscapes = false
): number {
  let cursor = start + 1;
  while (cursor < sql.length) {
    if (backslashEscapes && sql[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (sql[cursor] !== closingQuote) {
      cursor += 1;
      continue;
    }
    if (sql[cursor + 1] === escapedQuote) {
      cursor += 2;
      continue;
    }
    return cursor + 1;
  }
  return sql.length;
}

function blockCommentEnd(sql: string, start: number): number {
  let cursor = start + 2;
  let depth = 1;
  while (cursor < sql.length && depth > 0) {
    if (sql[cursor] === "/" && sql[cursor + 1] === "*") {
      depth += 1;
      cursor += 2;
    } else if (sql[cursor] === "*" && sql[cursor + 1] === "/") {
      depth -= 1;
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  return cursor;
}

function dollarQuoteDelimiter(sql: string, start: number): string | undefined {
  const rest = sql.slice(start);
  const match = DOLLAR_QUOTE.exec(rest);
  return match?.[0];
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && IDENTIFIER_START.test(character);
}

function isIdentifierPart(character: string): boolean {
  return IDENTIFIER_PART.test(character);
}

function unquotedIdentifierMatches(identifier: string, from: string): boolean {
  return from === from.toLowerCase() && identifier.toLowerCase() === from;
}

function isNonColumnIdentifier(
  sql: string,
  start: number,
  end: number
): boolean {
  let next = end;
  while (next < sql.length && SQL_WHITESPACE.test(sql[next]!)) next += 1;
  if (sql[next] === "(" || (sql[next] === "=" && sql[next + 1] === ">")) {
    return true;
  }

  let previous = start - 1;
  while (previous >= 0 && SQL_WHITESPACE.test(sql[previous]!)) previous -= 1;
  if (sql[previous] === ".") return true;
  if (sql[previous] === ":" && sql[previous - 1] === ":") return true;

  const previousEnd = previous + 1;
  while (previous >= 0 && isIdentifierPart(sql[previous]!)) previous -= 1;
  const previousWord = sql.slice(previous + 1, previousEnd).toLowerCase();
  return previousWord === "as" || previousWord === "collate";
}

function bareIdentifierOrQuoted(identifier: string): string {
  return BARE_IDENTIFIER.test(identifier)
    ? identifier
    : `"${identifier.replaceAll('"', '""')}"`;
}

function escapeBracketIdentifier(identifier: string): string {
  return identifier.split("]").join("]]");
}
