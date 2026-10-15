import { Sql, type Value } from "./sql";

/**
 * A statement with equal values bound once and referenced by number (`?NNN`
 * on SQLite, `$n` on PostgreSQL), for a driver whose bind budget the plain
 * statement exceeds. It is rendered, never composed: only {@link values} and
 * {@link toStatement} are read from it. Primitives are equal by value, a
 * `Date` by its instant, anything else by identity.
 */
export class NumberedSql extends Sql {
  readonly #text: string;
  readonly #distinct: Value[];
  constructor(source: Sql, placeholder: "$" | "?") {
    super([""], []);
    const strings = source.strings;
    const distinct: Value[] = [];
    const positions = new Map<unknown, number>();
    let text = strings[0]!;
    for (const [index, value] of source.values.entries()) {
      const key =
        value instanceof Date
          ? `date:${value.getTime()}`
          : value === null ||
              (typeof value !== "object" && typeof value !== "function")
            ? `${typeof value}:${String(value)}`
            : value;
      let position = positions.get(key);
      if (position === undefined) {
        position = distinct.push(value);
        positions.set(key, position);
      }
      text += `${placeholder}${position}${strings[index + 1]!}`;
    }
    this.#text = text;
    this.#distinct = distinct;
  }
  override get values(): Value[] {
    return this.#distinct;
  }
  override toStatement(): string {
    return this.#text;
  }
}
