/**
 * Two statement shapes PlanetScale's Neki refuses although PostgreSQL accepts
 * them, read from the SQL text VibORM emits:
 * - a `WITH RECURSIVE` definition of more than two top-level terms (Neki then
 *   cannot see the CTE from its recursive member, 42P01);
 * - a whole-row reference to a relation (`to_jsonb(ix)`, `row_to_json(t)`,
 *   `json_agg(t)`, `(t).*`, `f(t.*)`), which Neki refuses for catalog
 *   relations (0A000 "unsupported type name").
 *
 * The text is tokenized, so literals, quoted identifiers and comments never
 * count as structure.
 */

type Token =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "ident"; readonly text: string }
  | { readonly kind: "punct"; readonly text: string }
  | { readonly kind: "literal" };

const WHITESPACE = /\s/;
const WORD = /[A-Za-z_][A-Za-z0-9_$]*/y;
const NUMBER_OR_PARAMETER = /\$?[0-9][0-9.]*/y;
const DOLLAR_QUOTE = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const skipQuoted = (quote: string, backslash: boolean): string => {
    let text = "";
    at += 1;
    while (at < sql.length) {
      const char = sql[at]!;
      if (backslash && char === "\\") {
        text += sql.slice(at, at + 2);
        at += 2;
      } else if (char === quote && sql[at + 1] === quote) {
        text += quote;
        at += 2;
      } else if (char === quote) {
        at += 1;
        return text;
      } else {
        text += char;
        at += 1;
      }
    }
    throw new Error(`Unterminated ${quote} in: ${sql}`);
  };
  while (at < sql.length) {
    const char = sql[at]!;
    if (WHITESPACE.test(char)) {
      at += 1;
    } else if (sql.startsWith("--", at)) {
      const end = sql.indexOf("\n", at);
      at = end === -1 ? sql.length : end;
    } else if (sql.startsWith("/*", at)) {
      at = sql.indexOf("*/", at) + 2;
    } else if (char === "'") {
      skipQuoted("'", false);
      tokens.push({ kind: "literal" });
    } else if (
      (char === "E" || char === "e") &&
      sql[at + 1] === "'" &&
      tokens.at(-1)?.kind !== "word"
    ) {
      at += 1;
      skipQuoted("'", true);
      tokens.push({ kind: "literal" });
    } else if (char === '"' || char === "`") {
      tokens.push({ kind: "ident", text: skipQuoted(char, false) });
    } else if (char === "$" && matchAt(DOLLAR_QUOTE, sql, at)) {
      const tag = matchAt(DOLLAR_QUOTE, sql, at)!;
      const end = sql.indexOf(tag, at + tag.length);
      at = end + tag.length;
      tokens.push({ kind: "literal" });
    } else if (matchAt(NUMBER_OR_PARAMETER, sql, at)) {
      at += matchAt(NUMBER_OR_PARAMETER, sql, at)!.length;
      tokens.push({ kind: "literal" });
    } else if (matchAt(WORD, sql, at)) {
      const word = matchAt(WORD, sql, at)!;
      at += word.length;
      tokens.push({ kind: "word", text: word });
    } else {
      at += 1;
      tokens.push({ kind: "punct", text: char });
    }
  }
  return tokens;
}

function matchAt(pattern: RegExp, text: string, at: number): string | null {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0] ?? null;
}

const isWord = (token: Token | undefined, word: string): boolean =>
  token?.kind === "word" && token.text.toUpperCase() === word;
const isPunct = (token: Token | undefined, text: string): boolean =>
  token?.kind === "punct" && token.text === text;
const isName = (token: Token | undefined): boolean =>
  token?.kind === "ident" || token?.kind === "word";
const nameOf = (token: Token): string =>
  token.kind === "ident" || token.kind === "word" ? token.text : "";

/** The index just past the parenthesis that closes the one at `open`. */
function closing(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (isPunct(tokens[index], "(")) depth += 1;
    if (isPunct(tokens[index], ")")) depth -= 1;
    if (depth === 0) return index + 1;
  }
  throw new Error("Unbalanced parentheses");
}

/**
 * The number of top-level `UNION` / `UNION ALL` terms of every definition
 * under a `WITH RECURSIVE`, in statement order.
 */
export function recursiveTermCounts(sql: string): number[] {
  const tokens = tokenize(sql);
  const counts: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      !(isWord(tokens[index], "WITH") && isWord(tokens[index + 1], "RECURSIVE"))
    )
      continue;
    let at = index + 2;
    for (;;) {
      at += 1; // the CTE name
      if (isPunct(tokens[at], "(")) at = closing(tokens, at);
      if (!isWord(tokens[at], "AS")) throw new Error(`No AS in: ${sql}`);
      at += 1;
      if (isWord(tokens[at], "NOT")) at += 1;
      if (isWord(tokens[at], "MATERIALIZED")) at += 1;
      const end = closing(tokens, at);
      let terms = 1;
      let depth = 0;
      for (let inner = at + 1; inner < end - 1; inner += 1) {
        if (isPunct(tokens[inner], "(")) depth += 1;
        else if (isPunct(tokens[inner], ")")) depth -= 1;
        else if (depth === 0 && isWord(tokens[inner], "UNION")) terms += 1;
      }
      counts.push(terms);
      if (!isPunct(tokens[end], ",")) break;
      at = end + 1;
    }
  }
  return counts;
}

/** Functions whose single relation-alias argument reads the whole row. */
const ROW_READERS = new Set([
  "ROW_TO_JSON",
  "TO_JSON",
  "TO_JSONB",
  "JSON_AGG",
  "JSONB_AGG",
  "ARRAY_AGG",
  "HSTORE",
]);

/** Words that follow a FROM item or a subquery without naming it. */
const KEYWORDS = new Set(
  "AND AS CROSS EXCEPT FETCH FOR FROM FULL GROUP HAVING INNER INTERSECT JOIN LATERAL LEFT LIMIT NATURAL OFFSET ON OR ORDER RETURNING RIGHT SELECT SET UNION USING WHERE WINDOW WITH".split(
    " "
  )
);

/** Every whole-row reference to a relation the statement names. */
export function wholeRowReferences(sql: string): string[] {
  const tokens = tokenize(sql);
  const relations = new Set<string>();
  const addAlias = (at: number) => {
    const alias = isWord(tokens[at], "AS") ? tokens[at + 1] : tokens[at];
    if (
      alias?.kind === "ident" ||
      (alias?.kind === "word" && !KEYWORDS.has(alias.text.toUpperCase()))
    )
      relations.add(nameOf(alias));
  };
  const opens: number[] = [];
  tokens.forEach((token, index) => {
    // A qualifier: `ix.attname`, `marker.payload`.
    if (isName(token) && isPunct(tokens[index + 1], "."))
      relations.add(nameOf(token));
    // A subquery's alias: `(SELECT …) marker`, `(VALUES …) AS "q1"`.
    if (isPunct(token, "(")) opens.push(index);
    if (isPunct(token, ")")) {
      const first = tokens[(opens.pop() ?? -1) + 1];
      if (["SELECT", "VALUES", "WITH"].some((word) => isWord(first, word)))
        addAlias(index + 1);
    }
    // A FROM or JOIN item: `FROM pg_catalog.pg_index ix`.
    if (isWord(token, "FROM") || isWord(token, "JOIN")) {
      let at = index + 1;
      if (!isName(tokens[at])) return;
      while (isPunct(tokens[at + 1], ".") && isName(tokens[at + 2])) at += 2;
      relations.add(nameOf(tokens[at]!));
      addAlias(at + 1);
    }
  });
  const found: string[] = [];
  tokens.forEach((token, index) => {
    const [open, argument, after, star] = tokens.slice(index + 1, index + 5);
    // `(alias).*`
    if (
      isPunct(token, "(") &&
      isName(open) &&
      isPunct(argument, ")") &&
      isPunct(after, ".") &&
      isPunct(star, "*")
    )
      found.push(`(${nameOf(open!)}).*`);
    if (!(token.kind === "word" && isPunct(open, "(") && isName(argument)))
      return;
    const fn = token.text.toUpperCase();
    const name = nameOf(argument!);
    // `f(alias.*)`
    if (isPunct(after, ".") && isPunct(star, "*"))
      found.push(`${token.text}(${name}.*)`);
    else if (
      isPunct(after, ")") &&
      ROW_READERS.has(fn) &&
      (fn === "ROW_TO_JSON" || relations.has(name))
    )
      found.push(`${token.text}(${name})`);
  });
  return found;
}

/** Every shape Neki refuses in `statements`, each with its statement. */
export function nekiRefusals(statements: readonly string[]): string[] {
  return statements.flatMap((statement) => [
    ...wholeRowReferences(statement).map(
      (reference) => `whole-row ${reference} in: ${statement}`
    ),
    ...recursiveTermCounts(statement)
      .filter((terms) => terms !== 2)
      .map((terms) => `${terms}-term recursive CTE in: ${statement}`),
  ]);
}
