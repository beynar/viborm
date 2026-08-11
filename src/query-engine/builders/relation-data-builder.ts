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
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import {
  hideMutationTarget,
  readsMutationTarget,
} from "./mutation-target-subquery";
import { buildWhereUnique } from "./where-unique-builder";

interface BoundRelationBase {
  readonly relationInfo: RelationInfo;
  readonly sourceModel: Model<any>;
}

export interface BoundForeignKeyRelation extends BoundRelationBase {
  readonly foreignFields: readonly string[];
  readonly referencedFields: readonly string[];
  readonly onUpdate: ReferentialAction | undefined;
}

export interface ParentHeldToOne extends BoundForeignKeyRelation {
  readonly kind: "parentHeldToOne";
}

export interface ChildHeldToOne extends BoundForeignKeyRelation {
  readonly kind: "childHeldToOne";
}

export interface ChildHeldToMany extends BoundForeignKeyRelation {
  readonly kind: "childHeldToMany";
}

export interface BoundPolymorphicChildHeldRelation
  extends BoundForeignKeyRelation {
  readonly foreignFields: readonly [string];
  readonly referencedFields: readonly [string];
  readonly storage: PolymorphicStorage;
  readonly storedType: string;
}

export interface PolymorphicChildHeldToOne
  extends BoundPolymorphicChildHeldRelation {
  readonly kind: "polymorphicChildHeldToOne";
}

export interface PolymorphicChildHeldToMany
  extends BoundPolymorphicChildHeldRelation {
  readonly kind: "polymorphicChildHeldToMany";
}

export type PolymorphicChildHeldRelation =
  | PolymorphicChildHeldToOne
  | PolymorphicChildHeldToMany;

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

export interface JunctionRelation extends BoundRelationBase {
  readonly kind: "junction";
  /** Junction table name — explicit `.through()` or the generated pair name. */
  readonly table: string;
  /** The end this relation is traversed FROM: `ctx.model` at bind time. */
  readonly source: JunctionSide;
  /** The end this relation is traversed TO: `relationInfo.targetModel`. */
  readonly target: JunctionSide;
}

export type BoundRelation =
  | ParentHeldToOne
  | ChildHeldToOne
  | ChildHeldToMany
  | PolymorphicChildHeldToOne
  | PolymorphicChildHeldToMany
  | JunctionRelation;

export function isPolymorphicChildHeldRelation(
  relation: BoundRelation
): relation is PolymorphicChildHeldRelation {
  return (
    relation.kind === "polymorphicChildHeldToOne" ||
    relation.kind === "polymorphicChildHeldToMany"
  );
}

/**
 * Does the TARGET row store this membership? True for both ordinary child-held
 * arities and both polymorphic ones; false for a parent-held edge (the source row
 * stores it) and for a junction (a third table does, and it admits many parents).
 *
 * The distinction is what decides whether one membership can be shared by several
 * source rows, so it belongs to relation topology rather than to any one operation.
 */
export function isChildHeldRelation(relation: BoundRelation): boolean {
  return (
    relation.kind === "childHeldToOne" ||
    relation.kind === "childHeldToMany" ||
    isPolymorphicChildHeldRelation(relation)
  );
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
 * Bind the junction arm of {@link bindRelation}, for the callers that have ALREADY
 * established the relation is many-to-many — the read builders' own dispatch and
 * `ManyToManyStatements`' guard. One construction, reached two ways; no second
 * classification and no narrowing cast at the call sites.
 *
 * EXPIRY: Phase 4 unit 4.1 ("make bindRelation the only constructor") absorbs
 * this entry point when the read builders migrate onto bound dispatch.
 */
export function bindJunctionRelation(
  ctx: QueryScope,
  relationInfo: RelationInfo
): JunctionRelation {
  let topology: JunctionTopology | undefined;
  const resolve = (): JunctionTopology => {
    topology ??= resolveJunctionTopology(ctx, relationInfo);
    return topology;
  };
  return {
    kind: "junction",
    relationInfo,
    sourceModel: ctx.model,
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

/** Bind one relation to its structural position relative to the current model. */
export function bindRelation(
  ctx: QueryScope,
  relationInfo: RelationInfo
): BoundRelation {
  if (relationInfo.type === "manyToMany") {
    return bindJunctionRelation(ctx, relationInfo);
  }

  const { fields, references, targetModel } = relationInfo;
  if (fields && fields.length > 0) {
    return {
      kind: "parentHeldToOne",
      relationInfo,
      sourceModel: ctx.model,
      foreignFields: fields,
      referencedFields: references ?? getPrimaryKeyFields(targetModel),
      onUpdate: relationInfo.relation["~"].state.onUpdate,
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

  const foreignKey = {
    relationInfo,
    sourceModel: ctx.model,
    foreignFields: resolved.fields as readonly string[] as string[],
    referencedFields:
      resolved.references && resolved.references.length > 0
        ? (resolved.references as readonly string[] as string[])
        : getPrimaryKeyFields(ctx.model),
    onUpdate: resolved.onUpdate,
  };

  if (relationInfo.isToOne) {
    return { kind: "childHeldToOne", ...foreignKey };
  }
  return { kind: "childHeldToMany", ...foreignKey };
}

function bindResolvedPolymorphicInverse(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  resolved: Extract<ResolvedInverseRelation, { kind: "polymorphic" }>
): PolymorphicChildHeldToOne | PolymorphicChildHeldToMany {
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
    kind: relationInfo.isToOne
      ? "polymorphicChildHeldToOne"
      : "polymorphicChildHeldToMany",
    relationInfo,
    sourceModel: ctx.model,
    foreignFields: [storage.idColumn.name],
    referencedFields: [member.referencedField],
    onUpdate: undefined,
    storage,
    storedType: resolved.storedType,
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
