/**
 * Owns bound relation topology and the surviving connect lookup subquery.
 * Parsed mutation meaning belongs to relation-mutation-parser; record and edge
 * effects belong to the write engine.
 */

import { getModelKeyCatalog, type Model } from "@schema/model";
import type { ReferentialAction, RelationSlot } from "@schema/relation";
import type {
  ResolvedJunctionSide,
  ResolvedJunctionTopology,
} from "@schema/relation/junction-topology";
import type {
  ResolvedRelationEdge,
  ResolvedSlot,
  ResolvedVariantJunctionMember,
  ResolvedVariantRowEdge,
  ResolvedVariantRowMember,
  ResolvedVariantRowStorage,
} from "@schema/validation/relation-resolution";
import { type Sql, sql } from "@sql";
import { createChildScope, getColumnName, getTableName } from "../context";
import {
  isVariantJunctionInverse,
  isVariantRowInverse,
  QueryEngineError,
  type QueryScope,
  type RelationRef,
} from "../types";
import {
  hideMutationTarget,
  readsMutationTarget,
} from "./mutation-target-subquery";
import { buildWhereUnique } from "./where-unique-builder";

interface BoundRelationBase {
  readonly relationRef: RelationRef;
  readonly sourceModel: Model<any>;
}

/** One foreign-key column paired with the column it references. */
export interface ForeignKeyMemberPair {
  readonly foreignField: string;
  readonly referencedField: string;
}

/**
 * Membership stored as ordinary foreign-key columns: the holder's columns in
 * schema order, and the columns they reference, member for member.
 */
export interface BoundForeignKeyMembership {
  readonly kind: "foreignKey";
  /** The model whose row stores these foreign-key columns. */
  readonly holder: Model<any>;
  /** The model those columns reference. Equal to {@link holder} on a self-relation. */
  readonly referenced: Model<any>;
  readonly foreignFields: readonly string[];
  readonly referencedFields: readonly string[];
  /**
   * The two field lists paired member for member, in schema order — the
   * resolved edge's own pair list, which is what the other two are projected
   * FROM. It used to be paired lazily here because pairing was also where a
   * mismatched arity was refused; `.references(...)` refuses an unequal pair at
   * construction now (V4002), so there is nothing left to defer.
   *
   * Schema order, not the canonical order membership-scope equality compares on:
   * those are two different orders on the same data, and the scope sorts its own.
   */
  readonly members: readonly ForeignKeyMemberPair[];
  readonly onUpdate: ReferentialAction | undefined;
}

/**
 * Membership stored in a polymorphic `(type, id)` column pair. The stored type is
 * a FIXED QUALIFIER of the membership rather than a referenced key member, so the
 * reference itself is the single id column — hence the one-member tuple and the
 * singular referenced field.
 */
export interface BoundPolymorphicMembership {
  readonly kind: "polymorphic";
  /** The model whose row stores the private `(type, id)` pair. */
  readonly holder: Model<any>;
  /** The model the id column references under this stored type. */
  readonly referenced: Model<any>;
  readonly foreignFields: readonly [string];
  readonly referencedField: string;
  /** A private polymorphic column pair declares no referential action. */
  readonly onUpdate: undefined;
  /** The carrier slot the private pair belongs to — its whole identity. */
  readonly carrier: RelationSlot;
  readonly storage: ResolvedVariantRowStorage;
  readonly storedType: string;
}

/**
 * One junction column and the field it references on the side's own model. The
 * pair is the junction's STORED REFERENCE to that side — not an answer to "what
 * is that model's row key", which the model-key catalog owns.
 */
export interface JunctionReferenceMember {
  readonly junctionField: string;
  readonly referencedField: string;
}

/**
 * One end of a junction: the model it addresses and the ordered junction columns
 * that reference its complete row key.
 */
export interface JunctionSide {
  readonly model: Model<any>;
  readonly members: readonly JunctionReferenceMember[];
}

/** Membership stored in a junction table: two complete ordered references. */
export interface BoundJunctionMembership {
  readonly kind: "junction";
  /** Junction table name — explicit `.through()` or the generated pair name. */
  readonly table: string;
  /** The end this relation is traversed FROM: `ctx.model` at bind time. */
  readonly source: JunctionSide;
  /** The end this relation is traversed TO: `relationRef.targetModel`. */
  readonly target: JunctionSide;
  /**
   * This is a polymorphic collection MEMBER table, not an ordinary pair table.
   *
   * A read leaf owes a member table an integrity carrier — the membership row
   * must be observable even when its target row is gone — which an ordinary
   * pair table does not get, so the flag is what keeps ordinary many-to-many
   * bytes unchanged while the member view gains the check.
   */
  readonly polymorphicMember?: true;
}

/** How a bound relation's membership is physically stored. */
export type BoundMembership =
  | BoundForeignKeyMembership
  | BoundPolymorphicMembership
  | BoundJunctionMembership;

/*
 * A bound relation answers THREE ORTHOGONAL questions, and each consumer asks
 * exactly the one it needs:
 *
 * - `position` — which row stores the membership. It decides placement and
 *   ownership: whether one membership can be shared by several source rows.
 * - `cardinality` — how many targets the public slot admits. It decides arity and
 *   public payload shape, nothing about storage.
 * - `membership` — how the membership is physically stored. It decides lowering:
 *   which columns are written, read and compared.
 *
 * The union still forbids the impossible combinations: a parent-held edge holds
 * one foreign-key tuple per source row and so is always to-one, and a junction row
 * set is always to-many. Both child-held storages admit either arity.
 *
 * Child-held is spelled as TWO ARMS rather than one arm with a union-typed
 * membership so that the membership axis narrows the relation as well as the
 * membership (a nested discriminant narrows only the reference it is read
 * through); the two arms are the axis intersections below, not cross-product
 * names, and nothing but the membership type distinguishes them.
 */
export type ParentHeldRelation = BoundRelationBase & {
  readonly position: "parentHeld";
  readonly cardinality: "one";
  readonly membership: BoundForeignKeyMembership;
};

export type OrdinaryChildHeldRelation = BoundRelationBase & {
  readonly position: "childHeld";
  readonly cardinality: "one" | "many";
  readonly membership: BoundForeignKeyMembership;
};

export type PolymorphicChildHeldRelation = BoundRelationBase & {
  readonly position: "childHeld";
  readonly cardinality: "one" | "many";
  readonly membership: BoundPolymorphicMembership;
};

/**
 * A relation the TARGET row stores the membership for, either way it is stored —
 * as opposed to a parent-held edge (the source row stores it) or a junction (a
 * third table does, and it admits many parents).
 */
export type ChildHeldRelation =
  | OrdinaryChildHeldRelation
  | PolymorphicChildHeldRelation;

export type JunctionBoundRelation = BoundRelationBase & {
  readonly position: "junction";
  /**
   * `"one"` exists for the variant member view: a non-owning `s.toOne` bound to
   * a collection carrier's member classifies as a SINGULAR junction, backed by
   * that member table's UNIQUE over the complete target side.
   * `bindMemberJunction` is its only producer — `bindJunctionRelation` writes
   * `"many"` unconditionally for every ordinary pair.
   */
  readonly cardinality: "one" | "many";
  readonly membership: BoundJunctionMembership;
};

export type BoundRelation =
  | ParentHeldRelation
  | ChildHeldRelation
  | JunctionBoundRelation;

/**
 * The NARROWING spelling of `relation.membership.kind === "polymorphic"`, for the
 * callers that must pass the relation itself into a polymorphic-only slot.
 *
 * It is not a second owner of the question: its body is that one test, and every
 * caller that only needs the answer asks `membership.kind` inline. It exists
 * because the membership axis is a nested discriminant — testing it narrows the
 * membership reference, never the relation holding it.
 */
export function hasPolymorphicMembership(
  relation: BoundRelation
): relation is PolymorphicChildHeldRelation {
  return relation.membership.kind === "polymorphic";
}

/**
 * The columns a ROW-HELD membership references, in schema order.
 *
 * A polymorphic membership references exactly one column — its stored type is a
 * fixed qualifier, not a referenced member — so the two storages spell the same
 * fact two ways. This projection is the one place that reads them as one; a
 * caller that already knows which storage it holds reads the field directly.
 */
export function membershipReferencedFields(
  membership: BoundForeignKeyMembership | BoundPolymorphicMembership
): readonly string[] {
  return membership.kind === "polymorphic"
    ? [membership.referencedField]
    : membership.referencedFields;
}

/**
 * Project one collection member's RESOLVED junction topology into the engine's
 * bound membership.
 *
 * There is no resolver here and there must not be one: the schema-wide gate
 * expanded this junction exactly once and stored it on the carrier edge, and
 * `ResolvedJunctionSide` already carries `{junctionField, referencedField}` — a
 * superset of {@link JunctionSide}. So this is a projection, never a second
 * owner (§11.5.9).
 *
 * @param from - which end the traversal STARTS at. The stored topology is
 *   always owner-side-`source`, variant-side-`target`; a traversal that starts
 *   at the variant (every inverse) reads the same table with the sides swapped.
 *   The table is the same table either way — one member junction, one owner.
 */
export function polymorphicMemberMembership(
  topology: ResolvedJunctionTopology,
  from: "owner" | "variant"
): BoundJunctionMembership {
  const owner: JunctionSide = junctionSide(topology.source);
  const variant: JunctionSide = junctionSide(topology.target);
  return {
    kind: "junction",
    table: topology.table,
    source: from === "owner" ? owner : variant,
    target: from === "owner" ? variant : owner,
    polymorphicMember: true,
  };
}

function junctionSide(side: ResolvedJunctionSide): JunctionSide {
  return { model: side.model, members: side.members };
}

/**
 * Bind one collection member's junction, oriented by where the traversal starts.
 *
 * The FIRST producer of `JunctionBoundRelation.cardinality === "one"`: a member
 * whose bound inverse is singular (`uniqueTarget`) is a singular junction,
 * physically backed by the UNIQUE over the complete target side.
 * `bindJunctionRelation` writes `"many"` unconditionally for ordinary pairs.
 */
export function bindMemberJunction(
  ctx: QueryScope,
  relationRef: RelationRef,
  member: ResolvedVariantJunctionMember,
  from: "owner" | "variant"
): JunctionBoundRelation {
  return {
    position: "junction",
    // MEMBER-LOCAL, and the SAME answer from either orientation: each variant's
    // inverse chose "one" or "many" independently, and a `"one"` member is the
    // singular slot whose replacement needs the transfer protocol — which the
    // OWNER-oriented bind is the only legal input to.
    cardinality: member.uniqueTarget ? "one" : "many",
    relationRef,
    sourceModel: ctx.model,
    membership: polymorphicMemberMembership(member.topology, from),
  };
}

/**
 * Bind the junction arm of {@link bindRelation}. Module-private: every caller
 * reaches it through {@link classifyRelation}, which is the one place that decides
 * a relation's storage is a junction.
 */
function bindJunctionRelation(
  ctx: QueryScope,
  relationRef: RelationRef,
  edge: Extract<ResolvedRelationEdge, { kind: "junction" }>,
  asking: RelationSlot
): JunctionBoundRelation {
  // The resolver oriented this topology from the pair's canonically FIRST
  // ENDPOINT, so a traversal that starts at the other one reads the same table
  // with the sides swapped — the same one-table/two-traversals rule the member
  // junction follows. The SLOT decides, not the model: a self junction names one
  // model on both sides and only its two fields tell the directions apart.
  const topology = edge.topology;
  const fromSource = isSlot(edge.endpoints[0], asking);
  return {
    position: "junction",
    cardinality: "many",
    relationRef,
    sourceModel: ctx.model,
    membership: {
      kind: "junction",
      table: topology.table,
      source: junctionSide(fromSource ? topology.source : topology.target),
      target: junctionSide(fromSource ? topology.target : topology.source),
    },
  };
}

/**
 * The complete ordered primary key of a junction endpoint.
 * The model-key catalog remains the sole owner of row-key membership and order.
 */
export function getRequiredPrimaryKeyFields(
  model: Model<any>
): readonly string[] {
  const modelName = getModelName(model);
  const rowKey = getModelKeyCatalog(model).rowKey?.fields;
  if (rowKey && rowKey.length > 0) {
    return rowKey;
  }

  throw new QueryEngineError(
    `Model "${modelName}" has no primary key. ` +
      "Many-to-many relations require a complete primary key."
  );
}

/** Model name for error messages. */
function getModelName(model: Model<any>): string {
  return model["~"].names.ts ?? model["~"].state.tableName ?? "unknown";
}

/**
 * The bound view of one resolved stored reference.
 *
 * The PAIRS are the input and the two flat lists are projected from them, so
 * the engine cannot hold a foreign list and a reference list of different
 * lengths: `.references(...)` refuses an unequal pair at construction (V4002),
 * and the resolver publishes `ResolvedStoredReference.members` as pairs.
 */
function buildForeignKeyMembership(
  holder: Model<any>,
  referenced: Model<any>,
  members: readonly ForeignKeyMemberPair[],
  onUpdate: ReferentialAction | undefined
): BoundForeignKeyMembership {
  return {
    kind: "foreignKey",
    holder,
    referenced,
    foreignFields: members.map((member) => member.foreignField),
    referencedFields: members.map((member) => member.referencedField),
    onUpdate,
    members,
  };
}

/**
 * The ONE construction of a polymorphic membership, for the inverse edge the
 * schema fixes and for the direct edge a payload's discriminator selects. Both
 * hand the same carrier edge and the same member; only which model holds the
 * private pair differs, and that is the caller's to state.
 */
export function buildPolymorphicMembership(
  holder: Model<any>,
  referenced: Model<any>,
  carrier: ResolvedVariantRowEdge,
  member: ResolvedVariantRowMember
): BoundPolymorphicMembership {
  return {
    kind: "polymorphic",
    holder,
    referenced,
    foreignFields: [carrier.storage.idColumn.name],
    referencedField: member.referencedField,
    onUpdate: undefined,
    carrier: carrier.carrier,
    storage: carrier.storage,
    storedType: member.entry.storedValue,
  };
}

/**
 * The engine's ONE classification of a relation's physical shape, handed back as a
 * value: which arm it is, and the bind whose TYPE is that arm's bound relation.
 *
 * A `ResolvedSlot` is a union whose discriminant is NESTED (`edge.kind`), so
 * testing it narrows the edge and not the slot. Returning the answer as a
 * discriminated pair is what lets a caller reach the narrowed construction with
 * no second test, no cast and no guard — {@link bindRelation} is itself defined
 * through it, so the estate holds exactly one spelling of the test.
 *
 * The bind is a THUNK because classification answers a question that must be asked
 * EARLIER than a bind may be paid: a read traversal classifies to know how many
 * aliases it spends, while binding a row-held relation pairs its stored reference
 * (and can refuse a mismatched arity). Callers that classify to place aliases must
 * not pay those refusals; callers that need the bound value call the thunk where
 * they need it.
 */
export type ClassifiedRelation =
  | { readonly kind: "junction"; readonly bind: () => JunctionBoundRelation }
  | {
      readonly kind: "rowHeld";
      readonly bind: () => ParentHeldRelation | ChildHeldRelation;
    };

/**
 * Classify one relation's physical shape relative to the current model.
 *
 * Every arm reads the RESOLVED EDGE. There is no inverse discovery here and no
 * declared family label: the gate already decided which endpoint owns the stored
 * reference, which pairs live in a junction, and which member of a carrier a
 * bound inverse views (§8.3).
 */
export function classifyRelation(
  ctx: QueryScope,
  relationRef: RelationRef
): ClassifiedRelation {
  const { resolved } = relationRef;
  const edge = resolved.edge;
  if (edge.kind === "junction") {
    return {
      kind: "junction",
      bind: () => bindJunctionRelation(ctx, relationRef, edge, resolved.slot),
    };
  }
  if (isVariantJunctionInverse(resolved)) {
    // A bound inverse of a collection carrier: its membership lives in that
    // member's junction table, whichever shape the asking slot was spelled with.
    const { member, edge: carrier } = resolved;
    return {
      kind: "junction",
      bind: () =>
        bindMemberJunction(
          ctx,
          relationRef,
          member,
          memberOrientation(carrier.carrier, resolved.slot)
        ),
    };
  }
  return {
    kind: "rowHeld",
    bind: () => bindRowHeldRelation(ctx, relationRef, resolved),
  };
}

/** Which end a member-junction traversal starts at. */
function memberOrientation(
  carrier: RelationSlot,
  asking: RelationSlot
): "owner" | "variant" {
  return isSlot(carrier, asking) ? "owner" : "variant";
}

/** `(model, field)` is the whole contextual identity of a slot. */
function isSlot(one: RelationSlot, other: RelationSlot): boolean {
  return one.source === other.source && one.field === other.field;
}

/** Bind one relation to its structural position relative to the current model. */
export function bindRelation(
  ctx: QueryScope,
  relationRef: RelationRef
): BoundRelation {
  return classifyRelation(ctx, relationRef).bind();
}

/**
 * Bind the arm whose membership one of the two ROWS stores.
 *
 * Three questions, all already answered on the edge: WHICH row holds the stored
 * reference (`edge.owner` for a foreign key, `edge.carrier` for a variant row),
 * WHICH columns it is, and which columns they reference. Nothing is discovered.
 */
function bindRowHeldRelation(
  ctx: QueryScope,
  relationRef: RelationRef,
  resolved: ResolvedSlot
): ParentHeldRelation | ChildHeldRelation {
  if (isVariantRowInverse(resolved)) {
    return bindVariantRowInverse(
      ctx,
      relationRef,
      resolved.edge,
      resolved.member
    );
  }
  const edge = resolved.edge;
  if (edge.kind !== "foreignKey") {
    // Structurally unreachable: `classifyRelation` sends junction and collection
    // carrier edges to the junction arm, and a carrier's own slot is never
    // addressed through an ordinary reference.
    throw new QueryEngineError(
      `query-engine-v2 internal: relation '${relationRef.name}' resolved to a ${edge.kind} edge on a row-held path.`
    );
  }
  const { owner, reference } = edge;
  const holdsReference = isSlot(owner, resolved.slot);
  if (holdsReference) {
    return {
      position: "parentHeld",
      cardinality: "one",
      relationRef,
      sourceModel: ctx.model,
      membership: buildForeignKeyMembership(
        ctx.model,
        relationRef.targetModel,
        reference.members,
        reference.onUpdate
      ),
    };
  }
  return {
    position: "childHeld",
    cardinality: relationRef.cardinality,
    relationRef,
    sourceModel: ctx.model,
    membership: buildForeignKeyMembership(
      relationRef.targetModel,
      ctx.model,
      reference.members,
      reference.onUpdate
    ),
  };
}

/**
 * Bind the inverse view of one row-carrier member — the private `(type, id)`
 * pair on the carrier's row, restricted to the stored value this member claims.
 */
function bindVariantRowInverse(
  ctx: QueryScope,
  relationRef: RelationRef,
  edge: ResolvedVariantRowEdge,
  member: ResolvedVariantRowMember
): PolymorphicChildHeldRelation {
  return {
    position: "childHeld",
    cardinality: relationRef.cardinality,
    relationRef,
    sourceModel: ctx.model,
    membership: buildPolymorphicMembership(
      relationRef.targetModel,
      ctx.model,
      edge,
      member
    ),
  };
}

/**
 * Build subquery to select a specific field for connect
 *
 * A caller that declares `mutationTable` (an UPDATE's `SET`, E1 U1/U2) gets the
 * lookup hidden behind a derived table when it reads the very table the statement
 * mutates — a SELF relation. MySQL refuses that read otherwise (ERROR 1093,
 * measured on 8.4.10); an INSERT's `VALUES` never declares a mutation table, so
 * the create root's spelling is byte-identical to before.
 */
export function buildConnectSubqueryForField(
  ctx: QueryScope,
  relationRef: RelationRef,
  connectInput: Record<string, unknown>,
  selectField: string
): Sql {
  const { adapter } = ctx;
  const { targetModel } = relationRef;

  const targetTable = getTableName(targetModel);
  const subAlias = ctx.nextAlias();
  const childCtx = createChildScope(ctx, targetModel, subAlias);

  const whereClause = buildWhereUnique(childCtx, connectInput, subAlias);

  const fieldColumn = getColumnName(targetModel, selectField);
  const fieldSql = adapter.identifiers.column(subAlias, fieldColumn);
  const tableSql = adapter.identifiers.escape(targetTable);

  const lookup = sql`SELECT ${fieldSql} FROM ${tableSql} ${sql.raw([
    subAlias,
  ])} WHERE ${whereClause}`;
  return readsMutationTarget(ctx, [targetTable])
    ? sql`(${hideMutationTarget(ctx, sql`(${lookup})`)})`
    : sql`(${lookup})`;
}
