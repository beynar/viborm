import { NestedWriteError, UnsupportedOperationError } from "@errors";
import { bindRelation } from "./builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type ParsedRecordPrograms,
  type RelationMutationEntry,
  type RelationMutationProgram,
} from "./builders/relation-mutation-parser";
import { createQueryScope, getPrimaryKeyFields } from "./context/query-scope";
import { classifyRelationKeyScalarUpdate } from "./TargetConstraint";
import type { QueryScope } from "./types";

/**
 * EVERY relation key one parsed record `data` writes — ordinary and polymorphic
 * alike — in the order the parser produced them.
 *
 * THE ONE OWNER of the question "does this data carry relation writes", because
 * asking it of `relations` ALONE is a measured silent wrong answer. A DIRECT
 * polymorphic mutation whose resolved intent is a targetless `disconnect` produces
 * NO relation program (`buildPolymorphicMutationProgram` returns `{ mutation }`
 * with no `program`), so it lives only in `polymorphic` — and three readers used
 * to look past it. Measured at HEAD on PGlite, before this predicate existed:
 *
 *   author.update({ data: { posts: { updateMany: {
 *     where: { draft: true }, data: { body: "x", subject: { disconnect: true } },
 *   } } } })
 *     ->  UPDATE "gd_posts" SET "body" = $1 WHERE (…authorId… AND …draft…)
 *         SELECT … FROM "gd_authors" …
 *
 * The wall did not fire, the private `(type, id)` pair was left in place, and the
 * call SUCCEEDED having cleared nothing. The ordinary spelling of the same shape
 * (`author: { disconnect: true }`) refuses at the schema. So this function reads
 * BOTH maps, and every site that decides "relation-bearing" reads it rather than a
 * map of its own — the blind spot was three copies of one question, not three
 * independent judgements.
 *
 * A `polymorphic` entry always means the data named a polymorphic relation key:
 * the parser adds one per polymorphic payload, targeted or disconnecting. The
 * targeted ones ALSO appear in `relations`, hence the de-duplication.
 */
export function relationWriteKeys(
  parsed: ParsedRecordPrograms
): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(parsed.relations),
      ...Object.keys(parsed.polymorphic),
    ]),
  ];
}

/**
 * V1's updateMany-data relation legality (P6 pure-leaf extraction, consumed by
 * V2): a nested relation write inside `updateMany` data is inexpressible, rejected
 * before any effect with the byte-identical typed message. `relationKeys` is
 * {@link relationWriteKeys} of one updateMany input's parsed `data`.
 */
export function assertUpdateManyRelationsAreCompilable(
  relationName: string,
  relationKeys: readonly string[]
): void {
  if (relationKeys.length === 0) return;
  throw new NestedWriteError(
    `Nested relation writes inside updateMany data for relation '${relationName}' are not supported.`,
    relationName,
    { meta: { operation: "updateMany", relations: [...relationKeys] } }
  );
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
  relations: Readonly<Record<string, RelationMutationProgram>>
): { readonly relationName: string; readonly kind: string } | undefined {
  for (const program of Object.values(relations)) {
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
 * Reject relation writes carried by any direct `updateMany` entry in one
 * selected-record update. Callers own when this check runs so an untaken upsert
 * arm remains inert.
 */
export function assertUpdateManyDataRelationsAreCompilable(
  source: QueryScope,
  relations: Readonly<Record<string, RelationMutationProgram>>
): void {
  const invalid = findRelationBearingUpdateManyData(source, relations);
  if (!invalid) return;
  assertUpdateManyRelationsAreCompilable(
    invalid.relationName,
    invalid.relationKeys
  );
}

/**
 * THE owner of "nested bulk data carries relation writes" (Package O, cluster 2).
 *
 * A set-based UPDATE publishes no per-row identity a descendant write can correlate
 * to, so a nested `updateMany` accepts scalar data only (ATOM §17; Package L
 * measured both lifts and both were rejected, so this wall stands).
 *
 * ONE construction site, TWO nouns. The junction and ordinary wordings used to be
 * two throw tokens of the same decision, and two more copies stood downstream in
 * `RelationJunctionPart.scalarOnly` and `RelationWritePart.parseScalarUpdateData`.
 * All three are gone; both shipped sentences survive here byte-identically, chosen
 * from `invalid.isJunction`, because a message noun is not a second decision.
 */
export function assertSelectedUpdateManyDataIsScalar(
  source: QueryScope,
  relations: Readonly<Record<string, RelationMutationProgram>>
): void {
  const invalid = findRelationBearingUpdateManyData(source, relations);
  if (!invalid) return;
  throw new UnsupportedOperationError(
    invalid.isJunction
      ? `query-engine-v2 nested 'updateMany' on many-to-many relation '${invalid.relationName}' does not support nested relation writes in its data.`
      : `query-engine-v2 updateMany for relation '${invalid.relationName}' does not support nested relation writes in its data.`
  );
}

/*
 * D2 — `assertPinnedTransitionIsCompilable` lived here and is DELETED. It refused a
 * selected target that transitions a row-key member the locator does not pin while a
 * deeper non-cascading edge references that member, because the engine could not name
 * the member's pre-transition value: "…transitions the target primary key '<field>'
 * while writing a deeper edge whose foreign key does not cascade on update; it must
 * locate the target by that primary key."
 *
 * `RecordUpdateCompiler.interpretReferencedKeyTransition` now names it — the located
 * row supplies every member's OLD value and `postTransitionReference` derives every
 * member's NEW value — so the refusal has a compiling answer and its five eager arm-side
 * call sites are gone with it. Its domain was also strictly NARROWER than the compiler's
 * (row-key members only, and it matched a parent-held membership's
 * `referencedFields`, which name the TARGET's columns rather than the selected
 * model's, by name across two models).
 */

function findRelationBearingUpdateManyData(
  source: QueryScope,
  relations: Readonly<Record<string, RelationMutationProgram>>
):
  | {
      readonly relationName: string;
      readonly relationKeys: readonly string[];
      readonly isJunction: boolean;
    }
  | undefined {
  for (const program of Object.values(relations)) {
    const relation = bindRelation(source, program.relationInfo);
    const target = createQueryScope(
      source.adapter,
      program.relationInfo.targetModel
    );
    for (const entry of program.entries) {
      if (entry.kind !== "updateMany") continue;
      for (const input of entry.items) {
        const nested = relationWriteKeys(
          buildParsedRelationPrograms(target, input.data)
        );
        if (nested.length > 0) {
          return {
            relationName: program.relationInfo.name,
            relationKeys: nested,
            isJunction: relation.position === "junction",
          };
        }
      }
    }
  }
  return undefined;
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
  relations: Record<string, RelationMutationProgram>
): void {
  const primaryKeyFields = new Set(getPrimaryKeyFields(ctx.model));

  for (const mutation of Object.values(relations)) {
    const relation = bindRelation(ctx, mutation.relationInfo);
    if (relation.position === "junction") continue;
    const relationKeyFields =
      relation.position === "parentHeld"
        ? relation.membership.foreignFields
        : relation.membership.referencedFields;
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
