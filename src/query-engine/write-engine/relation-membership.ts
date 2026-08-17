import { NestedWriteError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import { isSql, type Sql } from "@sql";
import {
  buildPolymorphicMembershipPredicate,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import {
  type BoundPolymorphicMembership,
  type ChildHeldRelation,
  type ForeignKeyMemberPair,
  hasPolymorphicMembership,
  type OrdinaryChildHeldRelation,
  type PolymorphicChildHeldRelation,
} from "../builders/relation-data-builder";
import type { QueryEngine } from "../query-engine";
import type { QueryScope } from "../types";
import { referenceScalarSql, referenceSql } from "./fragment-builders";
import type { OperationValueReference } from "./OperationFragment";
import { ref } from "./OperationFragment";
import type { PlanningKnown } from "./Part";
import { planningKey } from "./Part";

export type PlanningReferenceSource =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "planningField"; readonly step: string };

export type FinalReferenceSource =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "finalRef"; readonly ref: OperationValueReference }
  | { readonly kind: "planningField"; readonly step: string }
  | {
      readonly kind: "transitionedPlanningField";
      readonly step: string;
      /**
       * The transformation is FIELD-AGNOSTIC and the field comes from the
       * member it is bound to, so one source stays per-member correct however many
       * members it is bound across. A source that closed its field in was correct
       * only when built inside a per-member `map`, which made every broadcast site
       * (`bindRelationMembership`, `bindCorrelatedRelationMembership`, every
       * `referencedFields.map(() => source)`) a latent compound collapse.
       */
      readonly apply: (before: unknown, referencedField: string) => unknown;
    }
  | {
      /**
       * One selected row observed at planning and re-addressed at execution. Unlike a
       * normal transition source, this source deliberately exposes its captured side
       * to planning probes while its final side is consumed by writes. The enclosing
       * selected-record compiler owns the phase decision; relation Parts only carry it.
       */
      readonly kind: "selectedRowContinuity";
      readonly step: string;
      readonly apply: (before: unknown, referencedField: string) => unknown;
    }
  | { readonly kind: "lookup"; readonly statement: Sql };

/** Exact final value source for each named field in a complete stored tuple. */
export type FinalReferenceSources = Readonly<
  Record<string, FinalReferenceSource>
>;

export interface ForeignKeyMember {
  readonly foreignField: string;
  readonly referencedField: string;
  readonly writeSource: FinalReferenceSource;
}

export interface CorrelatedForeignKeyMember extends ForeignKeyMember {
  readonly readSource: PlanningReferenceSource;
}

export type RelationMembershipBinding =
  | {
      readonly kind: "foreignKey";
      readonly relation: OrdinaryChildHeldRelation;
      readonly members: readonly ForeignKeyMember[];
    }
  | {
      readonly kind: "polymorphic";
      readonly relation: PolymorphicChildHeldRelation;
      readonly writeSource: FinalReferenceSource;
    };

export type CorrelatedRelationMembershipBinding =
  | {
      readonly kind: "foreignKey";
      readonly relation: OrdinaryChildHeldRelation;
      readonly members: readonly CorrelatedForeignKeyMember[];
    }
  | {
      readonly kind: "polymorphic";
      readonly relation: PolymorphicChildHeldRelation;
      readonly readSource: PlanningReferenceSource;
      readonly writeSource: FinalReferenceSource;
    };

export interface LoweredMembershipWrite {
  readonly data: Record<string, unknown>;
  readonly polymorphicStorage: readonly PolymorphicStorageValue<unknown>[];
}

interface FinalReferenceFieldSource {
  readonly field: string;
  readonly source: FinalReferenceSource;
}

interface PlanningReferenceFieldSource {
  readonly field: string;
  readonly source: PlanningReferenceSource;
}

/**
 * Resolve the complete row key of a parent that a later committed segment must
 * still observe. Exact field-bound sources win. A planning-backed source may
 * publish another row-key member from the same captured parent row; literals,
 * lookups, and produced single-field references never pretend to do so.
 */
export function resolveFinalReferenceRowKey(
  model: Model<any>,
  sources: readonly FinalReferenceFieldSource[],
  known: PlanningKnown,
  relationName: string,
  operation: string
): Record<string, unknown> | undefined {
  const fallback = sharedFinalPlanningSource(sources);
  const identity: Record<string, unknown> = {};
  for (const field of getPrimaryKeyFields(model)) {
    const source =
      sources.find((candidate) => candidate.field === field)?.source ??
      fallback;
    if (!source || source.kind === "lookup") return undefined;
    if (source.kind === "literal" && isSql(source.value)) return undefined;
    const value = foreignKeyWriteValue(
      {
        foreignField: field,
        referencedField: field,
        writeSource: source,
      },
      known,
      relationName,
      operation
    );
    if (isSql(value)) return undefined;
    identity[field] = value;
  }
  return identity;
}

/**
 * The exact membership premise a later committed segment must still observe,
 * for the referenced fields that are NOT members of the parent's row key.
 *
 * Residual plan §H1 keeps two facts apart: the parent liveness guard uses every
 * `ModelKeyCatalog.rowKey` member, and "an exact … referenced value proves
 * membership, not parent row identity". When the row key and the reference key
 * coincide — the ordinary case, and every junction and polymorphic placement by
 * construction — this answers `{}` and the guard is byte-identical to the one that
 * shipped before. It answers something only where the two genuinely differ: an
 * ordinary child-held edge that references a NON-primary-key unique. The caller
 * chooses the temporal source; {@link resolveCorrelatedMembershipProgressivePremise}
 * keeps the row key and this tuple on the same read or write side.
 *
 * `undefined` means the premise cannot be stated — an opaque lookup, or a value
 * that is still `Sql` at this point — and the caller must decline the placement
 * rather than guard half of it. A polymorphic membership never reaches that: its
 * referenced field is the target's one scalar primary key (schema rule P009), so
 * the row key already carries it.
 */
export function resolveMembershipReferencedPremise(
  binding: RelationMembershipBinding,
  known: PlanningKnown,
  operation: string
): Record<string, unknown> | undefined {
  return resolveReferencedPremise(binding, (member) => {
    if (member.writeSource.kind === "lookup") return undefined;
    return foreignKeyWriteValue(
      member,
      known,
      binding.relation.relationInfo.name,
      operation
    );
  });
}

function resolveReferencedPremise(
  binding: RelationMembershipBinding,
  resolve: (member: ForeignKeyMember, index: number) => unknown
): Record<string, unknown> | undefined {
  if (binding.kind === "polymorphic") return {};
  const rowKey = new Set(
    getPrimaryKeyFields(binding.relation.membership.referenced)
  );
  const premise: Record<string, unknown> = {};
  for (const [index, member] of binding.members.entries()) {
    if (rowKey.has(member.referencedField)) continue;
    const value = resolve(member, index);
    if (value === undefined || isSql(value)) return undefined;
    premise[member.referencedField] = value;
  }
  return premise;
}

/** The two exact parent facts a child-held series carries across a committed
 * boundary. `existingMembers` observes the membership captured before the
 * enclosing write; `suppliedMember` observes the membership a preceding supplier
 * just wrote. The correlation kind is the temporal owner for BOTH row identity and
 * the non-row-key referenced tuple. */
export function resolveCorrelatedMembershipProgressivePremise(
  binding: CorrelatedRelationMembershipBinding,
  known: PlanningKnown,
  operation: string,
  correlate: "existingMembers" | "suppliedMember"
):
  | {
      readonly identity: Record<string, unknown>;
      readonly membership: Record<string, unknown>;
    }
  | undefined {
  const identity =
    correlate === "existingMembers"
      ? resolveMembershipReadParentRowKey(binding, known, operation)
      : resolveMembershipWriteParentRowKey(binding, known, operation);
  if (!identity) return undefined;
  const membership =
    correlate === "suppliedMember"
      ? resolveMembershipReferencedPremise(binding, known, operation)
      : resolveReferencedPremise(binding, (member, index) => {
          if (binding.kind !== "foreignKey") return undefined;
          const correlated = binding.members[index];
          if (!correlated) return undefined;
          return resolvedPlanningReferenceValue(
            correlated.readSource,
            member.referencedField,
            known,
            binding.relation.relationInfo.name,
            operation
          );
        });
  return membership ? { identity, membership } : undefined;
}

/** Complete parent row key at a membership WRITE position. */
export function resolveMembershipWriteParentRowKey(
  binding: RelationMembershipBinding,
  known: PlanningKnown,
  operation: string
): Record<string, unknown> | undefined {
  const relationName = binding.relation.relationInfo.name;
  const sources: FinalReferenceFieldSource[] =
    binding.kind === "foreignKey"
      ? binding.members.map((member) => ({
          field: member.referencedField,
          source: member.writeSource,
        }))
      : [
          {
            field: binding.relation.membership.referencedField,
            source: binding.writeSource,
          },
        ];
  return resolveFinalReferenceRowKey(
    binding.relation.membership.referenced,
    sources,
    known,
    relationName,
    operation
  );
}

/** Complete parent row key at an existing-membership READ position. */
export function resolveMembershipReadParentRowKey(
  binding: CorrelatedRelationMembershipBinding,
  known: PlanningKnown,
  operation: string
): Record<string, unknown> | undefined {
  const relationName = binding.relation.relationInfo.name;
  const sources: PlanningReferenceFieldSource[] =
    binding.kind === "foreignKey"
      ? binding.members.map((member) => ({
          field: member.referencedField,
          source: member.readSource,
        }))
      : [
          {
            field: binding.relation.membership.referencedField,
            source: binding.readSource,
          },
        ];
  const fallback = sharedPlanningSource(sources);
  const identity: Record<string, unknown> = {};
  for (const field of getPrimaryKeyFields(
    binding.relation.membership.referenced
  )) {
    const source =
      sources.find((candidate) => candidate.field === field)?.source ??
      fallback;
    if (!source) return undefined;
    if (source.kind === "literal" && isSql(source.value)) return undefined;
    const value = resolvedPlanningReferenceValue(
      source,
      field,
      known,
      relationName,
      operation
    );
    if (isSql(value)) return undefined;
    identity[field] = value;
  }
  return identity;
}

function sharedFinalPlanningSource(
  sources: readonly FinalReferenceFieldSource[]
): FinalReferenceSource | undefined {
  const candidates = sources
    .map((entry) => entry.source)
    .filter(
      (
        source
      ): source is Extract<
        FinalReferenceSource,
        {
          kind:
            | "planningField"
            | "transitionedPlanningField"
            | "selectedRowContinuity";
        }
      > =>
        source.kind === "planningField" ||
        source.kind === "transitionedPlanningField" ||
        source.kind === "selectedRowContinuity"
    );
  const first = candidates[0];
  if (!first) return undefined;
  return candidates.every(
    (candidate) =>
      candidate.kind === first.kind &&
      candidate.step === first.step &&
      (candidate.kind === "planningField" ||
        (first.kind === candidate.kind && candidate.apply === first.apply))
  )
    ? first
    : undefined;
}

function sharedPlanningSource(
  sources: readonly PlanningReferenceFieldSource[]
): PlanningReferenceSource | undefined {
  const candidates = sources
    .map((entry) => entry.source)
    .filter(
      (
        source
      ): source is Extract<
        PlanningReferenceSource,
        { kind: "planningField" }
      > => source.kind === "planningField"
    );
  const first = candidates[0];
  return first && candidates.every((candidate) => candidate.step === first.step)
    ? first
    : undefined;
}

/**
 * Attach one write source per BOUND member. The binder paired the fields, and every
 * caller derives its source list from that same member list, so the source arrays
 * cannot disagree with it in arity.
 */
export function pairForeignKeyMembers(
  members: readonly ForeignKeyMemberPair[],
  writeSources: readonly FinalReferenceSource[]
): ForeignKeyMember[] {
  return members.map(({ foreignField, referencedField }, index) => ({
    foreignField,
    referencedField,
    writeSource: writeSources[index]!,
  }));
}

export function pairCorrelatedForeignKeyMembers(
  members: readonly ForeignKeyMemberPair[],
  readSources: readonly PlanningReferenceSource[],
  writeSources: readonly FinalReferenceSource[]
): CorrelatedForeignKeyMember[] {
  return members.map(({ foreignField, referencedField }, index) => ({
    foreignField,
    referencedField,
    readSource: readSources[index]!,
    writeSource: writeSources[index]!,
  }));
}

export function plannedParentId(readStep: string): FinalReferenceSource {
  return { kind: "planningField", step: readStep };
}

export function literalParentId(value: unknown): FinalReferenceSource {
  return { kind: "literal", value };
}

/**
 * The post-transition value of whichever reference-key member this source is bound
 * to: `transition` receives the located (pre-transition) value together with the
 * member's own referenced field, so one source binds correctly across a compound
 * reference in schema order. It is applied exactly once per member, at the single
 * resolution point in {@link finalReferenceValue}; transitioned sources are never
 * chained.
 */
export function transitionedParentId(
  readStep: string,
  transition: (before: unknown, field: string) => unknown
): FinalReferenceSource {
  return {
    kind: "transitionedPlanningField",
    step: readStep,
    apply: transition,
  };
}

/**
 * Publish one field-agnostic selected-row continuity source. Planning reads the
 * captured row through `readStep`; execution applies the enclosing compiler's phase
 * function. This is intentionally separate from `transitionedParentId`: an ordinary
 * transition cannot enter planning under its final value, while selected-row
 * continuity explicitly requires the before/final split.
 */
export function selectedRowContinuity(
  readStep: string,
  atExecution: (before: unknown, field: string) => unknown
): FinalReferenceSource {
  return {
    kind: "selectedRowContinuity",
    step: readStep,
    apply: atExecution,
  };
}

export function fkEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    (typeof left === "number" || typeof left === "bigint") &&
    (typeof right === "number" || typeof right === "bigint")
  ) {
    return BigInt(left) === BigInt(right);
  }
  return false;
}

export function bindRelationMembership(
  relation: ChildHeldRelation,
  writeSource: FinalReferenceSource
): RelationMembershipBinding {
  if (hasPolymorphicMembership(relation)) {
    return { kind: "polymorphic", relation, writeSource };
  }
  const { members } = relation.membership;
  return {
    kind: "foreignKey",
    relation,
    members: pairForeignKeyMembers(
      members,
      members.map(() => writeSource)
    ),
  };
}

/**
 * Bind one old-read and one new-write source across every referenced member in
 * schema order. Fanning ONE source out is exact — never a compound collapse —
 * because every source kind is resolved against the member it lands on: a
 * `planningField` reads `row[member.referencedField]` and a
 * `transitionedPlanningField` transforms that member's own value
 * ({@link finalReferenceValue}). A caller whose members need DIFFERENT sources —
 * the occupied guard, whose pre-value is a `where` literal for the members the
 * locator pins and a located-row read for the rest — pairs them itself with
 * {@link pairCorrelatedForeignKeyMembers}.
 */
export function bindCorrelatedRelationMembership(
  relation: ChildHeldRelation,
  readSource: PlanningReferenceSource,
  writeSource: FinalReferenceSource
): CorrelatedRelationMembershipBinding {
  if (hasPolymorphicMembership(relation)) {
    return { kind: "polymorphic", relation, readSource, writeSource };
  }
  const { members } = relation.membership;
  return {
    kind: "foreignKey",
    relation,
    members: pairCorrelatedForeignKeyMembers(
      members,
      members.map(() => readSource),
      members.map(() => writeSource)
    ),
  };
}

export function lowerMembershipWrite(
  engine: QueryEngine,
  childScope: QueryScope,
  binding: RelationMembershipBinding,
  known: PlanningKnown | undefined,
  operation: string
): LoweredMembershipWrite {
  if (binding.kind === "polymorphic") {
    return {
      data: {},
      polymorphicStorage: [
        resolvePolymorphicStorageValue(
          engine,
          {
            kind: "linked",
            storage: binding.relation.membership.storage,
            storedType: binding.relation.membership.storedType,
            referencedField: binding.relation.membership.referencedField,
            id: binding.writeSource,
          },
          known,
          operation
        ),
      ],
    };
  }
  const data: Record<string, unknown> = {};
  for (const member of binding.members) {
    data[member.foreignField] = referenceSql(
      engine,
      childScope.model,
      member.foreignField,
      foreignKeyWriteValue(
        member,
        known,
        binding.relation.relationInfo.name,
        operation
      )
    );
  }
  return { data, polymorphicStorage: [] };
}

export function lowerEmptyMembership(
  binding: RelationMembershipBinding
): LoweredMembershipWrite {
  if (binding.kind === "polymorphic") {
    return {
      data: {},
      polymorphicStorage: [
        { kind: "empty", storage: binding.relation.membership.storage },
      ],
    };
  }
  return {
    data: Object.fromEntries(
      binding.members.map((member) => [member.foreignField, { set: null }])
    ),
    polymorphicStorage: [],
  };
}

/**
 * What every membership question answers with: per-member FK equality filters, or one
 * exact polymorphic `(type, id)` predicate. One shape, three resolvers (planning read,
 * final read, final write) — consumers spread `predicate` only when it is present.
 */
export type RelationMembershipCondition = {
  readonly filters: readonly Record<string, unknown>[];
  readonly predicate?: Sql;
};

export function planningMembershipCondition(
  engine: QueryEngine,
  childScope: QueryScope,
  binding: CorrelatedRelationMembershipBinding,
  qualifier: string
): RelationMembershipCondition {
  if (binding.kind === "foreignKey") {
    return {
      filters: binding.members.map((member) => ({
        [member.foreignField]: {
          equals: foreignKeyCorrelationValue(member),
        },
      })),
    };
  }
  const relation = binding.relation;
  const { membership } = relation;
  const identity = referenceScalarSql(
    engine,
    membership.storage.idColumn.scalar,
    membership.storage.idColumn.name,
    planningReferenceValue(binding.readSource, membership.referencedField)
  );
  return {
    filters: [],
    predicate: buildPolymorphicMembershipPredicate(
      childScope,
      relation,
      qualifier,
      identity
    ),
  };
}

export function finalMembershipCondition(
  engine: QueryEngine,
  childScope: QueryScope,
  binding: CorrelatedRelationMembershipBinding,
  qualifier: string,
  known: PlanningKnown,
  operation: string
): RelationMembershipCondition {
  const relationName = binding.relation.relationInfo.name;
  if (binding.kind === "foreignKey") {
    return {
      filters: binding.members.map((member) => ({
        [member.foreignField]: {
          equals: foreignKeyResolvedReadValue(
            member,
            known,
            relationName,
            operation
          ),
        },
      })),
    };
  }
  const { membership } = binding.relation;
  return polymorphicMembershipShape(
    engine,
    childScope,
    binding.relation,
    qualifier,
    resolvedPlanningReferenceValue(
      binding.readSource,
      membership.referencedField,
      known,
      relationName,
      operation
    )
  );
}

/**
 * The one predicate SHAPE both membership questions share. The read and write
 * builders differ only in which source resolves the referenced value; the lowering
 * from that value to the exact `(type, id)` membership predicate lives once, here.
 */
function polymorphicMembershipShape(
  engine: QueryEngine,
  childScope: QueryScope,
  relation: Extract<
    RelationMembershipBinding,
    { kind: "polymorphic" }
  >["relation"],
  qualifier: string,
  referencedValue: Parameters<typeof referenceScalarSql>[3]
): RelationMembershipCondition {
  const { membership } = relation;
  const identity = referenceScalarSql(
    engine,
    membership.storage.idColumn.scalar,
    membership.storage.idColumn.name,
    referencedValue
  );
  return {
    filters: [],
    predicate: buildPolymorphicMembershipPredicate(
      childScope,
      relation,
      qualifier,
      identity
    ),
  };
}

/**
 * The same membership predicate, resolved from the WRITE source instead of the read
 * one — the other half of §14's rule, on the one arm that needs it.
 *
 * {@link finalMembershipCondition} answers "which rows currently carry this parent's
 * membership", and every existing caller wants exactly that: a release, a bulk
 * correlated update, a set departure, an existing-member capture. This one answers
 * "which row carries the membership a sibling write in this same fragment just
 * ASSIGNED", which is a different question whenever the parent's referenced value is
 * in transition — the supplier stored the post-transition value, and the located
 * pre-transition value names no row at all.
 *
 * It is a second QUESTION, not a second owner: both live here, both read one binding,
 * and neither infers its source from the other. Without a transition the two resolve
 * to the same value and emit the same SQL, which is why every unchanged caller stays
 * byte-identical.
 */
export function finalMembershipWriteCondition(
  engine: QueryEngine,
  childScope: QueryScope,
  binding: RelationMembershipBinding,
  qualifier: string,
  known: PlanningKnown,
  operation: string
): RelationMembershipCondition {
  const relationName = binding.relation.relationInfo.name;
  if (binding.kind === "foreignKey") {
    return {
      filters: binding.members.map((member) => ({
        [member.foreignField]: {
          equals: foreignKeyWriteValue(member, known, relationName, operation),
        },
      })),
    };
  }
  const { membership } = binding.relation;
  return polymorphicMembershipShape(
    engine,
    childScope,
    binding.relation,
    qualifier,
    finalReferenceValue(
      binding.writeSource,
      membership.referencedField,
      known,
      relationName,
      operation
    )
  );
}

export function membershipProjection(
  childScope: QueryScope,
  binding: RelationMembershipBinding
) {
  if (binding.kind === "foreignKey") {
    return {
      fields: binding.members.map((member) => member.foreignField),
      additionalColumns: [],
    };
  }
  const { adapter, rootAlias } = childScope;
  return {
    fields: [],
    additionalColumns: [
      binding.relation.membership.storage.typeColumn,
      binding.relation.membership.storage.idColumn,
    ].map((column) =>
      adapter.identifiers.aliased(
        adapter.identifiers.column(rootAlias, column.name),
        column.name
      )
    ),
  };
}

export function recordHasMembership(
  binding: CorrelatedRelationMembershipBinding,
  record: Readonly<Record<string, unknown>> | undefined,
  known: PlanningKnown,
  operation: string
): boolean {
  const relationName = binding.relation.relationInfo.name;
  if (binding.kind === "foreignKey") {
    return binding.members.every((member) =>
      fkEquals(
        record?.[member.foreignField],
        foreignKeyResolvedReadValue(member, known, relationName, operation)
      )
    );
  }
  const { membership } = binding.relation;
  return (
    record?.[membership.storage.typeColumn.name] === membership.storedType &&
    fkEquals(
      record?.[membership.storage.idColumn.name],
      resolvedPlanningReferenceValue(
        binding.readSource,
        membership.referencedField,
        known,
        relationName,
        operation
      )
    )
  );
}

function planningReferenceValue(
  source: PlanningReferenceSource,
  referencedField: string
): OperationValueReference | unknown {
  return source.kind === "literal"
    ? source.value
    : ref(source.step, referencedField);
}

function resolvedPlanningReferenceValue(
  source: PlanningReferenceSource,
  referencedField: string,
  known: PlanningKnown,
  relationName: string,
  kind: string
): unknown {
  return source.kind === "literal"
    ? source.value
    : finalReferenceValue(
        { kind: "planningField", step: source.step },
        referencedField,
        known,
        relationName,
        kind
      );
}

export function literalReferenceValue(
  source: FinalReferenceSource
): unknown | undefined {
  return source.kind === "literal" ? source.value : undefined;
}

export function literalReferenceSource(
  source: FinalReferenceSource
): { readonly value: unknown } | undefined {
  return source.kind === "literal" ? { value: source.value } : undefined;
}

export function isPlanningFieldSource(source: FinalReferenceSource): boolean {
  return source.kind === "planningField";
}

function finalReferenceValue(
  source: FinalReferenceSource,
  referencedField: string,
  known: PlanningKnown | undefined,
  relationName: string,
  kind: string
): unknown {
  if (source.kind === "literal") return source.value;
  if (source.kind === "finalRef") return source.ref;
  if (source.kind === "lookup") return source.statement;
  if (!known) {
    throw new QueryEngineError(
      `query-engine-v2 ${kind} for relation '${relationName}' requires a planned parent id.`
    );
  }

  const rows = known[planningKey(source.step, "rows")];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!(row && typeof row === "object")) {
    throw new NestedWriteError(
      `query-engine-v2 ${kind} for relation '${relationName}' could not resolve its parent id.`,
      relationName
    );
  }
  const before = (row as Record<string, unknown>)[referencedField];
  return source.kind === "transitionedPlanningField" ||
    source.kind === "selectedRowContinuity"
    ? source.apply(before, referencedField)
    : before;
}

function finalReferenceValueWith(
  source: FinalReferenceSource,
  referencedField: string,
  known: PlanningKnown | undefined,
  relationName: string,
  kind: string,
  lowerFinalRef: (reference: OperationValueReference) => unknown
): unknown {
  return source.kind === "finalRef"
    ? lowerFinalRef(source.ref)
    : finalReferenceValue(source, referencedField, known, relationName, kind);
}

export function foreignKeyWriteValue(
  member: ForeignKeyMember,
  known: PlanningKnown | undefined,
  relationName: string,
  kind: string
): unknown {
  return finalReferenceValue(
    member.writeSource,
    member.referencedField,
    known,
    relationName,
    kind
  );
}

/**
 * THE assignment a root membership makes when the ROOT ROW ITSELF holds it: an
 * ordinary foreign key's columns, which ride in the record's own INSERT/UPDATE data,
 * or one atomic private `(type, id)` pair, which rides in its polymorphic storage.
 *
 * ONE union, because "which storage does this arm write" is the ONLY thing that
 * differed between the parent-held arms of the two memberships. Everything else a
 * parent-held arm owns — the probe, the guard, the branch decision, the before-parent
 * target, the race pin — is the same question with the same answer on both sides, so
 * they share the arms and this rides as a field.
 */
export type RootMembershipAssignment =
  | {
      readonly kind: "foreignKey";
      readonly data: Record<string, unknown>;
    }
  | {
      readonly kind: "polymorphic";
      readonly storage: PolymorphicStorageValue<FinalReferenceSource>;
    };

/**
 * Apply one root-membership assignment to the record's two sinks. The caller owns both
 * sinks and passes both; which one receives the value is this function's whole
 * decision, and it is the only place that decision is made.
 */
export function applyRootMembershipAssignment(
  engine: QueryEngine,
  assignment: RootMembershipAssignment,
  known: PlanningKnown | undefined,
  kind: string,
  data: Record<string, unknown>,
  polymorphicStorage: PolymorphicStorageValue<unknown>[]
): void {
  if (assignment.kind === "polymorphic") {
    polymorphicStorage.push(
      resolvePolymorphicStorageValue(engine, assignment.storage, known, kind)
    );
    return;
  }
  Object.assign(data, assignment.data);
}

/** Resolve and destination-lower the id member of one atomic private edge. */
export function resolvePolymorphicStorageValue(
  engine: QueryEngine,
  value: PolymorphicStorageValue<FinalReferenceSource>,
  known: PlanningKnown | undefined,
  kind: string
): PolymorphicStorageValue<unknown> {
  if (value.kind === "empty") return value;
  const { storage, referencedField } = value;
  const resolved = foreignKeyWriteValue(
    {
      foreignField: storage.idColumn.name,
      referencedField,
      writeSource: value.id,
    },
    known,
    storage.relationName,
    kind
  );
  return {
    ...value,
    id: referenceScalarSql(
      engine,
      storage.idColumn.scalar,
      storage.idColumn.name,
      resolved
    ),
  };
}

/** Bind a value to one bound private polymorphic membership. */
export function linkedPolymorphicStorage(
  membership: BoundPolymorphicMembership,
  id: FinalReferenceSource
): Extract<PolymorphicStorageValue<FinalReferenceSource>, { kind: "linked" }> {
  return {
    kind: "linked",
    storage: membership.storage,
    storedType: membership.storedType,
    referencedField: membership.referencedField,
    id,
  };
}

export function foreignKeyWriteValueWith(
  member: ForeignKeyMember,
  known: PlanningKnown | undefined,
  relationName: string,
  kind: string,
  lowerFinalRef: (reference: OperationValueReference) => unknown
): unknown {
  return finalReferenceValueWith(
    member.writeSource,
    member.referencedField,
    known,
    relationName,
    kind,
    lowerFinalRef
  );
}

export function foreignKeyCorrelationValue(
  member: CorrelatedForeignKeyMember
): OperationValueReference | unknown {
  return planningReferenceValue(member.readSource, member.referencedField);
}

export function foreignKeyResolvedReadValue(
  member: CorrelatedForeignKeyMember,
  known: PlanningKnown,
  relationName: string,
  kind: string
): unknown {
  return resolvedPlanningReferenceValue(
    member.readSource,
    member.referencedField,
    known,
    relationName,
    kind
  );
}

export function planningSourceFromFinal(
  source: FinalReferenceSource,
  relationName: string,
  kind: string
): PlanningReferenceSource {
  if (source.kind === "literal") return source;
  if (source.kind === "planningField") {
    return { kind: "planningField", step: source.step };
  }
  if (source.kind === "selectedRowContinuity") {
    return { kind: "planningField", step: source.step };
  }
  throw new QueryEngineError(
    `query-engine-v2 ${kind} for relation '${relationName}' requires a planned or literal parent id to correlate its probe.`
  );
}
