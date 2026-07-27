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
 * DISAMBIGUATION (Prisma's rule, reproduced): an object carrying a `data` key whose
 * value is a plain object IS the wrapper; anything else is bare data. The rule is
 * STRUCTURAL, not try-this-then-that, so a malformed wrapper reports the wrapper's
 * own error instead of a union-wide "matched no member" miss.
 *
 * The rule reads the USER's payload and is applied EXACTLY ONCE, by the schema
 * ({@link file://./update.ts}). Its output is the canonical envelope
 * ({@link ToOneUpdateEnvelope}) for BOTH spellings, so no later reader has to
 * re-derive the form. That is not a convenience — it is the only correct design:
 * an output is not a faithful witness of the form, because `core.update` rewrites
 * scalar shorthands, so a model owning a field named `data` turns the BARE
 * `{ data: 7 }` into `{ data: { set: 7 } }`, which the structural rule reads as the
 * wrapper. The engine sees only outputs one level deep (the enclosing whole-args
 * parse already normalized the tree), so a second application of the rule there
 * necessarily DISAGREED with the schema's — the depth regression W4-U3's fix round
 * closed. One home, one application, at the parse boundary.
 *
 * COLLISION RULE (documented, deliberate): a target model with a field literally
 * named `data` cannot be written through the BARE spelling when that field's payload
 * is an object — `update: { data: { set: … } }` always reads as the wrapper. Reach
 * such a field through the explicit wrapper instead:
 *
 *   `update: { data: { data: { set: … } } }`
 *
 * A non-object payload for that field (`update: { data: 5 }`, the scalar shorthand)
 * is unambiguous and still reads as bare data — at the root and at every depth.
 * Prisma has the same ambiguity and resolves it the same way.
 */
export function isToOneUpdateWrapper(value: unknown): value is {
  readonly data: Record<string, unknown>;
  readonly where?: unknown;
} {
  return (
    isPlainObject(value) &&
    Object.hasOwn(value, "data") &&
    isPlainObject(value.data)
  );
}

/**
 * The canonical output of a to-one nested `update` payload — what the schema emits
 * for BOTH spellings. The bare spelling yields `{ data }`; the wrapper additionally
 * carries its non-unique `where`.
 *
 * The envelope is IDEMPOTENT under re-parse (it always takes the wrapper arm the
 * second time round), which is what lets the X1c nested-target delegation re-parse
 * an already-parsed subtree without changing its meaning.
 */
export interface ToOneUpdateEnvelope {
  readonly data: Record<string, unknown>;
  readonly where?: unknown;
}

/** Wrap a parsed BARE payload in the canonical envelope. The wrapper spelling is
 *  already in envelope shape and is emitted as parsed. */
export function toOneUpdateEnvelope(
  data: Record<string, unknown>
): ToOneUpdateEnvelope {
  return { data };
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
  if (!isToOneUpdateWrapper(parsed)) {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
