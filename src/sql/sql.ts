/**
 * Values supported by SQL engine.
 */
export type Value = unknown;

/**
 * Supported value or SQL instance.
 */
export type RawValue = Value | Sql;

/**
 * A SQL instance can be nested within each other to build SQL strings.
 */
export class Sql {
  readonly values: Value[];
  readonly strings: string[];

  // Cached statement strings (memoized per placeholder type)
  private _stmt$n: string | undefined;
  private _stmt$: string | undefined;
  private _stmtQ: string | undefined;

  constructor(rawStrings: readonly string[], rawValues: readonly RawValue[]) {
    if (rawStrings.length - 1 !== rawValues.length) {
      if (rawStrings.length === 0) {
        throw new TypeError("Expected at least 1 string");
      }
      throw new TypeError(
        `Expected ${rawStrings.length} strings to have ${
          rawStrings.length - 1
        } values`
      );
    }

    // Single pass to count values (avoid reduce overhead)
    let valuesLength = 0;
    for (const v of rawValues) {
      valuesLength += v instanceof Sql ? v.values.length : 1;
    }

    this.values = new Array(valuesLength);
    this.strings = new Array(valuesLength + 1);

    this.strings[0] = rawStrings[0]!;

    // Iterate over raw values, strings, and children. The value is always
    // positioned between two strings, e.g. `index + 1`.
    let i = 0;
    let pos = 0;
    while (i < rawValues.length) {
      const child = rawValues[i++]!;
      const rawString = rawStrings[i]!;

      // Check for nested `sql` queries.
      if (child instanceof Sql) {
        // Append child prefix text to current string.
        this.strings[pos] += child.strings[0]!;

        let childIndex = 0;
        while (childIndex < child.values.length) {
          this.values[pos++] = child.values[childIndex++]!;
          this.strings[pos] = child.strings[childIndex]!;
        }

        // Append raw string to current string.
        this.strings[pos] += rawString;
      } else {
        this.values[pos++] = child;
        this.strings[pos] = rawString;
      }
    }
  }

  /**
   * Build the final SQL statement string with placeholders.
   * Results are cached per placeholder type for reuse.
   */
  toStatement(placeholder: "$n" | ":n" | "?" = "?"): string {
    // Check cache first
    if (placeholder === "$n") {
      if (this._stmt$n !== undefined) return this._stmt$n;
    } else if (placeholder === ":n") {
      if (this._stmt$ !== undefined) return this._stmt$;
    } else if (this._stmtQ !== undefined) return this._stmtQ;

    // Build the statement
    const strings = this.strings;
    const len = strings.length;

    if (len === 1) {
      // No placeholders needed
      const result = strings[0]!;
      this._stmt$n = this._stmt$ = this._stmtQ = result;
      return result;
    }

    // Pre-calculate total length for better string allocation
    // Use array join for better performance with many segments
    const parts = new Array<string>(len * 2 - 1);
    parts[0] = strings[0]!;

    if (placeholder === "?") {
      // Simple ? placeholders (MySQL/SQLite style)
      for (let i = 1; i < len; i++) {
        parts[i * 2 - 1] = "?";
        parts[i * 2] = strings[i]!;
      }
    } else {
      // Numbered placeholders ($1, $2 or :1, :2)
      const prefix = placeholder === "$n" ? "$" : ":";
      for (let i = 1; i < len; i++) {
        parts[i * 2 - 1] = prefix + i;
        parts[i * 2] = strings[i]!;
      }
    }

    const result = parts.join("");

    // Cache the result
    if (placeholder === "$n") {
      this._stmt$n = result;
    } else if (placeholder === ":n") {
      this._stmt$ = result;
    } else {
      this._stmtQ = result;
    }

    return result;
  }
}

function spreadValues(...data: Record<string, RawValue>[]) {
  const firstRow = data[0]!;
  // Assuming all rows have the same keys
  const valueKeys = Object.keys(firstRow) as string[];
  const allLengths = new Set();

  const values = data.map((item) => {
    const keys = Object.keys(item);
    const values = keys.map((key) => item[key]);
    allLengths.add(values.length);
    return new Sql(["(", ...new Array(keys.length - 1).fill(","), ")"], values);
  });

  if (allLengths.size > 1) {
    throw new TypeError(
      "All inserted rows must have the same number of values"
    );
  }

  allLengths.clear();

  return new Sql(
    [
      `(${valueKeys.join(",")}) VALUES `,
      ...new Array(values.length - 1).fill(","),
      ")",
    ],
    values
  );
}

/**
 * Create raw SQL statement.
 */
function raw(strings: readonly string[], ...values: readonly RawValue[]) {
  const concatenated = strings.reduce((acc, string, index) => {
    return acc + string + (values[index] ?? "");
  }, "");
  return new Sql([concatenated], []);
}

const wrap = (prefix: string, wrapped: Sql | undefined, suffix: string) => {
  return wrapped
    ? empty
    : sql`${new Sql([prefix], [])}${wrapped}${new Sql([suffix], [])}`;
};

/**
 * Create a SQL query for a list of values.
 */
function join(
  values: readonly Sql[],
  separator = ",",
  prefix = "",
  suffix = ""
) {
  const len = values.length;
  if (len === 0) {
    return new Sql([prefix + suffix], []);
  }

  // Pre-allocate array with exact size instead of spread + fill
  const strings = new Array<string>(len + 1);
  strings[0] = prefix;
  for (let i = 1; i < len; i++) {
    strings[i] = separator;
  }
  strings[len] = suffix;

  return new Sql(strings, values);
}

/**
 * Placeholder value for "no text".
 */
const empty = raw``;

/**
 * Create a SQL object from a template string.
 */
function sql(strings: readonly string[], ...values: readonly RawValue[]) {
  return new Sql(strings, values);
}

const sqlProxy = new Proxy(sql, {
  get(target, prop) {
    if (prop === "raw") {
      return raw;
    }
    if (prop === "spreadValues") {
      return spreadValues;
    }
    if (prop === "empty") {
      return empty;
    }
    if (prop === "wrap") {
      return wrap;
    }
    if (prop === "join") {
      return join;
    }
    return (strings: TemplateStringsArray, ...values: RawValue[]) => {
      return target(strings, ...values);
    };
  },
}) as typeof sql & {
  raw: typeof raw;
  wrap: typeof wrap;
  spreadValues: typeof spreadValues;
  empty: typeof empty;
  join: typeof join;
};

export { sqlProxy as sql };
