// The two spellings of a to-one nested `update` payload (Prisma 5) — W4-U3.

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
 * STRUCTURAL, not try-this-then-that. That matters twice:
 *  - a malformed wrapper reports the wrapper's own error instead of a union-wide
 *    "matched no member" miss, and
 *  - the query engine can apply the IDENTICAL rule to the raw payload it sees one
 *    level deeper, where no schema output exists to normalize it. A try-order union
 *    would silently disagree with a structural engine rule on the collision below.
 *
 * COLLISION RULE (documented, deliberate): a target model with a field literally
 * named `data` cannot be written through the BARE spelling when that field's payload
 * is an object — `update: { data: { set: … } }` always reads as the wrapper. Reach
 * such a field through the explicit wrapper instead:
 *
 *   `update: { data: { data: { set: … } } }`
 *
 * A non-object payload for that field (`update: { data: 5 }`, the scalar shorthand)
 * is unambiguous and still reads as bare data. Prisma has the same ambiguity and
 * resolves it the same way.
 *
 * This module is THE one home for the rule: the relation update schema
 * ({@link file://./update.ts}) dispatches on it, and the query engine splits every
 * to-one `update` payload with {@link splitToOneUpdateTarget}.
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

/** A to-one `update` payload resolved to its two halves: the update `data`, and the
 *  optional non-unique `filter` the connected record must satisfy. The bare spelling
 *  yields the payload itself as `data` and no filter — byte-identical to the
 *  pre-W4-U3 reading. An empty wrapper `where` (`{}`) constrains nothing, so it is
 *  dropped rather than compiled into a vacuous `AND` term. */
export interface ToOneUpdateTarget {
  readonly data: Record<string, unknown>;
  readonly filter?: Record<string, unknown>;
}

/**
 * Split a to-one `update` payload into its data and its optional filter.
 *
 * The FORM is decided from `raw` — the user's own payload — never from a schema
 * output, because an output is not a faithful witness of the form: `core.update`
 * rewrites a scalar shorthand, so a model that owns a field named `data` turns the
 * BARE `{ data: 7 }` into the output `{ data: { set: 7 } }`, which the structural
 * rule would then misread as the wrapper. The VALUES come from `parsed`: the
 * relation schema's output at an update ROOT, and the same raw payload one level
 * deeper (where the enclosing whole-args parse already validated the tree and no
 * per-relation output exists) — hence `raw` defaulting to `parsed`.
 *
 * Both halves must agree before the wrapper reading is taken, so a bare payload
 * whose OUTPUT merely resembles a wrapper stays bare.
 */
export function splitToOneUpdateTarget(
  parsed: Record<string, unknown>,
  raw: unknown = parsed
): ToOneUpdateTarget {
  if (!(isToOneUpdateWrapper(raw) && isToOneUpdateWrapper(parsed))) {
    return { data: parsed };
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
