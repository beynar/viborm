/**
 * Direct polymorphic COLLECTION read.
 *
 * One statement, one JSON document, one branch per configured variant in
 * DECLARATION ORDER — `storage.members` is an insertion-ordered `Map` and is the
 * single ordering truth (plan §7.2: "allow-list order never changes result
 * order"). The statement grows only with variant count: there is no per-owner and
 * no per-variant execution loop.
 *
 * CORRELATED, NOT LATERAL, on every adapter (decision D3). The carrier must be
 * ONE JSON value per relation column because `ResultParser.createPolymorphicChain`
 * calls `adapter.result.parseRelation(value, "polymorphic", …)` exactly once per
 * relation value, and MySQL runs `tryParseJsonString` over that whole value —
 * splitting arms across sibling columns would leave every arm undecoded there and
 * on text-returning SQLite drivers. The correlated scalar-subquery form yields
 * that document naturally; a lateral form would change `buildPolymorphicRead`'s
 * bare-`Sql` signature through two call branches and would need new byte pins on
 * two lateral-capable dialects (MySQL declares `supportsLateralJoins: true`).
 *
 * THE VALIDATED SELECTION CONTRACT — the one cross-boundary agreement with the
 * operation-schema half. A validated collection selection is either `true` /
 * `false` verbatim, or
 *
 *     { only?: readonly string[]; variants?: { [publicType]: <arm node> } }
 *
 * where `only` is already deduplicated and canonicalized into DECLARATION ORDER
 * at the parse boundary, and every `variants` key is inside a present `only`.
 * This builder reads `only` and `variants` and NOTHING else.
 */

import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { createChildScope } from "../context";
import {
  POLYMORPHIC_COLLECTION_ARMS_KEY,
  POLYMORPHIC_COLLECTION_MEMBERSHIP_KEY,
  POLYMORPHIC_COLLECTION_ORPHANS_KEY,
  POLYMORPHIC_COLLECTION_ROWS_KEY,
  POLYMORPHIC_RESULT_STATE_COLLECTION,
  POLYMORPHIC_RESULT_STATE_KEY,
  POLYMORPHIC_RESULT_STATE_LINKED,
} from "../result-aliases";
import type { QueryScope, VariantJunctionCarrierSlot } from "../types";
import type { BuildNestedSelection } from "./include-builder";
import { assembleInnerQuery, type IncludeOptions } from "./include-query";
import { buildNestedReadWindow } from "./nested-read-window";
import { buildPolymorphicMemberIntegrityParts } from "./polymorphic-member-join-parts";
import { polymorphicMemberMembership } from "./relation-data-builder";
import { buildMembershipJunctionTraversal } from "./relation-traversal";

/**
 * The validated collection selection, read through the one contract above.
 *
 * `undefined` for `only` is "every configured variant" — absent and explicitly
 * `undefined` are the same request, which is what the operation schema already
 * normalizes.
 */
export interface PolymorphicCollectionSelection {
  readonly only: readonly string[] | undefined;
  readonly variants: Readonly<Record<string, unknown>> | undefined;
}

export function readCollectionSelection(
  projection: unknown
): PolymorphicCollectionSelection {
  if (!isRecord(projection)) return { only: undefined, variants: undefined };
  const only = projection.only;
  const variants = projection.variants;
  return {
    only: Array.isArray(only)
      ? only.filter((value): value is string => typeof value === "string")
      : undefined,
    variants: isRecord(variants) ? variants : undefined,
  };
}

/** Whether one configured arm emits its visible-row branch. */
export function isArmVisible(
  selection: PolymorphicCollectionSelection,
  publicType: string
): boolean {
  return selection.only ? selection.only.includes(publicType) : true;
}

/** Build a direct polymorphic collection projection as one correlated JSON document. */
export function buildPolymorphicCollectionRead(
  buildNestedSelection: BuildNestedSelection,
  scope: QueryScope,
  relation: VariantJunctionCarrierSlot,
  projection: unknown,
  parentAlias: string
): Sql {
  const { adapter } = scope;
  const selection = readCollectionSelection(projection);
  const textLiteral = (value: string) =>
    adapter.expressions.cast(adapter.literals.value(value), "text");

  const arms: [string, Sql][] = [];
  for (const member of relation.edge.members) {
    const publicType = member.variant;
    // Alias spend order is SQL bytes: the two junction aliases are taken here,
    // in the member loop, exactly as the row-held builder takes its target
    // alias — before any nested selection or nested where of this arm.
    const membership = polymorphicMemberMembership(member.topology, "owner");
    const traversal = buildMembershipJunctionTraversal(
      scope,
      () => membership,
      "many",
      parentAlias
    );

    // INTEGRITY FIRST, for EVERY configured member — allow-listed or not. An
    // orphan in a member table excluded by `only` still fails the carrier.
    // The traversal's own two conditions, in its own order: correlation, then
    // the junction/target join.
    const [correlationCondition, joinCondition] = traversal.conditions();
    const integrity = buildPolymorphicMemberIntegrityParts(
      scope,
      membership,
      correlationCondition,
      joinCondition,
      traversal.junctionAlias,
      traversal.targetAlias
    );

    const rows = isArmVisible(selection, publicType)
      ? buildVisibleArmRows(
          buildNestedSelection,
          scope,
          member.topology.target.model,
          selection.variants?.[publicType],
          publicType,
          traversal
        )
      : // An excluded arm emits NO visible-row branch at all. Its `rows` is
        // SQL NULL by construction, which the parser tells apart from an empty
        // allow-listed arm structurally — through the shape, never the value.
        adapter.literals.null();

    arms.push([
      publicType,
      adapter.json.objectFromColumns([
        [POLYMORPHIC_COLLECTION_MEMBERSHIP_KEY, integrity.membership],
        [POLYMORPHIC_COLLECTION_ORPHANS_KEY, integrity.orphans],
        [POLYMORPHIC_COLLECTION_ROWS_KEY, rows],
      ]),
    ]);
  }

  return adapter.json.objectFromColumns([
    [
      POLYMORPHIC_RESULT_STATE_KEY,
      textLiteral(POLYMORPHIC_RESULT_STATE_COLLECTION),
    ],
    [
      POLYMORPHIC_COLLECTION_ARMS_KEY,
      adapter.json.document(adapter.json.objectFromColumns(arms)),
    ],
  ]);
}

/**
 * One allow-listed arm's visible rows: that arm's nested scope, that arm's read
 * window, aggregated into an array of linked envelopes.
 *
 * The window is ARM-LOCAL by construction — `where`, `orderBy`, `cursor`,
 * `take`, `skip` and `distinct` all come from this arm's node and apply to this
 * arm's joined target rows only. There is no global heterogeneous order: two
 * unrelated models share no scalar ordering domain.
 */
function buildVisibleArmRows(
  buildNestedSelection: BuildNestedSelection,
  scope: QueryScope,
  targetModel: Model<any>,
  armNode: unknown,
  publicType: string,
  traversal: ReturnType<typeof buildMembershipJunctionTraversal>
): Sql {
  const { adapter } = scope;
  const options: IncludeOptions = isRecord(armNode) ? armNode : {};
  const { targetAlias } = traversal;
  const childCtx = createChildScope(scope, targetModel, targetAlias);

  const jsonExpr = buildNestedSelection(
    childCtx,
    isRecord(options.select) ? options.select : undefined,
    isRecord(options.include) ? options.include : undefined
  ).sql;

  // The SAME envelope shape the row-held carrier emits, so the parser reuses
  // `LINKED_KEYS` and `hasExactKeys` verbatim. The `type` literal is ONE bound
  // parameter per arm, never per row.
  const linked = adapter.json.objectFromColumns([
    [
      POLYMORPHIC_RESULT_STATE_KEY,
      adapter.expressions.cast(
        adapter.literals.value(POLYMORPHIC_RESULT_STATE_LINKED),
        "text"
      ),
    ],
    [
      "type",
      adapter.expressions.cast(adapter.literals.value(publicType), "text"),
    ],
    ["data", adapter.json.document(jsonExpr)],
  ]);

  const window = buildNestedReadWindow(
    childCtx,
    options,
    targetAlias,
    traversal.conditions()
  );

  const jsonColAlias = "_json";
  const innerQuery = assembleInnerQuery(adapter, {
    selectExpr: adapter.identifiers.aliased(linked, jsonColAlias),
    from: traversal.from(),
    joins: window.joins,
    where: window.where,
    orderBy: window.orderBy,
    take: window.limit,
    skip: window.offset,
    distinct: window.distinct,
    distinctColumnAliases: [jsonColAlias],
  });

  const subAlias = scope.nextAlias();
  return adapter.subqueries.scalar(
    sql.join(
      [
        adapter.clauses.select(
          adapter.json.agg(adapter.identifiers.column(subAlias, jsonColAlias))
        ),
        adapter.clauses.from(
          sql`(${innerQuery}) ${adapter.identifiers.escape(subAlias)}`
        ),
      ],
      " "
    )
  );
}
