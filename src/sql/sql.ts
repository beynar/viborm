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

    const valuesLength = rawValues.reduce<number>(
      (len, value) => len + (value instanceof Sql ? value.values.length : 1),
      0
    );

    this.values = new Array(valuesLength);
    this.strings = new Array(valuesLength + 1);

    this.strings[0] = rawStrings[0]!;

    // Iterate over raw values, strings, and children. The value is always
    // positioned between two strings, e.g. `index + 1`.
    let i = 0,
      pos = 0;
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

  toStatement(placeholder: "$n" | ":n" | "?" = "?") {
    const len = this.strings.length;
    let i = 1;
    let value = this.strings[0]!;
    while (i < len) value += `${placeholder}${i}${this.strings[i++]!}`;
    return value;
  }
}

function spreadValues(...data: Array<Record<string, RawValue>>) {
  const firstRow = data[0]!;
  // Assuming all rows have the same keys
  const valueKeys = Object.keys(firstRow) as string[];
  const allLengths = new Set();

  const values = data.map((item, index) => {
    const keys = Object.keys(item);
    const values = keys.map((key) => item[key]);
    allLengths.add(values.length);
    return new Sql(["(", ...Array(keys.length - 1).fill(","), ")"], values);
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
      ...Array(values.length - 1).fill(","),
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
  return new Sql(
    [prefix, ...Array(values.length - 1).fill(separator), suffix],
    values
  );
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
