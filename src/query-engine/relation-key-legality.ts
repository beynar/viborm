import { NestedWriteError, UnsupportedOperationError } from "@errors";
import {
  bindRelation,
  membershipReferencedFields,
} from "./builders/relation-data-builder";
import {
  type ParsedRecordPrograms,
  type ParsedRelationMutation,
  type RelationMutationEntry,
  relationMutationPrograms,
} from "./builders/relation-mutation-parser";
import { getPrimaryKeyFields } from "./context/query-scope";
import { classifyRelationKeyScalarUpdate } from "./TargetConstraint";
import type { QueryScope } from "./types";

/**
 * EVERY relation key one parsed record `data` writes — ordinary and polymorphic
 * alike — in the order the parser produced them (ordinary keys, then polymorphic).
 *
 * THE ONE OWNER of the question "does this data carry relation writes", and the
 * reason it is a named function rather than an inline key count is a measured
 * defect. A DIRECT polymorphic mutation whose resolved intent is a targetless
 * `disconnect` produces NO relation program — it is one empty private storage
 * assignment — so when it travelled in a companion map beside the programs, three
 * readers asking the program map alone looked straight past it. Measured at HEAD on
 * PGlite, before this predicate existed:
 *
 *   author.update({ data: { posts: { updateMany: {
 *     where: { draft: true }, data: { body: "x", subject: { disconnect: true } },
 *   } } } })
 *     ->  UPDATE "gd_posts" SET "body" = $1 WHERE (…authorId… AND …draft…)
 *         SELECT … FROM "gd_authors" …
 *
 * The wall did not fire, the private `(type, id)` pair was left in place, and the
 * call SUCCEEDED having cleared nothing. The ordinary spelling of the same shape
 * (`author: { disconnect: true }`) refuses at the schema.
 *
 * The parsed collection now carries that disconnect as its own arm, so this is one
 * key per entry with no union and no de-duplication to forget. What survives from
 * the defect is the OWNERSHIP: every site that decides "relation-bearing" asks this
 * function, because the blind spot was three copies of one question, not three
 * independent judgements. The returned order is the parser's relation-key order.
 */
export function relationWriteKeys(
  parsed: ParsedRecordPrograms
): readonly string[] {
  return parsed.relations.map((entry) => entry.name);
}

/**
 * The first membership move in one record `data` that CANNOT be applied to more
 * than one source row: a CHILD-HELD edge whose entry NAMES at least one existing
 * target (plan §5.2). Returns `undefined` when the data carries none.
 *
 * TWO CONDITIONS, and both are load-bearing.
 *
 * CHILD-HELD, because the target row stores the membership and can store exactly
 * one. A parent-held edge — including a direct polymorphic one, whose `(type, id)`
 * pair is a column of the SOURCE — gives every source row its own copy, and a
 * junction stores memberships in a third table that admits many parents. Both are
 * meaningful for any number of source rows.
 *
 * NAMES A TARGET, because the contention is over a NAMED row. `connect`,
 * `connectOrCreate` and `set` are the three verbs that move an EXISTING target's
 * stored membership — but each of them also has an EMPTY spelling that names
 * nobody: `set: []` means "this source row keeps no targets", and `connect: []` /
 * `connectOrCreate: []` mean nothing at all. Those are per-source-row facts, they
 * are exactly what the same payload does when it is spelled as one ordinary update
 * per row, and refusing them would refuse a payload with no contention in it
 * (measured: `set: []` at one row disconnects that row's children, so at N rows it
 * disconnects each row's own). The count is read from the entry rather than from
 * the raw payload so that every spelling the parser normalizes — a bare object, a
 * one-element array, a list — is counted the same way.
 *
 * The caller owns the refusal and its wording, because the caller is the one that
 * knows how many source rows it has; this function owns only which shapes are the
 * subject of it. `create` is deliberately outside: a fresh target per source row is
 * N targets, each owned by its own row.
 */
export function findSingleTargetMembershipMove(
  source: QueryScope,
  relations: readonly ParsedRelationMutation[]
): { readonly relationName: string; readonly kind: string } | undefined {
  for (const program of relationMutationPrograms(relations)) {
    if (bindRelation(source, program.relationInfo).position !== "childHeld") {
      continue;
    }
    for (const entry of program.entries) {
      if (namedTargetCount(entry) > 0) {
        return { relationName: program.relationInfo.name, kind: entry.kind };
      }
    }
  }
  return undefined;
}

/**
 * Refuse one named child-held target membership applied to several selected
 * source records. The parsed shape owner identifies the move; this boundary owns
 * the observed record count and the one public explanation of why it is ambiguous.
 */
export function assertSingleTargetMembershipMoveAppliesToRecords(
  source: QueryScope,
  relations: readonly ParsedRelationMutation[],
  recordCount: number
): void {
  if (recordCount < 2) return;
  const move = findSingleTargetMembershipMove(source, relations);
  if (!move) return;
  throw new UnsupportedOperationError(
    `updateMany matched ${recordCount} rows, so it cannot apply '${move.kind}' to relation '${move.relationName}': that membership is stored on the target row, which can belong to only one of them — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`
  );
}

/**
 * How many EXISTING targets an entry names, for the three verbs that move a stored
 * membership; zero for every other verb. Exhaustive over the parsed entry union, so
 * a new verb is a compile error here rather than a silently unclassified shape.
 */
function namedTargetCount(entry: RelationMutationEntry): number {
  switch (entry.kind) {
    case "connect":
    case "set":
      return entry.targets.length;
    case "connectOrCreate":
      return entry.items.length;
    default:
      return 0;
  }
}

/**
 * V1's relation-key referential-action legality (P6 pure-leaf extraction, consumed
 * by V2): a relation key field mutated with a non-literal operation while its
 * relation is being written is rejected before any effect with the byte-identical
 * typed message.
 */
export function assertRelationKeyUpdatesAreCompilable(
  ctx: QueryScope,
  scalarData: Record<string, unknown>,
  relations: readonly ParsedRelationMutation[]
): void {
  const primaryKeyFields = new Set(getPrimaryKeyFields(ctx.model));

  for (const mutation of relationMutationPrograms(relations)) {
    const relation = bindRelation(ctx, mutation.relationInfo);
    if (relation.position === "junction") continue;
    // POSITION, not holder identity — a self-relation holds both ends. This must
    // also stay OFF `membership.members`: pairing refuses mismatched arity, and
    // this refusal is pinned to answer FIRST.
    const relationKeyFields =
      relation.position === "parentHeld"
        ? relation.membership.foreignFields
        : membershipReferencedFields(relation.membership);
    for (const field of relationKeyFields) {
      if (scalarData[field] === undefined) continue;
      if (primaryKeyFields.has(field) && relation.position !== "parentHeld") {
        continue;
      }
      if (classifyRelationKeyScalarUpdate(scalarData[field]).resolved) continue;

      throw new NestedWriteError(
        `Cannot update relation key field '${field}' with a non-literal operation while mutating relation '${mutation.relationInfo.name}'. Use a literal value or '{ set: ... }'.`,
        mutation.relationInfo.name,
        {
          meta: {
            operation: "update",
            field,
            relation: mutation.relationInfo.name,
          },
        }
      );
    }
  }
}
