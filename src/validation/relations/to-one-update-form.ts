// The two spellings of a to-one nested `update` payload (Prisma 5) — W4-U3.

import { QueryEngineError } from "@errors";

/**
 * Prisma 5 accepts TWO spellings for a nested `update` on a **to-one** relation:
 *
 *   bare      `{ author: { update: { name: "x" } } }`
 *   wrapped   `{ author: { update: { where: { active: true }, data: { name: "x" } } } }`
 *
 * The wrapper's `where` is a **non-unique** `WhereInput`. It does not choose among
 * candidates — a to-one has exactly one connected record — it FILTERS that record:
 * the currently connected row must satisfy it, and if it does not the whole
 * operation aborts with the not-found class, state unchanged.
 *
 * DISAMBIGUATION. An object carrying a `data` key whose value is a plain object has
 * the envelope's SHAPE. On almost every target that shape is unambiguous, because
 * `data` is not one of the target's own update keys and the bare reading could not
 * validate — so the shape IS the envelope, exactly as Prisma reads it.
 *
 * On a target that owns a field (or relation) literally named `data` — a JSON
 * document column being the common case — the same shape has TWO meanings, and they
 * write different columns:
 *
 *   `update: { data: { label: "x" } }`   envelope → sets the target's `label`
 *                                        bare     → stores `{ label: "x" }` in `data`
 *
 * Neither reading can be preferred without silently doing something other than what
 * the caller wrote, and "whichever one happens to validate" would make the FORM
 * depend on the DATA — the identical spelling meaning one thing for `{ seed: true }`
 * and another for `{ label: "x" }`. So this collision is REFUSED
 * ({@link AMBIGUOUS_TO_ONE_UPDATE}), and the refusal names the two unambiguous
 * spellings, both of which go through the explicit envelope:
 *
 *   `update: { where: {}, data: { … } }`          update the target's fields
 *   `update: { where: {}, data: { data: … } }`    write the target's `data` field
 *
 * A `where` key is what makes the envelope explicit (a to-one update payload has no
 * `where` of its own, so the key cannot be bare data), and an empty `where`
 * constrains nothing. A non-object payload for a `data`-named field
 * (`update: { data: 5 }`, the scalar shorthand, or any class instance — a Date, a
 * Decimal, a `JsonNull` sentinel) never had the envelope's shape and stays bare, at
 * the root and at every depth.
 *
 * The rule reads the USER's payload and is applied EXACTLY ONCE, by the schema
 * ({@link file://./update.ts}). Its output is the canonical envelope
 * ({@link ToOneUpdateEnvelope}) for BOTH spellings, so no later reader has to
 * re-derive the form. That is not a convenience — it is the only correct design:
 * an output is not a faithful witness of the form, because `core.update` rewrites
 * scalar shorthands, so a model owning a field named `data` turns the BARE
 * `{ data: 7 }` into `{ data: { set: 7 } }`, which has the envelope's shape. The
 * engine sees only outputs one level deep (the enclosing whole-args parse already
 * normalized the tree), so a second application of the rule there necessarily
 * DISAGREED with the schema's — the depth regression W4-U3's fix round closed. One
 * home, one application, at the parse boundary.
 *
 * RESIDUAL, documented: a target owning a field named `where` cannot use the bare
 * spelling for it either — `{ where: …, data: … }` is read as the envelope. Reach
 * such a field through the envelope's `data`.
 */

/** The three readings of a to-one nested `update` payload. */
export type ToOneUpdateForm = "bare" | "envelope" | "ambiguous";

/**
 * The refusal for the one shape that has two honest meanings. Stated as the two
 * spellings that do not, because a caller who hits this needs the way out, not the
 * taxonomy.
 */
export const AMBIGUOUS_TO_ONE_UPDATE =
  "Ambiguous to-one nested `update`: `{ data: … }` reads both as the `{ where?, data }` envelope and as bare update data for this target's own `data` field. Spell the envelope out — `update: { where: {}, data: { … } }` updates the target's fields (put a filter in `where` to make it conditional), and `update: { where: {}, data: { data: … } }` writes its `data` field." as const;

/**
 * Decide which spelling a to-one `update` payload is, from the USER's payload.
 *
 * @param value - the payload as written by the caller
 * @param targetOwnsDataField - whether the target's update schema has its own
 *   `data` key. When it does, the envelope's shape is ambiguous unless the payload
 *   also carries `where`.
 */
export function readToOneUpdateForm(
  value: unknown,
  targetOwnsDataField: boolean
): ToOneUpdateForm {
  if (!hasEnvelopeShape(value)) return "bare";
  if (!targetOwnsDataField) return "envelope";
  // `where` is not an update key, so it cannot be bare data: it says "envelope"
  // out loud. Prisma parity: an explicit `undefined` is an absent key.
  if (value.where !== undefined) return "envelope";
  return "ambiguous";
}

/**
 * The canonical output of a to-one nested `update` payload — what the schema emits
 * for BOTH spellings. The bare spelling yields `{ data }`; the wrapper additionally
 * carries its non-unique `where`.
 *
 * The envelope is IDEMPOTENT under re-parse (it always reads as the envelope the
 * second time round), which is what lets the X1c nested-target delegation re-parse
 * an already-parsed subtree without changing its meaning.
 */
export interface ToOneUpdateEnvelope {
  readonly data: Record<string, unknown>;
  readonly where?: unknown;
}

/**
 * Wrap a parsed BARE payload in the canonical envelope. The wrapper spelling is
 * already in envelope shape and is emitted as parsed.
 *
 * On a target that owns a `data` field the plain `{ data }` envelope would re-read
 * as AMBIGUOUS — the re-parse cannot see that this object is a schema OUTPUT rather
 * than a caller's payload. So for those targets the canonical envelope carries the
 * same `where` marker a caller would have to write: an empty, constraint-free one.
 * {@link splitToOneUpdateTarget} drops an empty `where`, so not one compiled step
 * changes.
 */
export function toOneUpdateEnvelope(
  data: Record<string, unknown>,
  targetOwnsDataField: boolean
): ToOneUpdateEnvelope {
  return targetOwnsDataField ? { where: {}, data } : { data };
}

/** A to-one `update` payload resolved to its two halves: the update `data`, and the
 *  optional non-unique `filter` the connected record must satisfy. The bare spelling
 *  yields no filter — byte-identical to the pre-W4-U3 reading. An empty wrapper
 *  `where` (`{}`) constrains nothing, so it is dropped rather than compiled into a
 *  vacuous `AND` term. */
export interface ToOneUpdateTarget {
  readonly data: Record<string, unknown>;
  readonly filter?: Record<string, unknown>;
}

/**
 * Read a to-one `update` schema output into its data and its optional filter.
 *
 * This is a projection of the canonical envelope, NOT a second application of the
 * disambiguation rule — the form was decided once, at the parse boundary, from the
 * user's own payload. Every caller reaches this with a value the to-one relation
 * update schema produced (the update root parses `data.<relation>` per relation;
 * every deeper reader consumes that same output, and the nested-target delegation
 * re-parses it into an identical envelope), so a non-envelope here is a broken
 * invariant rather than a user error — it fails closed.
 */
export function splitToOneUpdateTarget(parsed: unknown): ToOneUpdateTarget {
  if (!hasEnvelopeShape(parsed)) {
    throw new QueryEngineError(
      "query-engine-v2 expected a canonical to-one update envelope ({ data, where? }) from the relation update schema."
    );
  }
  const where = parsed.where;
  if (!(isPlainObject(where) && Object.keys(where).length > 0)) {
    return { data: parsed.data };
  }
  return { data: parsed.data, filter: where };
}

/** The envelope's SHAPE — a `data` key holding a plain object. Not the form: on a
 *  target owning a `data` field this shape is also how bare data spells that field,
 *  which is what {@link readToOneUpdateForm} arbitrates. */
function hasEnvelopeShape(value: unknown): value is {
  readonly data: Record<string, unknown>;
  readonly where?: unknown;
} {
  return (
    isPlainObject(value) &&
    Object.hasOwn(value, "data") &&
    isPlainObject(value.data)
  );
}

/** A PLAIN object — an object literal, or one made with a null prototype. A class
 *  instance is deliberately excluded: a `Date`, a `Decimal`, a `Uint8Array` or a
 *  `JsonNull` sentinel written against a `data`-named field is a VALUE, and reading
 *  it as an envelope would hand the target's update schema an object with no keys. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
