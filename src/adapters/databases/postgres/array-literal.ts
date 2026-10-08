const ARRAY_LITERAL_ESCAPES = /(["\\])/g;

/** The physical text of a PostgreSQL array; the destination supplies its type. */
export function arrayLiteralText(values: readonly unknown[]): string {
  const members = values.map(
    (value) => `"${String(value).replace(ARRAY_LITERAL_ESCAPES, "\\$1")}"`
  );
  return `{${members.join(",")}}`;
}

/** Read the one-dimensional array spelling PostgreSQL emits for scalar lists. */
export function readArrayLiteralText(
  text: string
): (string | null)[] | undefined {
  if (!(text.startsWith("{") && text.endsWith("}"))) return;
  if (text === "{}") return [];
  const values: (string | null)[] = [];
  let cursor = 1;
  while (cursor < text.length - 1) {
    let value = "";
    const quoted = text[cursor] === '"';
    if (quoted) cursor++;
    let closed = !quoted;
    while (cursor < text.length - 1) {
      const character = text[cursor++];
      if (character === "\\") {
        const escaped = text[cursor++];
        if (escaped === undefined) return;
        value += escaped;
      } else if (quoted && character === '"') {
        closed = true;
        break;
      } else if (!quoted && character === ",") {
        cursor--;
        break;
      } else if (
        !quoted &&
        (character === "{" || character === "}" || character === '"')
      )
        return;
      else value += character;
    }
    if (!closed) return;
    values.push(!quoted && value === "NULL" ? null : value);
    if (cursor === text.length - 1) return values;
    if (text[cursor++] !== "," || cursor === text.length - 1) return;
  }
}
