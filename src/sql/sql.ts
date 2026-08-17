/**
 * Values supported by SQL engine.
 */
export type Value = unknown;

/**
 * Supported value or SQL instance.
 */
export type RawValue = Value | Sql;

type Placeholder = "$n" | ":n" | "?";

interface SqlProjection {
  strings: string[];
  values: Value[];
}

type StatementCache = Partial<Record<Placeholder, string>>;

/**
 * A SQL instance can be nested within each other to build SQL strings.
 *
 * Composition is lazy: constructing a Sql just stores the raw fragments.
 * The nested tree is flattened in a single pass over raw fragments when
 * `strings`/`values` is first read (typically only on the root query), so
 * intermediate fragments never pay flattening or allocation.
 */
export class Sql {
  private rawStrings: readonly string[];
  private rawValues: readonly RawValue[];

  private projection: SqlProjection | undefined;
  private statements: StatementCache | undefined;

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
    return this.flatten().values;
  }

  get strings(): string[] {
    return this.flatten().strings;
  }

  /**
   * Flatten the raw fragment tree in one pass, walking children's raw
   * fragments directly so nested Sql instances are never flattened themselves.
   * The flat arrays then replace the raw tree as the canonical representation,
   * releasing child fragments that are not referenced elsewhere.
   */
  private flatten(): SqlProjection {
    if (this.projection !== undefined) {
      return this.projection;
    }

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

    const projection: SqlProjection = { strings, values };

    this.rawStrings = strings;
    this.rawValues = values;
    this.projection = projection;

    return projection;
  }

  /**
   * Build the final SQL statement string with placeholders.
   * Results are cached per placeholder type for reuse.
   */
  toStatement(placeholder: Placeholder = "?"): string {
    const cached = this.statements?.[placeholder];
    if (cached !== undefined) return cached;

    const strings = this.strings;
    const len = strings.length;

    if (len === 1) {
      const result = strings[0]!;
      this.statements = { $n: result, ":n": result, "?": result };
      return result;
    }

    let result: string;

    if (placeholder === "?") {
      result = strings.join("?");
    } else {
      const prefix = placeholder === "$n" ? "$" : ":";
      const parts = new Array<string>(len * 2 - 1);
      parts[0] = strings[0]!;
      for (let i = 1; i < len; i++) {
        parts[i * 2 - 1] = prefix + i;
        parts[i * 2] = strings[i]!;
      }
      result = parts.join("");
    }

    const statements = this.statements ?? {};
    statements[placeholder] = result;
    this.statements = statements;

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
  if (value instanceof Sql) return true;
  if (value === null || typeof value !== "object") return false;

  const strings = Reflect.get(value, "strings");
  if (!Array.isArray(strings)) return false;

  return Array.isArray(Reflect.get(value, "values"));
}
