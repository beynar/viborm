import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import type { PolymorphicChildHeldToMany } from "../builders/relation-data-builder";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import type { QueryEngine } from "../query-engine";
import { referenceScalarSql } from "./fragment-builders";
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
      readonly apply: (before: unknown) => unknown;
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

export function pairForeignKeyMembers(
  foreignFields: readonly string[],
  referencedFields: readonly string[],
  writeSources: readonly FinalReferenceSource[]
): ForeignKeyMember[] {
  assertEqualArity(foreignFields, referencedFields, writeSources);
  return foreignFields.map((foreignField, index) => ({
    foreignField,
    referencedField: referencedFields[index]!,
    writeSource: writeSources[index]!,
  }));
}

export function pairCorrelatedForeignKeyMembers(
  foreignFields: readonly string[],
  referencedFields: readonly string[],
  readSources: readonly PlanningReferenceSource[],
  writeSources: readonly FinalReferenceSource[]
): CorrelatedForeignKeyMember[] {
  assertEqualArity(foreignFields, referencedFields, readSources, writeSources);
  return foreignFields.map((foreignField, index) => ({
    foreignField,
    referencedField: referencedFields[index]!,
    readSource: readSources[index]!,
    writeSource: writeSources[index]!,
  }));
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
    ? source.apply(before)
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

/** Resolve the identity half of a private polymorphic edge for a planning SQL
 * predicate. The discriminator stays schema-bound; only the parent identity has
 * runtime provenance. */
export function polymorphicPlanningIdentitySql(
  engine: QueryEngine,
  value: Extract<
    PolymorphicStorageValue<FinalReferenceSource>,
    { kind: "linked" }
  >,
  kind: string
): Sql {
  const { storage, referencedField } = value;
  const resolved = foreignKeyCorrelationValue({
    foreignField: storage.idColumn.name,
    referencedField,
    writeSource: value.id,
    readSource: planningSourceFromFinal(
      value.id,
      storage.relationName,
      kind
    ),
  });
  return referenceScalarSql(
    engine,
    storage.idColumn.scalar,
    storage.idColumn.name,
    resolved
  );
}

/** Bind a parent value to the one private edge owned by a polymorphic inverse. */
export function linkedPolymorphicStorage(
  relation: PolymorphicChildHeldToMany,
  id: FinalReferenceSource
): Extract<
  PolymorphicStorageValue<FinalReferenceSource>,
  { kind: "linked" }
> {
  return {
    kind: "linked",
    storage: relation.storage,
    storedType: relation.storedType,
    referencedField: relation.referencedFields[0],
    id,
  };
}

/** Resolve the identity half of a private edge for final-fragment SQL. */
export function polymorphicFinalIdentitySql(
  engine: QueryEngine,
  relation: PolymorphicChildHeldToMany,
  id: FinalReferenceSource,
  known: PlanningKnown,
  kind: string
): Sql {
  const value = linkedPolymorphicStorage(relation, id);
  const resolved = foreignKeyWriteValue(
    {
      foreignField: relation.storage.idColumn.name,
      referencedField: relation.referencedFields[0],
      writeSource: id,
    },
    known,
    relation.relationInfo.name,
    kind
  );
  return referenceScalarSql(
    engine,
    value.storage.idColumn.scalar,
    value.storage.idColumn.name,
    resolved
  );
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

function assertEqualArity(
  foreignFields: readonly string[],
  referencedFields: readonly string[],
  ...sources: readonly (readonly unknown[])[]
): void {
  const arities = [foreignFields.length, referencedFields.length];
  for (const source of sources) arities.push(source.length);
  if (arities.every((arity) => arity === arities[0])) return;
  throw new QueryEngineError(
    `query-engine-v2 internal: foreign-key member arity mismatch (${arities.join(", ")}).`
  );
}
