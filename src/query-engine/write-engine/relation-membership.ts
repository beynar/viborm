import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import { buildPolymorphicMembershipPredicate } from "../builders/correlation-utils";
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
       * D1 — the transformation is FIELD-AGNOSTIC and the field comes from the
       * member it is bound to, so one source stays per-member correct however many
       * members it is bound across. A source that closed its field in was correct
       * only when built inside a per-member `map`, which made every broadcast site
       * (`bindRelationMembership`, `bindCorrelatedRelationMembership`, every
       * `referencedFields.map(() => source)`) a latent compound collapse.
       */
      readonly apply: (before: unknown, referencedField: string) => unknown;
    }
  | { readonly kind: "lookup"; readonly statement: Sql };

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

export function planningMembershipCondition(
  engine: QueryEngine,
  childScope: QueryScope,
  binding: CorrelatedRelationMembershipBinding,
  qualifier: string
) {
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
) {
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
  const relation = binding.relation;
  const { membership } = relation;
  const identity = referenceScalarSql(
    engine,
    membership.storage.idColumn.scalar,
    membership.storage.idColumn.name,
    resolvedPlanningReferenceValue(
      binding.readSource,
      membership.referencedField,
      known,
      relationName,
      operation
    )
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
  return source.kind === "transitionedPlanningField"
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
  throw new QueryEngineError(
    `query-engine-v2 ${kind} for relation '${relationName}' requires a planned or literal parent id to correlate its probe.`
  );
}
