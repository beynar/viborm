/** CSV and TSV over JSON-compatible values, shared by server and browser exports. */
const QUOTED_CELL = /["\r\n]|^\s|\s$/;

export function writeDelimited(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  separator = ",",
  headers = true
): string {
  const quote = (text: string) =>
    text === "" || text.includes(separator) || QUOTED_CELL.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  const cell = (value: unknown) => {
    if (value === null) return "\\N";
    if (value === undefined) return "";
    const text =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    return quote(text.startsWith("\\") ? `\\${text}` : text);
  };
  return [
    ...(headers ? [columns.map(quote).join(separator)] : []),
    ...rows.map((row) =>
      columns.map((column) => cell(row[column])).join(separator)
    ),
  ].join("\r\n");
}
