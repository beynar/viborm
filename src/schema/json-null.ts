/**
 * JSON null sentinels (Prisma `DbNull` / `JsonNull` / `AnyNull` parity)
 *
 * A nullable JSON column has TWO different nulls, and SQL can tell them apart
 * while JavaScript cannot:
 *
 *  - the SQL NULL — the column holds no document at all (`col IS NULL`);
 *  - the JSON null — the column holds a document, and that document is the
 *    JSON value `null` (`'null'::jsonb`, `CAST('null' AS JSON)`, the text
 *    `null` on SQLite).
 *
 * Both read back as JavaScript `null`, so a bare `null` cannot name either one
 * without guessing. Prisma solves this with three exported sentinel values, and
 * so does this file:
 *
 * ```ts
 * import { AnyNull, DbNull, JsonNull } from "viborm";
 *
 * await client.entry.update({ where, data: { meta: DbNull } });   // -> SQL NULL
 * await client.entry.update({ where, data: { meta: JsonNull } }); // -> 'null'
 * await client.entry.findMany({ where: { meta: { equals: AnyNull } } });
 * ```
 *
 * `AnyNull` is FILTER-ONLY, exactly as in Prisma: "either null" is a question,
 * not a value, so there is nothing for a write to store. The validation layer
 * refuses it in write position by name (see
 * {@link file://../validation/primitives/json-null.ts}).
 *
 * THE TOKENS ARE CLASS INSTANCES ON PURPOSE. `v.json()` accepts a plain object
 * with any keys, so a plain-object token would type-check as an ordinary JSON
 * document and could be PERSISTED as user data — the same hazard field
 * references have (see {@link file://./field-ref.ts}). A class instance has a
 * prototype that is not `Object.prototype`, so `isJsonValue` rejects it
 * structurally: a sentinel nested anywhere inside a document
 * (`{ a: DbNull }`) fails validation instead of landing in the column as `{}`.
 * Only the top-level operand positions that explicitly opt in accept one.
 *
 * The `kind` property is an OWN ENUMERABLE STRING key, not only the symbol
 * brand, so every structural serializer in the codebase tells the three apart
 * without knowing this module exists — the cache key builder
 * ({@link file://../cache/key.ts}) walks `Object.keys`, and three tokens that
 * all stringified to `{}` would collide `equals: DbNull` with
 * `equals: JsonNull` in one cache entry.
 */

/**
 * Brand carried by every JSON null sentinel. `Symbol.for` (not a fresh symbol)
 * so a token stays recognizable across duplicated module instances, exactly as
 * for field references.
 */
export const JSON_NULL_BRAND: unique symbol = Symbol.for("viborm.json-null");

/** The three sentinels, by name. */
export type JsonNullKind = "DbNull" | "JsonNull" | "AnyNull";

/**
 * A JSON null sentinel. `TKind` is what makes `AnyNull` unassignable to a write
 * slot while `DbNull` and `JsonNull` are assignable to it.
 */
export class JsonNullSentinel<TKind extends JsonNullKind = JsonNullKind> {
  readonly [JSON_NULL_BRAND]: TKind;
  /** Own enumerable key so structural serializers separate the three. */
  readonly kind: TKind;

  constructor(kind: TKind) {
    this[JSON_NULL_BRAND] = kind;
    this.kind = kind;
    Object.freeze(this);
  }

  /** Readable in error messages: `DbNull`, not `[object Object]`. */
  toString(): string {
    return this.kind;
  }

  /** Distinct under `JSON.stringify` (instrumentation, dedup keys). */
  toJSON(): string {
    return `viborm.json-null:${this.kind}`;
  }
}

/** Any sentinel, regardless of kind. */
export type AnyJsonNullSentinel = JsonNullSentinel<JsonNullKind>;

/** The database NULL: the column holds no JSON document. */
export const DbNull: JsonNullSentinel<"DbNull"> = new JsonNullSentinel(
  "DbNull"
);

/** The JSON null: the column holds the JSON document `null`. */
export const JsonNull: JsonNullSentinel<"JsonNull"> = new JsonNullSentinel(
  "JsonNull"
);

/** Either null. Filter positions only — see the module header. */
export const AnyNull: JsonNullSentinel<"AnyNull"> = new JsonNullSentinel(
  "AnyNull"
);

const KINDS: ReadonlySet<string> = new Set<JsonNullKind>([
  "DbNull",
  "JsonNull",
  "AnyNull",
]);

/**
 * Runtime brand check. A property probe rather than `instanceof`, so a token
 * created by a duplicated copy of this module is still recognized (the same
 * reason {@link file://./field-ref.ts} probes its symbol).
 */
export function isJsonNullSentinel(
  value: unknown
): value is AnyJsonNullSentinel {
  if (typeof value !== "object" || value === null) return false;
  const brand = (value as { [JSON_NULL_BRAND]?: unknown })[JSON_NULL_BRAND];
  return typeof brand === "string" && KINDS.has(brand);
}

/** The sentinel's kind, or `undefined` when the value is not a sentinel. */
export function jsonNullKindOf(value: unknown): JsonNullKind | undefined {
  return isJsonNullSentinel(value) ? value.kind : undefined;
}
