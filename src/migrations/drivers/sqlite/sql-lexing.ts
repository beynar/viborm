/** SQLite token boundaries shared by stored-DDL readers. */

/** An identifier token and where it ends. */
export interface SqliteIdentifierToken {
  readonly value: string;
  readonly quoted: boolean;
  readonly end: number;
}

const IDENTIFIER_CLOSERS: Readonly<Record<string, string>> = {
  '"': '"',
  "`": "`",
  "[": "]",
};

const BARE_IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;
const WHITESPACE = /\s/;

/** Whether one character can occur in SQLite's bare identifier spelling. */
export function isSqliteBareIdentifierCharacter(character: string): boolean {
  return BARE_IDENTIFIER_CHARACTER.test(character);
}

/**
 * Read the identifier at or after `index`, in any of SQLite's four spellings.
 *
 * A doubled quote inside a `"…"` or a `` `…` `` token is an escaped one.
 */
export function readSqliteIdentifier(
  text: string,
  index: number
): SqliteIdentifierToken | undefined {
  let cursor = index;
  while (cursor < text.length) {
    while (cursor < text.length && WHITESPACE.test(text[cursor] ?? "")) {
      cursor++;
    }
    const isComment =
      (text[cursor] === "-" && text[cursor + 1] === "-") ||
      (text[cursor] === "/" && text[cursor + 1] === "*");
    if (!isComment) break;
    cursor = skipSqlNonStructuralRegion(text, cursor);
  }
  const opener = text[cursor];
  if (opener === undefined) return undefined;

  const closer = IDENTIFIER_CLOSERS[opener];
  if (closer !== undefined) {
    let value = "";
    cursor++;
    while (cursor < text.length) {
      if (text[cursor] === closer) {
        if (text[cursor + 1] === closer && closer !== "]") {
          value += closer;
          cursor += 2;
          continue;
        }
        return { value, quoted: true, end: cursor + 1 };
      }
      value += text[cursor];
      cursor++;
    }
    return undefined;
  }

  const start = cursor;
  while (
    cursor < text.length &&
    isSqliteBareIdentifierCharacter(text[cursor] ?? "")
  ) {
    cursor++;
  }
  if (cursor === start) return undefined;
  return { value: text.slice(start, cursor), quoted: false, end: cursor };
}

/**
 * The offset just past the quoted token or SQL comment starting at `index`, or
 * `index` itself when structural SQL starts there.
 */
export function skipSqlNonStructuralRegion(
  text: string,
  index: number
): number {
  const opener = text[index];
  if (opener === undefined) return index;
  if (opener === "-" && text[index + 1] === "-") {
    const end = text.indexOf("\n", index + 2);
    return end === -1 ? text.length : end;
  }
  if (opener === "/" && text[index + 1] === "*") {
    const end = text.indexOf("*/", index + 2);
    return end === -1 ? text.length : end + 2;
  }
  const closer = opener === "'" ? "'" : IDENTIFIER_CLOSERS[opener];
  if (closer === undefined) return index;

  let cursor = index + 1;
  while (cursor < text.length) {
    if (text[cursor] === closer) {
      // A doubled quote is an escaped one, not the end of the token. `]` has
      // no escape in SQLite's bracket spelling.
      if (text[cursor + 1] === closer && closer !== "]") {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor++;
  }
  return text.length;
}
