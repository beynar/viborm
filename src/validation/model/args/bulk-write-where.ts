import type { ValidationIssue, VibSchema } from "@validation/types";
import { isRecord } from "@validation/value-guards";

/**
 * A bulk write whose `where` was emptied by `undefined` is refused.
 *
 * An `undefined` member is an absent member (Prisma's rule, and the object
 * primitive's: `{ f: undefined }` ≡ `{}`). On a read that is a convenience; on
 * `deleteMany({ where: { tenantId } })` with `tenantId` undefined it deleted
 * every row. So a bulk write — root `updateMany` / `deleteMany`, and the same
 * verbs nested in a relation write, where "every row" is every related row —
 * whose `where` matches every row ONLY because members spelled `undefined`
 * were dropped is refused, naming them. `where: {}`, `{ AND: [] }` and no
 * `where` at all still mean every row: nothing was dropped to get there.
 *
 * "Matches every row" is the engine's reading of the logical skeleton
 * (`combine` in raptor3's `query.ts`): an arm that states nothing is absent
 * from `AND` and `NOT` and from `OR`, an `OR` with no arm left is FALSE, and
 * a to-many `every` over a body that states nothing is a stated TRUE (an
 * `OR` keeps it as an arm). A
 * scalar filter, a `some` / `none` / `is` / `isNot`, a `$if` or `$exists` is a
 * condition whatever its body (`{ author: { id: undefined } }` still asks that
 * an author exists). A filter object whose operations are all `undefined`
 * (`{ id: { equals: undefined } }`, `{ name: { mode: "insensitive" } }`,
 * `{ author: { is: undefined } }`) never reaches here: its own schema refuses
 * it on every operation (`requireFilterOperation`,
 * `requireRelationQuantifier`). The where is read twice, members spelled
 * `undefined` dropped and then counted as conditions: the refusal is exactly
 * the calls whose first reading matches every row and whose second does not.
 */

/** No stated predicate; a stated constant; a real condition. */
const VACANT = 0;
const TRUE = 1;
const FALSE = 2;
const CONDITION = 3;
type Truth = typeof VACANT | typeof TRUE | typeof FALSE | typeof CONDITION;

const matchesEveryRow = (truth: Truth): boolean =>
  truth === VACANT || truth === TRUE;

/** `AND` of two arms; a vacant arm is absent. */
const and = (left: Truth, right: Truth): Truth =>
  left === FALSE || right === FALSE
    ? FALSE
    : left === CONDITION || right === CONDITION
      ? CONDITION
      : left === TRUE || right === TRUE
        ? TRUE
        : VACANT;

/** `AND` over arms. */
const conjunction = (arms: readonly Truth[]): Truth => arms.reduce(and, VACANT);

/** `NOT` of one arm: a constant flips, the rest stay. */
const negation = (arm: Truth): Truth =>
  arm === TRUE ? FALSE : arm === FALSE ? TRUE : arm;

/** `OR` over arms; a vacant arm is absent and no arm left is FALSE. */
const disjunction = (arms: readonly Truth[]): Truth => {
  let truth: Truth = FALSE;
  for (const arm of arms) {
    if (arm === TRUE) return TRUE;
    if (arm === CONDITION) truth = CONDITION;
  }
  return truth;
};

/**
 * What a where states. `dropped` collects the paths of members spelled
 * `undefined` when given; without it they count as conditions. At the top
 * (`path` empty) a member that is a condition or FALSE already decides that
 * the where does not match every row, so the walk stops there: an ordinary
 * bulk write reads one key.
 */
function truthOf(
  where: unknown,
  path: string,
  dropped: string[] | undefined
): Truth {
  if (!isRecord(where)) return CONDITION;
  let truth: Truth = VACANT;
  for (const key in where) {
    const value = where[key];
    const at = path === "" ? key : `${path}.${key}`;
    if (value === undefined) {
      if (!dropped) return CONDITION;
      dropped.push(at);
      continue;
    }
    truth = and(truth, memberTruth(key, value, at, dropped));
    if (path === "" && !matchesEveryRow(truth)) return truth;
  }
  return truth;
}

function memberTruth(
  key: string,
  value: unknown,
  at: string,
  dropped: string[] | undefined
): Truth {
  if (key === "AND" || key === "OR" || key === "NOT") {
    const clauses = Array.isArray(value) ? value : [value];
    const arms = clauses.map((clause, index) =>
      truthOf(clause, Array.isArray(value) ? `${at}[${index}]` : at, dropped)
    );
    if (key === "AND") return conjunction(arms);
    if (key === "OR") return disjunction(arms.filter((arm) => arm !== VACANT));
    return conjunction(arms.map(negation));
  }
  // A filter whose only quantifier is `every` (no scalar filter has an
  // `every` operator, so this is a to-many relation filter): every related
  // row satisfies a body that states nothing or always holds, and the engine
  // states that as a predicate which is always true.
  if (isRecord(value) && value.every !== undefined) {
    for (const quantifier of Object.keys(value)) {
      if (quantifier === "every") continue;
      if (value[quantifier] !== undefined) return CONDITION;
      if (!dropped) return CONDITION;
      dropped.push(`${at}.${quantifier}`);
    }
    const body = truthOf(value.every, `${at}.every`, dropped);
    return matchesEveryRow(body) ? TRUE : CONDITION;
  }
  return CONDITION;
}

/**
 * The paths of the members spelled `undefined` when dropping them is what
 * makes `where` match every row; `undefined` otherwise.
 */
function undefinedOnlyWhere(where: unknown): string[] | undefined {
  const dropped: string[] = [];
  if (!matchesEveryRow(truthOf(where, "", dropped))) return undefined;
  if (dropped.length === 0) return undefined;
  return matchesEveryRow(truthOf(where, "", undefined)) ? undefined : dropped;
}

/**
 * `schema`, refusing a bulk write whose where {@link undefinedOnlyWhere}
 * empties. `member` names the key that holds the where in each payload
 * (`"where"`), or is absent when the payload IS the where (a nested
 * `deleteMany`); a payload may be one item or a list. Asked after the
 * schema admitted the payload, so its shape is already the where's.
 */
export function refusingUndefinedOnlyWhere<S extends VibSchema<any, any>>(
  schema: S,
  operation: "updateMany" | "deleteMany",
  nested: boolean,
  member?: "where"
): S {
  const standard = schema["~standard"] as {
    validate: (value: unknown) => unknown;
  };
  const admit = standard.validate;
  const rows = nested ? "every related row" : "every row";
  const effect = `${nested ? "This nested " : ""}${operation} would ${operation === "deleteMany" ? "delete" : "update"} ${rows}`;
  standard.validate = (value: unknown) => {
    const result = admit(value) as { issues?: unknown };
    if (result.issues) return result;
    const items = Array.isArray(value) ? value : [value];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const where = member ? (isRecord(item) ? item[member] : undefined) : item;
      const keys = undefinedOnlyWhere(where);
      if (!keys) continue;
      const path: PropertyKey[] = Array.isArray(value) ? [index] : [];
      if (member) path.push(member);
      const issue: ValidationIssue = {
        message: `${effect}: its where names only undefined values (${keys.join(", ")}), and an undefined value is no condition. Remove them, or pass where: {} to mean ${rows}.`,
        path,
      };
      return { issues: [issue] };
    }
    return result;
  };
  return schema;
}
