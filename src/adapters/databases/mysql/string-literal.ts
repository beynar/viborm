/**
 * MySQL's string literal: one spelling for every statement VibORM writes a
 * value into, the DDL of a migration (`migrations/drivers/type-mapping.ts`
 * re-exports it for both snapshot producers) and the body of a view
 * (`adapters/inline-literals.ts`).
 */

/**
 * THE characters MySQL's string literals carry as an escape — the one table
 * both directions read.
 *
 * MySQL reads `\` inside a string literal as an escape introducer (only
 * `NO_BACKSLASH_ESCAPES` stops it, a mode this estate never sets and the
 * pinned session does not promise), so doubling `'` alone spells a DIFFERENT
 * value: `DEFAULT ('a\b')` stored a BACKSPACE and `DEFAULT ('end\')` did not
 * even parse. The four control characters are escaped for the same reason
 * they cannot be written raw: a generated statement is also the review blob,
 * which is UTF-8/LF with no carriage returns (`sql-blob.ts`).
 *
 * `information_schema` prints an expression default with exactly these escapes
 * plus `\'` (measured on 8.4.11 — every other character, tab and backspace
 * included, is printed raw), so `mysql/introspect.ts` undoes this same table
 * before re-spelling the value through `mysqlStringLiteral` below.
 */
export const MYSQL_LITERAL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\\", "\\\\"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\0", "\\0"],
  ["\u001a", "\\Z"],
]);

/**
 * THE MySQL string literal — one spelling, both snapshot producers.
 *
 * The desired side writes it (`MySQLMigrationDriver.escapeValue`) and the live
 * side re-spells the value it read out of the catalog through the very same
 * function (`mysql/introspect.ts`), because two spellings of ONE value read as
 * a changed column on every push and as the mismatch the final push
 * attestation refuses.
 */
export function mysqlStringLiteral(value: string): string {
  let escaped = "";
  for (const character of value) {
    escaped += MYSQL_LITERAL_ESCAPES.get(character) ?? character;
  }
  return `'${escaped.replace(/'/g, "''")}'`;
}
