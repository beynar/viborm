/** SQLite printf spelling that round-trips every finite binary64 coordinate. */
export const SQLITE_BINARY64_FORMAT = "%!.17g";
export function sqliteBinary64JsonNumber(expression: string): string {
  return `json(printf('${SQLITE_BINARY64_FORMAT}', ${expression}))`;
}
