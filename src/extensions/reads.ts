/**
 * What a row predicate reads of the row it judges: asked where a write is
 * judged again only if it changes what its judgement reads.
 */
import type { PreparedPredicate } from "@query-engine/raptor3/shared/query";
import { hopFieldsOf } from "@query-engine/raptor3/shared/storage";

/**
 * Whether `predicate`, judged over a row of `model`, may read one of
 * `fields` of that row: an operation's column or field operand, a
 * relation's own side of its link (a junction's: the row's keys). Anything
 * it cannot answer for (an aggregate, a window) reads them all. A row that
 * differs from another only outside what a predicate reads gets the same
 * answer from it, against the same rows.
 */
export function readsAny(
  predicate: PreparedPredicate,
  fields: ReadonlySet<string>,
  keys: readonly string[]
): boolean {
  switch (predicate.kind) {
    case "and":
    case "or":
      return predicate.predicates.some((member) =>
        readsAny(member, fields, keys)
      );
    case "not":
    case "layer":
      return readsAny(predicate.predicate, fields, keys);
    case "always":
    case "condition":
      return false;
    case "exists":
      return (
        predicate.predicate !== undefined &&
        readsAbove(predicate.predicate, fields, 1)
      );
    case "operation": {
      if (predicate.target.kind !== "column") return true;
      const operands = [predicate.operand, ...(predicate.operands ?? [])];
      return (
        fields.has(predicate.target.scalar.field) ||
        operands.some(
          (operand) =>
            (operand?.kind === "field" && fields.has(operand.scalar.field)) ||
            (operand?.kind === "sql" &&
              operand.operands.some(
                (member) =>
                  member.kind === "field" && fields.has(member.scalar.field)
              ))
        )
      );
    }
    case "relation": {
      const { edge } = predicate;
      const own = edge.kind === "reference" ? hopFieldsOf(edge) : keys;
      return (
        own.some((field) => fields.has(field)) ||
        (predicate.predicate !== undefined &&
          readsAbove(predicate.predicate, fields, 1))
      );
    }
    default:
      return true;
  }
}
/**
 * Whether a relation body `depth` bodies below the judged row compares one of
 * `fields` of that row (`{ $row, up: depth }`): the row's new value changes
 * its answer as surely as a column of its own does. An `$exists` body is a
 * root of its own and reads no row outside it.
 */
function readsAbove(
  predicate: PreparedPredicate,
  fields: ReadonlySet<string>,
  depth: number
): boolean {
  switch (predicate.kind) {
    case "and":
    case "or":
      return predicate.predicates.some((member) =>
        readsAbove(member, fields, depth)
      );
    case "not":
    case "layer":
      return readsAbove(predicate.predicate, fields, depth);
    case "relation":
    case "exists":
      return (
        predicate.predicate !== undefined &&
        readsAbove(predicate.predicate, fields, depth + 1)
      );
    case "operation":
      return [predicate.operand, ...(predicate.operands ?? [])].some(
        (operand) =>
          operand?.kind === "field" &&
          operand.up === depth &&
          fields.has(operand.scalar.field)
      );
    case "always":
    case "condition":
      return false;
    default:
      return true;
  }
}
