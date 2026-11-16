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

const templateString = (strings: readonly string[], index: number): string =>
  strings[index]!;
const listString = (strings: readonly string[], index: number): string =>
  strings[index]!;

/**
 * The string of a fragment's `strings` at `index`, a tagged template's
 * (`template`: a frozen array) read at one place and any other array at
 * another. Read at the same place, the two kinds of array cost every read a
 * lookup: flattening the statement of a two-level read (109 fragments, 228
 * strings) took 2.2 µs, 1.8 µs read apart, and 1.5 µs over plain arrays alone.
 */
const stringAt = (
  strings: readonly string[],
  index: number,
  template: boolean
): string =>
  template ? templateString(strings, index) : listString(strings, index);

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
  /** Whether `rawStrings` is a tagged template's strings ({@link stringAt}). */
  private template: boolean;

  private projection: SqlProjection | undefined;
  private statements: StatementCache | undefined;

  constructor(
    rawStrings: readonly string[],
    rawValues: readonly RawValue[],
    template = false
  ) {
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
    this.template = template;
  }

  get values(): Value[] {
    return this.flatten().values;
  }

  get strings(): string[] {
    return this.flatten().strings;
  }

  /**
   * The projection {@link flatten} makes of `fragment`, made without keeping
   * it: a fragment holding an open {@link SqlSlot} reads its provisional text
   * and stays open.
   */
  static peek(fragment: Sql): { strings: string[]; values: Value[] } {
    return fragment.projection ?? Sql.project(fragment);
  }

  /**
   * The flat strings and values of `fragment`'s raw tree, read in one pass
   * over the raw fragments, so a nested Sql is never flattened itself.
   */
  private static project(fragment: Sql): SqlProjection {
    const strings: string[] = [];
    const values: Value[] = [];
    let current = "";
    const walk = (
      rawStrings: readonly string[],
      rawValues: readonly RawValue[],
      template: boolean
    ): void => {
      current += stringAt(rawStrings, 0, template);
      for (let i = 0; i < rawValues.length; i++) {
        const child = rawValues[i]!;
        if (child instanceof Sql) {
          walk(child.rawStrings, child.rawValues, child.template);
        } else {
          values.push(child);
          strings.push(current);
          current = "";
        }
        current += stringAt(rawStrings, i + 1, template);
      }
    };
    walk(fragment.rawStrings, fragment.rawValues, fragment.template);
    strings.push(current);
    return { strings, values };
  }

  /**
   * The text of a fragment that holds no value and no fragment (a
   * `sql.raw`), read without composing anything; `undefined` for any other.
   */
  static leafText(fragment: Sql): string | undefined {
    return fragment.rawValues.length === 0 ? fragment.rawStrings[0] : undefined;
  }

  /**
   * {@link peek}'s text, also cut where a fragment `opaque` accepts begins
   * and ends, each run saying whether it lies inside one: a reader rewriting
   * the text its owner wrote can leave the text another party wrote alone.
   * Without an opaque fragment the runs are {@link peek}'s strings.
   */
  static peekRuns(
    fragment: Sql,
    opaque: (fragment: Sql) => boolean
  ): { runs: { text: string; opaque: boolean }[]; values: Value[] } {
    const runs: { text: string; opaque: boolean }[] = [];
    const values: Value[] = [];
    let current = "";
    let inside = false;
    const cut = (next: boolean): void => {
      if (next === inside) return;
      runs.push({ text: current, opaque: inside });
      current = "";
      inside = next;
    };
    const walk = (node: Sql, within: boolean): void => {
      const here = within || opaque(node);
      cut(here);
      current += stringAt(node.rawStrings, 0, node.template);
      for (let i = 0; i < node.rawValues.length; i++) {
        const child = node.rawValues[i]!;
        if (child instanceof Sql) {
          walk(child, here);
          cut(here);
        } else {
          values.push(child);
          runs.push({ text: current, opaque: inside });
          current = "";
        }
        current += stringAt(node.rawStrings, i + 1, node.template);
      }
    };
    walk(fragment, false);
    runs.push({ text: current, opaque: inside });
    return { runs, values };
  }

  /**
   * Visit `fragment` and every fragment composed into it, outermost first.
   * A flattened fragment holds no fragment any more: only its own visit.
   */
  static each(fragment: Sql, visit: (node: Sql) => void): void {
    visit(fragment);
    for (const child of fragment.rawValues)
      if (child instanceof Sql) Sql.each(child, visit);
  }

  /** `slot`'s text replaced by `content`'s (see {@link SqlSlot.settle}). */
  protected static fill(slot: Sql, content: Sql): void {
    slot.rawStrings = ["", ""];
    slot.rawValues = [content];
  }

  /**
   * Flatten the raw fragment tree ({@link project}). The flat arrays then
   * replace the raw tree as the canonical representation, releasing child
   * fragments that are not referenced elsewhere.
   */
  private flatten(): SqlProjection {
    if (this.projection !== undefined) {
      return this.projection;
    }

    const projection = Sql.project(this);

    this.rawStrings = projection.strings;
    this.rawValues = projection.values;
    this.template = false;
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
 *   keywords. Interpolations are refused; use `sql` for bound values.
 */
function raw(value: string | readonly string[]): Sql;
function raw(
  strings: string | readonly string[],
  ...values: readonly RawValue[]
): Sql {
  if (
    values.length !== 0 ||
    (typeof strings !== "string" && strings.length !== 1)
  )
    throw new TypeError(
      "raw templates cannot interpolate values; use sql for parameters or raw(trustedText) for explicit SQL text."
    );
  if (typeof strings === "string") {
    return new Sql([strings], []);
  }
  return new Sql(strings, [], true);
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
  return new Sql(strings, values, true);
}

const sqlTag = Object.assign(sql, { raw, empty, join });

export { empty, join, raw, sqlTag as sql };

/**
 * Type guard for Sql fragments. Structural check rather than instanceof so it
 * also matches fragments from a duplicated module instance. A document with
 * strings/values arrays is data; executable SQL also has the renderer method.
 */
export function isSql(value: unknown): value is Sql {
  if (value instanceof Sql) return true;
  if (value === null || typeof value !== "object") return false;

  const strings = Reflect.get(value, "strings");
  if (!Array.isArray(strings)) return false;

  const values = Reflect.get(value, "values");
  return (
    Array.isArray(values) &&
    strings.length === values.length + 1 &&
    strings.every((part) => typeof part === "string") &&
    typeof Reflect.get(value, "toStatement") === "function"
  );
}
