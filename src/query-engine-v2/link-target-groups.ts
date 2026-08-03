import {
  getWhereUniqueEntries,
  partitionWhereUnique,
  type WhereUniqueEntry,
} from "../query-engine/builders/where-unique-builder";
import type { QueryScope } from "../query-engine/types";

/**
 * The IN-list fold for the link families (query-performance-plan Phase 4).
 *
 * `connect: [a, b, c]` used to send one probe and one write PER TARGET — six
 * statements for three targets. The targets are all complete unique keys of one
 * child model, so one `SELECT … WHERE key IN (a,b,c) FOR UPDATE` and one
 * `UPDATE … WHERE key IN (a,b,c)` do the same work in two. This module holds the
 * three things every folding call site needs, so the rule that decides what may
 * share a statement lives in ONE place: {@link RelationLinkPart} (the
 * connect/disconnect Part of the update family) and `ChildConnectPart` (the
 * create tree's child-held connect) both read it.
 *
 * What the fold does NOT change: the probe is still a planning read whose rows
 * `compile(known)` consumes, so the Pin Rule is untouched — only the `WHERE` is
 * wider. The batch presence guards stay per target. The missing-target error
 * keeps its text, its attribution and its phase.
 */

/**
 * Split one relation's link targets into **key-shape groups** — the unit a Part
 * folds into a single probe and a single write. Order is preserved: groups
 * appear in the order their first member did, and a group holds its members in
 * input order. A one-member group is the arity-1 case, and every call site is
 * required to keep its statements byte-identical to the pre-fold spelling there.
 *
 * Two targets share a group only when the fold can be proved to change nothing:
 *
 * - **The same discriminator columns.** `{ id }` and `{ email }` name rows
 *   through different unique constraints, so they are different IN lists.
 * - **No extra filter half.** An extended selector (`{ id, archived: false }`,
 *   W4/N6-U1) carries a PREDICATE as well as an identity, and two targets'
 *   predicates need not agree; an IN list over their identities would apply one
 *   target's predicate to another target's row. Such a target keeps its own
 *   group.
 * - **Primitive key values only.** The missing-target verdict counts distinct
 *   keys ({@link countDistinctTargets}), and that count has to agree with what
 *   SQL considers one row. For a string, number, boolean or bigint, JS equality
 *   and SQL equality agree. For a `Date`, a byte array or any other object, two
 *   values SQL calls equal are distinct objects in JS — a repeated target would
 *   be counted twice and a present row reported missing. Those keys keep the
 *   per-target path rather than risk a false rejection.
 */
export function groupLinkTargets(
  childScope: QueryScope,
  items: readonly Record<string, unknown>[]
): Record<string, unknown>[][] {
  const groups: {
    key: string | undefined;
    wheres: Record<string, unknown>[];
  }[] = [];
  for (const where of items) {
    const key = foldableShapeKey(childScope, where);
    const existing =
      key === undefined ? undefined : groups.find((group) => group.key === key);
    if (existing) existing.wheres.push(where);
    else groups.push({ key, wheres: [where] });
  }
  return groups.map((group) => group.wheres);
}

/**
 * The one `WHERE` that names every target in a group: `key IN (…)` for a
 * single-column unique, an `OR` of complete compound equalities otherwise.
 * Callers must not use it for a one-member group — there the caller's own
 * `where` goes through verbatim, which is what keeps the arity-1 SQL unmoved.
 */
export function linkGroupSelector(
  childScope: QueryScope,
  wheres: readonly Record<string, unknown>[]
): Record<string, unknown> {
  const entriesPerTarget = wheres.map((where) =>
    getWhereUniqueEntries(childScope, where)
  );
  const first = entriesPerTarget[0]!;
  if (first.length === 1) {
    const fieldName = first[0]!.fieldName;
    return {
      [fieldName]: { in: entriesPerTarget.map((entries) => entries[0]!.value) },
    };
  }
  return {
    OR: entriesPerTarget.map((entries) => ({
      AND: entries.map(({ fieldName, value }) => ({
        [fieldName]: { equals: value },
      })),
    })),
  };
}

/**
 * How many DISTINCT rows a group's members can name — the number the probe's row
 * count is compared against to decide the missing-target error.
 *
 * The comparison is exact rather than approximate: each member is a complete
 * unique key, so the group's selector names at most one row per distinct key and
 * the probe returns exactly as many rows as there are distinct keys that exist.
 * Fewer rows than distinct keys means at least one named target is not there.
 * Nothing here compares a DECODED column value against an input value, which is
 * why a repeated target (`connect: [{ id: 1 }, { id: 1 }]` — one row, two
 * entries) still succeeds. Values are primitives by {@link groupLinkTargets}'s
 * gate, so tagging each with its JS type makes the canonical form injective over
 * exactly what SQL treats as one row.
 */
export function countDistinctTargets(
  childScope: QueryScope,
  wheres: readonly Record<string, unknown>[]
): number {
  if (wheres.length <= 1) return wheres.length;
  const seen = new Set<string>();
  for (const where of wheres) {
    seen.add(canonicalTargetKey(getWhereUniqueEntries(childScope, where)));
  }
  return seen.size;
}

/** The group identity of a target, or `undefined` when it may not be folded. */
function foldableShapeKey(
  childScope: QueryScope,
  where: Record<string, unknown>
): string | undefined {
  const { entries, filters } = partitionWhereUnique(childScope, where);
  if (filters) return undefined;
  if (!entries.every((entry) => isComparableKeyValue(entry.value))) {
    return undefined;
  }
  return JSON.stringify(entries.map((entry) => entry.fieldName));
}

function isComparableKeyValue(value: unknown): boolean {
  const type = typeof value;
  return (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "bigint"
  );
}

function canonicalTargetKey(entries: readonly WhereUniqueEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => [
      entry.fieldName,
      typeof entry.value,
      String(entry.value),
    ])
  );
}
