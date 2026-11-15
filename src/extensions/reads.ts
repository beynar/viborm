/**
 * What a row predicate reads of the row it judges: asked where a write is
 * judged again only if it changes what its judgement reads.
 */
import type { PreparedPredicate } from "@query-engine/raptor3/shared/query";
import { hopFieldsOf } from "@query-engine/raptor3/shared/storage";

/**
 * Whether `predicate`, judged over a row of `model`, may read one of
 * `fields` of that row: an operation's column or field operand, a
 * relation's own side of its link (a junction's: the row's keys), and in a
 * relation body `depth` bodies below the row, an operand that compares one
 * of them (`row(field, depth)`); an `exists` body is a root of its own and
 * reads only those. Anything it cannot answer for (an aggregate, a window)
 * reads them all. A row that differs from another only outside what a
 * predicate reads gets the same answer from it, against the same rows.
 */
export function readsAny(
  predicate: PreparedPredicate,
  fields: ReadonlySet<string>,
  keys: readonly string[],
  depth = 0
): boolean {
  switch (predicate.kind) {
    case "and":
    case "or":
      return predicate.predicates.some((member) =>
        readsAny(member, fields, keys, depth)
      );
    case "not":
    case "layer":
      return readsAny(predicate.predicate, fields, keys, depth);
    case "always":
    case "condition":
      return false;
    case "relation":
      return (
        (depth === 0 &&
          (predicate.edge.kind === "reference"
            ? hopFieldsOf(predicate.edge)
            : keys
          ).some((field) => fields.has(field))) ||
        (predicate.predicate !== undefined &&
          readsAny(predicate.predicate, fields, keys, depth + 1))
      );
    case "exists":
      return (
        predicate.predicate !== undefined &&
        readsAny(predicate.predicate, fields, keys, depth + 1)
      );
    case "operation": {
      const operands = [predicate.operand, ...(predicate.operands ?? [])];
      const field = (operand: (typeof operands)[number]) =>
        operand?.kind === "field" &&
        (depth === 0 || operand.up === depth) &&
        fields.has(operand.scalar.field);
      if (depth > 0) return operands.some(field);
      return (
        predicate.target.kind !== "column" ||
        fields.has(predicate.target.scalar.field) ||
        operands.some(
          (operand) =>
            field(operand) ||
            (operand?.kind === "sql" &&
              operand.operands.some(
                (member) =>
                  member.kind === "field" && fields.has(member.scalar.field)
              ))
        )
      );
    }
    default:
      return true;
  }
}
