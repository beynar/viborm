/**
 * Owns bound relation topology and the surviving connect lookup subquery.
 * Parsed mutation meaning belongs to relation-mutation-parser; record and edge
 * effects belong to the write engine.
 */

import { getModelKeyCatalog, type Model } from "@schema/model";
import {
  type PolymorphicStorage,
  type ReferentialAction,
  type ResolvedInverseRelation,
  resolveInverseRelation,
  resolveOrdinaryInverse,
} from "@schema/relation";
import {
  getJunctionFieldNames,
  getJunctionTableName,
} from "@schema/relation/helpers";
import { type Sql, sql } from "@sql";
import {
  createChildScope,
  getColumnName,
  getPrimaryKeyFields,
  getTableName,
} from "../context";
import {
  NestedWriteError,
  QueryEngineError,
  type QueryScope,
  type RelationInfo,
} from "../types";
import {
  hideMutationTarget,
  readsMutationTarget,
} from "./mutation-target-subquery";
import { buildWhereUnique } from "./where-unique-builder";

interface BoundRelationBase {
  readonly relationInfo: RelationInfo;
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
   * The two field lists paired member for member, in schema order.
   *
   * LAZY AND MEMOIZED, deliberately — not an optimization. Pairing is where
   * mismatched foreign-key metadata is REFUSED, and `bindRelation` runs at sites
   * that never pair (relation-key legality, the OwnWrite entry grouping, the
   * create/update dispatchers). Pairing eagerly would move that refusal ahead of
   * the relation-key legality error that answers first today, and that ORDER is
   * pinned (`bound-relation.test.ts`: "relation-key legality still answers before
   * mismatched FK arity").
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
  readonly storage: PolymorphicStorage;
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
 * that reference it. Exactly one member today (see {@link junctionSideMember});
 * the array is the shape a compound junction needs and every SQL consumer already
 * iterates it, so widening it adds no branch.
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
  /** The end this relation is traversed TO: `relationInfo.targetModel`. */
  readonly target: JunctionSide;
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
  readonly cardinality: "many";
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
 * JUNCTION CARVE-OUT — the one member of a bound junction side.
 *
 * A side carries exactly one member today because the binder resolves it through
 * {@link getRequiredSinglePrimaryKeyField}, which REFUSES a compound row key before
 * any consumer sees the side. Compound many-to-many is an unimplemented capability
 * (limitation-lift plan §6 N2), not a seal, and this projection is the one place
 * that reads a side as a single member. Its three legal reader classes: the
 * junction-DML builders (one column per side — the capability N2 widens), the
 * Part's stored side references, and `junctionSourceIsFirst`'s orientation
 * comparison, which under compound sides must become an ordered member-list
 * comparison. The join SQL already folds every member.
 */
export function junctionSideMember(
  side: JunctionSide
): JunctionReferenceMember {
  return side.members[0]!;
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

interface JunctionTopology {
  readonly table: string;
  readonly source: JunctionSide;
  readonly target: JunctionSide;
}

function resolveJunctionTopology(
  ctx: QueryScope,
  relationInfo: RelationInfo
): JunctionTopology {
  const sourceModel = ctx.model;
  const { targetModel } = relationInfo;
  const sourceModelName = sourceModel["~"].names.ts ?? "unknown";
  const targetModelName = targetModel["~"].names.ts ?? "unknown";
  // Resolution ORDER is load-bearing and is the one the deleted second binder used:
  // table name, then junction columns, then the source row key, then the target's.
  // A schema that trips two of these keeps reporting the first.
  const table = getJunctionTableName(
    relationInfo.relation,
    sourceModelName,
    targetModelName
  );
  const [sourceField, targetField] = getJunctionFieldNames(
    relationInfo.relation,
    sourceModelName,
    targetModelName
  );
  const sourceReferenced = getRequiredSinglePrimaryKeyField(sourceModel);
  const targetReferenced = getRequiredSinglePrimaryKeyField(targetModel);
  return {
    table,
    source: {
      model: sourceModel,
      members: [
        { junctionField: sourceField, referencedField: sourceReferenced },
      ],
    },
    target: {
      model: targetModel,
      members: [
        { junctionField: targetField, referencedField: targetReferenced },
      ],
    },
  };
}

/**
 * Bind the junction arm of {@link bindRelation}. Module-private: every caller
 * reaches it through {@link classifyRelation}, which is the one place that decides
 * a relation is many-to-many.
 */
function bindJunctionRelation(
  ctx: QueryScope,
  relationInfo: RelationInfo
): JunctionBoundRelation {
  let topology: JunctionTopology | undefined;
  const resolve = (): JunctionTopology => {
    topology ??= resolveJunctionTopology(ctx, relationInfo);
    return topology;
  };
  return {
    position: "junction",
    cardinality: "many",
    relationInfo,
    sourceModel: ctx.model,
    membership: {
      kind: "junction",
      // LAZY AND MEMOIZED, deliberately — not an optimization. Resolving a side asks
      // each model for its single-field row key, and that ask is where the engine's
      // compound-many-to-many limitation is refused. Today the refusal fires when JOIN
      // INFO IS REQUESTED, and `bindRelation` runs at many sites that never request it
      // (relation-key legality, the OwnWrite entry grouping, the create/update
      // dispatchers, the junction fold's own child scan). Resolving eagerly here would
      // move that refusal — and the schema helpers' junction-naming errors — strictly
      // earlier in the estate's error ordering. Its class, message AND the frames its
      // stack must contain are pinned (`operation-construction-witnesses.test.ts`:
      // `getRequiredSinglePrimaryKeyField` reached through an `OwnWrite` frame), so the
      // laziness is part of the observable contract, not an implementation detail.
      get table() {
        return resolve().table;
      },
      get source() {
        return resolve().source;
      },
      get target() {
        return resolve().target;
      },
    },
  };
}

/**
 * The single primary key field of a model, or throw.
 *
 * Junction tables key on one PK column per side, so many-to-many requires a
 * single-field PK on both models.
 *
 * Both questions are answered by the model-key catalog — the one owner of how a row
 * is addressed — rather than by a second read of `state.compoundId`/`state.scalars`:
 *
 * - A GROUPED primary key (`.id([...])`) is exactly an addressable key of kind
 *   `primary` carrying a selector `name`; a bare `.id()` scalar carries none. The
 *   catalog keeps EVERY declared compound-id constraint addressable, including an
 *   empty one, so this test spans exactly the set the deleted
 *   `Object.keys(state.compoundId).length > 0` read spanned — an empty constraint
 *   still refuses here, as it always has.
 * - With no grouped primary declared, the catalog's `rowKey` can only be the bare
 *   scalar id (first `.id()` scalar in shape order, the same one the deleted scan
 *   returned), and its absence is the "no primary key field" case.
 */
// MOVED from correlation-utils.ts and reimplemented on the model-key catalog in
// distinct-truth Phase 3 (Phase 1 deferred it here, to the junction binder that
// owns its only consumers). Equivalence verified branch-by-branch against the
// old state scans: the grouped-primary test spans exactly the old
// non-empty-compoundId-record set (the catalog keeps EVERY compound-id entry,
// empty- and ''-named ones included, and only grouped keys carry a name); the
// bare rowKey is the first isId scalar in shape order, the same field the old
// scalar scan returned; class and both sentences byte-identical.
export function getRequiredSinglePrimaryKeyField(model: Model<any>): string {
  const modelName = getModelName(model);
  const catalog = getModelKeyCatalog(model);

  if (
    catalog.addressableKeys.some(
      (key) => key.kind === "primary" && key.name !== undefined
    )
  ) {
    throw new QueryEngineError(
      `Model "${modelName}" uses a compound primary key. ` +
        "Many-to-many relations with compound PKs are not supported. " +
        "Use a single-field surrogate key (e.g., s.string().id().ulid()) instead."
    );
  }

  const rowKeyField = catalog.rowKey?.fields[0];
  if (rowKeyField !== undefined) {
    return rowKeyField;
  }

  throw new QueryEngineError(
    `Model "${modelName}" has no primary key field. ` +
      "Many-to-many relations require a single-field primary key."
  );
}

/** Model name for error messages. */
function getModelName(model: Model<any>): string {
  return model["~"].names.ts ?? model["~"].state.tableName ?? "unknown";
}

/**
 * Pair the two field lists member for member. A reference list SHORTER than the
 * foreign list is malformed schema metadata and is refused here; a longer one
 * carries members no foreign column stores, and those have never been bound.
 */
function pairMembers(
  relationName: string,
  foreignFields: readonly string[],
  referencedFields: readonly string[]
): readonly ForeignKeyMemberPair[] {
  return foreignFields.map((foreignField, index) => {
    const referencedField = referencedFields[index];
    if (referencedField === undefined) {
      throw new NestedWriteError(
        `Relation '${relationName}' has mismatched foreign-key metadata.`,
        relationName
      );
    }
    return { foreignField, referencedField };
  });
}

function buildForeignKeyMembership(
  relationName: string,
  holder: Model<any>,
  referenced: Model<any>,
  foreignFields: readonly string[],
  referencedFields: readonly string[],
  onUpdate: ReferentialAction | undefined
): BoundForeignKeyMembership {
  let members: readonly ForeignKeyMemberPair[] | undefined;
  return {
    kind: "foreignKey",
    holder,
    referenced,
    foreignFields,
    referencedFields,
    onUpdate,
    get members() {
      members ??= pairMembers(relationName, foreignFields, referencedFields);
      return members;
    },
  };
}

/**
 * The ONE construction of a polymorphic membership, for the inverse edge the
 * schema fixes and for the direct edge a payload's discriminator selects. Both
 * hand the same storage and the same `storage.members` entry; only which model
 * holds the private pair differs, and that is the caller's to state.
 */
export function buildPolymorphicMembership(
  holder: Model<any>,
  referenced: Model<any>,
  storage: PolymorphicStorage,
  member: {
    readonly storedType: string;
    readonly referencedField: string;
  }
): BoundPolymorphicMembership {
  return {
    kind: "polymorphic",
    holder,
    referenced,
    foreignFields: [storage.idColumn.name],
    referencedField: member.referencedField,
    onUpdate: undefined,
    storage,
    storedType: member.storedType,
  };
}

/**
 * The engine's ONE classification of a relation's physical shape, handed back as a
 * value: which arm it is, and the bind whose TYPE is that arm's bound relation.
 *
 * `RelationInfo` is not a discriminated union, so `type === "manyToMany"` narrows
 * nothing on its own. Returning the answer as a discriminated pair is what lets a
 * caller reach the narrowed construction with no second test, no cast and no
 * guard — {@link bindRelation} is itself defined through it, so the estate holds
 * exactly one spelling of the test.
 *
 * The bind is a THUNK because classification answers a question that must be asked
 * EARLIER than topology may be resolved: a read traversal classifies to know how
 * many aliases it spends, while binding a row-held relation resolves its inverse
 * eagerly (and can refuse), and a junction's sides refuse a compound row key when
 * they are READ. Callers that classify to place aliases must not pay those
 * refusals; callers that need the bound value call the thunk where they need it.
 */
export type ClassifiedRelation =
  | { readonly kind: "junction"; readonly bind: () => JunctionBoundRelation }
  | {
      readonly kind: "rowHeld";
      readonly bind: () => ParentHeldRelation | ChildHeldRelation;
    };

/** Classify one relation's physical shape relative to the current model. */
export function classifyRelation(
  ctx: QueryScope,
  relationInfo: RelationInfo
): ClassifiedRelation {
  if (relationInfo.type === "manyToMany") {
    return {
      kind: "junction",
      bind: () => bindJunctionRelation(ctx, relationInfo),
    };
  }
  return {
    kind: "rowHeld",
    bind: () => bindRowHeldRelation(ctx, relationInfo),
  };
}

/** Bind one relation to its structural position relative to the current model. */
export function bindRelation(
  ctx: QueryScope,
  relationInfo: RelationInfo
): BoundRelation {
  return classifyRelation(ctx, relationInfo).bind();
}

/** Bind the arm whose membership one of the two ROWS stores. */
function bindRowHeldRelation(
  ctx: QueryScope,
  relationInfo: RelationInfo
): ParentHeldRelation | ChildHeldRelation {
  const { fields, references, targetModel } = relationInfo;
  if (fields && fields.length > 0) {
    return {
      position: "parentHeld",
      cardinality: "one",
      relationInfo,
      sourceModel: ctx.model,
      membership: buildForeignKeyMembership(
        relationInfo.name,
        ctx.model,
        targetModel,
        fields,
        references ?? getPrimaryKeyFields(targetModel),
        relationInfo.relation["~"].state.onUpdate
      ),
    };
  }

  // The one candidate scan lives in the schema layer (`@schema/relation`'s
  // resolver); this binder only translates its verdicts into the engine's
  // established errors and bound shapes. A fields-less `manyToOne` (the
  // FK004-warned compatibility form) can never bind a polymorphic inverse, so
  // it asks for the ordinary-only resolution — the same gate the deleted
  // `bindPolymorphicInverse` kept.
  const relationName = relationInfo.relation["~"].state.name;
  const resolved =
    relationInfo.type === "oneToOne" || relationInfo.type === "oneToMany"
      ? resolveInverseRelation(
          relationInfo.targetModel,
          ctx.model,
          relationName
        )
      : resolveOrdinaryInverse(
          relationInfo.targetModel,
          ctx.model,
          relationName
        );

  if (resolved.kind === "polymorphic") {
    return bindResolvedPolymorphicInverse(ctx, relationInfo, resolved);
  }
  if (resolved.kind === "ambiguous") {
    const sourceName =
      ctx.model["~"].names.ts ?? ctx.model["~"].state.tableName ?? "unknown";
    const targetName =
      relationInfo.targetModel["~"].names.ts ??
      relationInfo.targetModel["~"].state.tableName ??
      "unknown";
    throw new QueryEngineError(
      `Ambiguous relation '${relationInfo.name}' on model '${sourceName}': ` +
        `multiple relations on '${targetName}' point back to it. ` +
        "Add .name() to both sides of each relation to disambiguate."
    );
  }
  if (resolved.kind === "missing") {
    throw new QueryEngineError(
      `Cannot determine FK fields for relation '${relationInfo.name}'. ` +
        "Define the inverse relation with .fields([...]) or use explicit FK fields."
    );
  }

  return {
    position: "childHeld",
    cardinality: relationInfo.cardinality,
    relationInfo,
    sourceModel: ctx.model,
    membership: buildForeignKeyMembership(
      relationInfo.name,
      relationInfo.targetModel,
      ctx.model,
      resolved.fields as readonly string[] as string[],
      resolved.references && resolved.references.length > 0
        ? (resolved.references as readonly string[] as string[])
        : getPrimaryKeyFields(ctx.model),
      resolved.onUpdate
    ),
  };
}

function bindResolvedPolymorphicInverse(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  resolved: Extract<ResolvedInverseRelation, { kind: "polymorphic" }>
): PolymorphicChildHeldRelation {
  const storage = relationInfo.targetModel["~"].getPolymorphicStorage(
    resolved.relationKey
  );
  const member = storage?.members.get(resolved.publicType);
  if (!(storage && member)) {
    throw new QueryEngineError(
      `Polymorphic inverse '${relationInfo.name}' has no resolved storage binding.`
    );
  }

  return {
    position: "childHeld",
    cardinality: relationInfo.cardinality,
    relationInfo,
    sourceModel: ctx.model,
    membership: buildPolymorphicMembership(
      relationInfo.targetModel,
      ctx.model,
      storage,
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
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  selectField: string
): Sql {
  const { adapter } = ctx;
  const { targetModel } = relationInfo;

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
