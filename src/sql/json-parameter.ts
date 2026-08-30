/**
 * One JSON document, bound as one statement parameter.
 *
 * PostgreSQL's JSON literals bind CANONICAL JSON TEXT and let the server cast
 * that text from the parameter's column context. Nothing at the driver can
 * tell that text apart from an ordinary string, so every transport that
 * re-serializes a `json`/`jsonb` parameter has to be told not to, and only some
 * of them offer a place to say it: postgres.js takes a `json` type override
 * (`src/drivers/postgres/index.ts`), PGlite's own JSON serializer already
 * passes strings through, and node-postgres/Neon never touch a string. Bun SQL
 * offers no such hook and JSON-ENCODES a string bound to a `json`/`jsonb`
 * parameter, storing the physical document `"[1,2,3]"` — a JSON string — where
 * `[1,2,3]` was meant (upstream Drizzle #5287).
 *
 * This carrier is the missing distinction, and it needs no per-transport hook:
 * a PostgreSQL transport can only reach a bound value through string coercion
 * or through JSON serialization, and this renders as its canonical text under
 * BOTH. The text captured at construction is the ONE stored fact: `toJSON`
 * answers it parsed back, and `JSON.stringify` of its own output re-serializes
 * to those exact bytes, so both protocols agree even if the caller mutates the
 * original value after binding.
 * Bun, which serializes an object parameter for a `json`/`jsonb` column with
 * `JSON.stringify`, therefore stores the exact document for every JSON type,
 * including the number, boolean and null primitives that no bare JavaScript
 * value can express to it (a JS number is bound as `integer`, `null` as SQL
 * NULL).
 *
 * `json` is an own property rather than a private field because it is what a
 * parameter snapshot shows: diagnostics read own properties, so an opted-in
 * `includeParams` disclosure keeps the document instead of reporting `{}`.
 */
export class JsonParameter {
  /** The canonical JSON text — `JSON.stringify(value)`. */
  readonly json: string;

  private constructor(json: string) {
    this.json = json;
    Object.freeze(this);
  }

  /**
   * The carrier for `value`, or `undefined` when `JSON.stringify` has no text
   * for it (`undefined`, a function, a symbol). Those bound `undefined`
   * directly before this carrier existed, which providers send as SQL NULL;
   * carrying them would bind the text `"undefined"` instead.
   */
  static from(value: unknown): JsonParameter | undefined {
    // The lib signature says `string`, which is only true for the values it can
    // represent.
    const json: string | undefined = JSON.stringify(value);
    return json === undefined ? undefined : new JsonParameter(json);
  }

  toString(): string {
    return this.json;
  }

  toJSON(): unknown {
    return JSON.parse(this.json);
  }
}
