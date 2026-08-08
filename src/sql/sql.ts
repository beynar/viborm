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
 *
 * Composition is lazy: constructing a Sql just stores the raw fragments.
 * The nested tree is flattened in a single pass over raw fragments when
 * `strings`/`values` is first read (typically only on the root query), so
 * intermediate fragments never pay flattening or allocation.
 */
export class Sql {
  private readonly rawStrings: readonly string[];
  private readonly rawValues: readonly RawValue[];

  private _values: Value[] | undefined;
  private _strings: string[] | undefined;

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

    this.rawStrings = rawStrings;
    this.rawValues = rawValues;
  }

  get values(): Value[] {
    if (this._values === undefined) {
      this.flatten();
    }
    return this._values as Value[];
  }

  get strings(): string[] {
    if (this._strings === undefined) {
      this.flatten();
    }
    return this._strings as string[];
  }

  /**
   * Flatten the raw fragment tree in one pass, walking children's raw
   * fragments directly so nested Sql instances are never flattened themselves.
   */
  private flatten(): void {
    const strings: string[] = [];
    const values: Value[] = [];
    let current = "";

    const walk = (
      rawStrings: readonly string[],
      rawValues: readonly RawValue[]
    ): void => {
      current += rawStrings[0]!;
      for (let i = 0; i < rawValues.length; i++) {
        const child = rawValues[i]!;
        if (child instanceof Sql) {
          walk(child.rawStrings, child.rawValues);
        } else {
          values.push(child);
          strings.push(current);
          current = "";
        }
        current += rawStrings[i + 1]!;
      }
    };

    walk(this.rawStrings, this.rawValues);
    strings.push(current);

    this._strings = strings;
    this._values = values;
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

/**
 * Splice text into a statement verbatim — nothing here is bound as a
 * parameter. Two shapes live under this one name:
 *
 * - `raw("ORDER BY name DESC")` — Prisma's unsafe string splice. The caller
 *   owns the escaping; never hand it user input.
 * - ``raw`TRUE` `` — the tagged-template form the adapters use for dialect
 *   keywords. Interpolations are concatenated into the text, not bound.
 */
function raw(value: string): Sql;
function raw(strings: readonly string[], ...values: readonly RawValue[]): Sql;
function raw(
  strings: string | readonly string[],
  ...values: readonly RawValue[]
): Sql {
  if (typeof strings === "string") {
    return new Sql([strings], []);
  }
  const concatenated = strings.reduce((acc, string, index) => {
    return acc + string + (values[index] ?? "");
  }, "");
  return new Sql([concatenated], []);
}

/**
 * Create a SQL query for a list of values.
 *
 * Values are `RawValue`s, matching Prisma: a nested `Sql` is spliced as a
 * fragment, anything else becomes a bound parameter.
 */
function join(
  values: readonly RawValue[],
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

const sqlTag = Object.assign(sql, { raw, empty, join });

export { empty, join, raw, sqlTag as sql };

/**
 * Type guard for Sql fragments. Structural check rather than instanceof so it
 * also matches fragments from a duplicated module instance (e.g. dual CJS/ESM
 * builds).
 */
export function isSql(value: unknown): value is Sql {
  return (
    value !== null &&
    typeof value === "object" &&
    "strings" in value &&
    "values" in value &&
    Array.isArray((value as Sql).strings) &&
    Array.isArray((value as Sql).values)
  );
}
