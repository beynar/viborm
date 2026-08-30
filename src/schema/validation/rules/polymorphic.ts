// The variant-storage subowner.
//
// It owns the PHYSICAL half of a variant carrier: the row-held `(type, id)`
// column pair and its portable-identity restriction, the per-variant member
// junction names and topologies, and the schema-wide reservation set every
// generated name is checked against. Pairing, inverse cardinality, and
// uniqueness are the relation resolver's; this module never discovers an
// inverse and never decides a topology.
//
// The mandatory relation-definition gate is its only caller.

import { sameDecimalDescriptor } from "@validation/primitives/decimal-codec";
import { isValidSchemaIdentifier } from "../../identifier";
import { getModelKeyCatalog, type Model } from "../../model";
import { automaticForeignKeyIndexName } from "../../relation/helpers";
import {
  type ResolvedJunctionTopology,
  resolveJunctionTopology,
  resolveVariantMemberNames,
  type VariantMemberNames,
} from "../../relation/junction-topology";
import type { VariantJunctionOverride } from "../../relation/types";
import { string } from "../../scalars";
import type { Scalar } from "../../scalars/base";
import { thrownAsError } from "../error";
import type { ResolvedVariantRowStorage } from "../relation-resolution";
import type {
  Schema,
  SchemaValidationIssue,
  ValidationContext,
} from "../types";
import { getScalars } from "./model-members";

const PORTABLE_ID_TYPES = new Set(["string", "int", "bigint", "decimal"]);

function issue(
  code: string,
  message: string,
  model: string,
  relation: string,
  repair: string
): SchemaValidationIssue {
  return { code, message, severity: "error", model, relation, repair };
}

// =============================================================================
// SCHEMA-WIDE PHYSICAL NAME RESERVATIONS
// =============================================================================

/** One resolved row foreign key, as the serializer's index derivation sees it. */
export interface StoredReferenceFact {
  readonly owner: Model<any>;
  readonly fields: readonly string[];
  /** A unique tuple is already covered and gets no automatic index. */
  readonly unique: boolean;
}

export interface ReservationInput {
  readonly schema: Schema;
  readonly ctx: ValidationContext;
  /** Table and canonical reverse-index name of every resolved ordinary junction. */
  readonly junctionNames: readonly string[];
  readonly storedReferences: readonly StoredReferenceFact[];
}

/**
 * Every physical name the schema already claims, in the spelling the migration
 * serializer emits: table names, declared and generated indexes, primary-key and
 * unique constraint names, automatic foreign-key indexes, and ordinary junction
 * tables with their reverse indexes. A generated variant storage name that lands
 * in this set is refused rather than silently shadowing an existing object.
 */
export function collectReservedPhysicalNames(
  input: ReservationInput
): Set<string> {
  const reserved = new Set<string>();
  for (const [candidateName, candidate] of input.schema) {
    const tableName = candidate["~"].state.tableName ?? candidateName;
    for (const index of candidate["~"].state.indexes) {
      reserved.add(
        index.options.name ?? `${tableName}_${index.fields.join("_")}_idx`
      );
    }
    const scalars = getScalars(candidate);
    if (
      scalars.some(([, scalar]) => scalar["~"].state.isId) ||
      candidate["~"].state.compoundId
    ) {
      reserved.add(`${tableName}_pkey`);
    }
    for (const [field, scalar] of scalars) {
      if (scalar["~"].state.isUnique && !scalar["~"].state.isId) {
        const column = scalar["~"].state.columnName ?? field;
        reserved.add(`${tableName}_${column}_key`);
      }
    }
    for (const constraint of Object.keys(
      candidate["~"].state.compoundUniques ?? {}
    )) {
      reserved.add(`${tableName}_${constraint}_key`);
    }
    for (const indexName of automaticForeignKeyIndexNames(
      candidate,
      tableName,
      input.storedReferences
    )) {
      reserved.add(indexName);
    }
  }
  for (const tableName of input.ctx.tableToModels.keys())
    reserved.add(tableName);
  for (const junctionName of input.junctionNames) reserved.add(junctionName);
  return reserved;
}

/**
 * The index names the serializer generates for foreign keys that no declared
 * key or index already covers — reserved so a variant member junction cannot
 * claim one of them.
 */
function automaticForeignKeyIndexNames(
  model: Model<any>,
  tableName: string,
  storedReferences: readonly StoredReferenceFact[]
): readonly string[] {
  const state = model["~"].state;
  const columnName = (field: string) =>
    state.scalars[field]?.["~"].state.columnName ?? field;
  const primaryKeyColumns = getScalars(model)
    .filter(([, scalar]) => scalar["~"].state.isId)
    .map(([field]) => columnName(field));
  // The FIRST declared compound id, read the way the key catalog reads it: a
  // second `.id([...])` is representable but F002 refuses it at push, so one
  // lookup answers and an absent record is simply no compound columns.
  const compoundIds: Record<string, { entries: Record<string, unknown> }> =
    state.compoundId ?? {};
  const [compoundId] = Object.values(compoundIds);
  if (compoundId) {
    primaryKeyColumns.push(...Object.keys(compoundId.entries).map(columnName));
  }
  const uniqueColumns = getScalars(model)
    .filter(([, scalar]) => scalar["~"].state.isUnique)
    .map(([field]) => [columnName(field)]);
  if (state.compoundUniques) {
    for (const constraintName of Object.keys(state.compoundUniques)) {
      const constraint = state.compoundUniques[constraintName];
      if (constraint?.entries) {
        uniqueColumns.push(Object.keys(constraint.entries).map(columnName));
      }
    }
  }
  const declaredIndexes = state.indexes.map((index) => {
    const declaredName = index.options.name;
    return {
      name:
        typeof declaredName === "string"
          ? declaredName
          : `${tableName}_${index.fields.join("_")}_idx`,
      columns: index.fields.map(columnName),
      where: index.options.where,
    };
  });
  const own = storedReferences.filter((fact) => fact.owner === model);
  const coveringColumns = [
    primaryKeyColumns,
    ...uniqueColumns,
    ...own
      .filter((fact) => fact.unique)
      .map((fact) => fact.fields.map(columnName)),
    ...declaredIndexes
      .filter((index) => !index.where)
      .map((index) => index.columns),
  ];
  const emittedNames = new Set<string>(
    declaredIndexes.map((index) => index.name)
  );
  const automaticNames: string[] = [];
  for (const fact of own) {
    if (fact.unique) continue;
    const foreignKeyColumns = fact.fields.map(columnName);
    const alreadyIndexed = coveringColumns.some((columns) =>
      foreignKeyColumns.every(
        (column, position) => columns[position] === column
      )
    );
    if (alreadyIndexed) continue;
    const name = automaticForeignKeyIndexName(
      tableName,
      foreignKeyColumns,
      emittedNames
    );
    if (name === undefined) continue;
    emittedNames.add(name);
    automaticNames.push(name);
  }
  return automaticNames;
}

// =============================================================================
// ROW-HELD VARIANT STORAGE
// =============================================================================

export interface VariantRowMemberInput {
  readonly variant: string;
  readonly target: Model<any>;
}

export interface VariantRowStorageInput {
  readonly modelName: string;
  readonly ownerTable: string;
  readonly relationName: string;
  /** `.optional()` on the carrier — the nullability of both private columns. */
  readonly optional: boolean;
  readonly members: readonly VariantRowMemberInput[];
  /** The owner's own column names; mutated as each carrier claims its pair. */
  readonly reservedColumns: Set<string>;
  /** Schema-wide index names; mutated as each carrier claims its index. */
  readonly reservedIndexes: Set<string>;
  /** How many carriers in the whole schema generate each poly index name. */
  readonly indexNameCounts: ReadonlyMap<string, number>;
}

export interface VariantRowStorageResult {
  /** Present only when every member resolved and the names are legal. */
  readonly storage: ResolvedVariantRowStorage | undefined;
  /** Variant key → the target's single scalar primary-key field. */
  readonly referencedFields: ReadonlyMap<string, string>;
  readonly issues: readonly SchemaValidationIssue[];
}

/**
 * The row-held `(type, id)` pair: one shared private column pair and one
 * composite index for the whole carrier, so every variant must expose the same
 * portable single-scalar identity.
 */
export function checkVariantRowStorage(
  input: VariantRowStorageInput
): VariantRowStorageResult {
  const { modelName, relationName } = input;
  const issues: SchemaValidationIssue[] = [];
  const typeColumnName = `${relationName}_type`;
  const idColumnName = `${relationName}_id`;
  const indexName = `${input.ownerTable}_${relationName}_poly_idx`;
  const namesValid =
    isValidSchemaIdentifier(typeColumnName) &&
    isValidSchemaIdentifier(idColumnName) &&
    isValidSchemaIdentifier(indexName) &&
    !input.reservedColumns.has(typeColumnName) &&
    !input.reservedColumns.has(idColumnName) &&
    !input.reservedIndexes.has(indexName) &&
    // The prepass counted this exact name for every row carrier, so the entry
    // is there to read and a second default would be a second owner for it.
    input.indexNameCounts.get(indexName)! === 1;
  if (!namesValid) {
    issues.push(
      issue(
        "P008",
        `Variant relation '${relationName}' in '${modelName}' has invalid or colliding generated storage names`,
        modelName,
        relationName,
        `Rename the relation field or .map() the owner table so '${typeColumnName}', '${idColumnName}' and '${indexName}' are free`
      )
    );
  }
  input.reservedColumns.add(typeColumnName);
  input.reservedColumns.add(idColumnName);
  input.reservedIndexes.add(indexName);

  const referencedFields = new Map<string, string>();
  const identities: Scalar[] = [];
  for (const member of input.members) {
    const primaryKey = singlePrimaryKey(member.target);
    if (!primaryKey) {
      issues.push(
        issue(
          "P009",
          `Variant '${member.variant}' in '${modelName}.${relationName}' requires one scalar primary key`,
          modelName,
          relationName,
          `Give the '${member.variant}' target a single scalar .id() field`
        )
      );
      continue;
    }
    referencedFields.set(member.variant, primaryKey.field);
    identities.push(primaryKey.scalar);
  }

  const firstIdentity = identities[0];
  const portable =
    firstIdentity !== undefined &&
    identities.every((scalar) =>
      hasCompatibleVariantIdentity(firstIdentity, scalar)
    );
  if (identities.length > 0 && !portable) {
    issues.push(
      issue(
        "P002",
        `Variant targets in '${modelName}.${relationName}' require one compatible portable primary-key representation`,
        modelName,
        relationName,
        "Give every variant target the same portable scalar id representation: one shared string, int, or bigint type, or decimal IDs with identical precision and scale"
      )
    );
  }

  const complete =
    namesValid && portable && referencedFields.size === input.members.length;
  const nullable = input.optional;
  return {
    storage:
      complete && firstIdentity
        ? {
            typeColumn: {
              name: typeColumnName,
              scalar: string(),
              nullable,
            },
            idColumn: {
              name: idColumnName,
              scalar: firstIdentity,
              nullable,
            },
            indexName,
          }
        : undefined,
    referencedFields,
    issues,
  };
}

function hasCompatibleVariantIdentity(
  first: Scalar,
  candidate: Scalar
): boolean {
  const firstState = first["~"].state;
  const candidateState = candidate["~"].state;
  if (
    !PORTABLE_ID_TYPES.has(candidateState.type) ||
    candidateState.array === true ||
    candidate["~"].nativeType !== undefined ||
    candidateState.type !== firstState.type
  ) {
    return false;
  }
  if (candidateState.type !== "decimal") return true;
  const firstDescriptor = firstState.decimal;
  const candidateDescriptor = candidateState.decimal;
  return (
    firstDescriptor !== undefined &&
    candidateDescriptor !== undefined &&
    sameDecimalDescriptor(candidateDescriptor, firstDescriptor)
  );
}

/** The generated composite index name of one row-held carrier. */
export function variantRowIndexName(
  ownerTable: string,
  relationName: string
): string {
  return `${ownerTable}_${relationName}_poly_idx`;
}

function singlePrimaryKey(
  model: Model<any>
): { readonly field: string; readonly scalar: Scalar } | undefined {
  if (
    model["~"].state.compoundId &&
    Object.keys(model["~"].state.compoundId).length > 0
  ) {
    return undefined;
  }
  const primaryKeys = getScalars(model).filter(
    ([, scalar]) => scalar["~"].state.isId
  );
  if (primaryKeys.length !== 1) return undefined;
  const [field, scalar] = primaryKeys[0]!;
  return { field, scalar };
}

// =============================================================================
// MEMBER JUNCTION STORAGE
// =============================================================================

export interface VariantMemberInput {
  readonly variant: string;
  readonly target: Model<any>;
  readonly targetName: string;
  readonly junction: VariantJunctionOverride | undefined;
}

export interface VariantMemberJunctionInput {
  readonly modelName: string;
  readonly model: Model<any>;
  readonly ownerTable: string;
  readonly relationName: string;
  readonly members: readonly VariantMemberInput[];
  readonly reservedColumns: ReadonlySet<string>;
  /** Mutated: a refused member still claims its names, so a later flip cannot collide. */
  readonly reservedIndexes: Set<string>;
  /** Schema-wide claim counts, so a member can tell its own claim from a rival's. */
  readonly memberNameCounts: ReadonlyMap<string, number>;
}

export interface VariantMemberJunctionResult {
  readonly topologies: ReadonlyMap<string, ResolvedJunctionTopology>;
  readonly issues: readonly SchemaValidationIssue[];
}

/** Per-variant member junctions: one fixed-target junction per variant. */
export function checkVariantMemberJunctions(
  input: VariantMemberJunctionInput
): VariantMemberJunctionResult {
  const { modelName, relationName } = input;
  const issues: SchemaValidationIssue[] = [];
  const topologies = new Map<string, ResolvedJunctionTopology>();
  const ownerRowKey = getModelKeyCatalog(input.model).rowKey?.fields;
  if (!ownerRowKey?.length) {
    issues.push(
      issue(
        "P018",
        `Variant relation '${relationName}' in '${modelName}' requires a complete owner row key for its member junctions`,
        modelName,
        relationName,
        `Declare a primary key on '${modelName}'`
      )
    );
    return { topologies, issues };
  }

  for (const member of input.members) {
    const targetRowKey = getModelKeyCatalog(member.target).rowKey?.fields;
    if (!targetRowKey?.length) {
      issues.push(
        issue(
          "P009",
          `Variant '${member.variant}' in '${modelName}.${relationName}' requires a complete row key`,
          modelName,
          relationName,
          `Declare a primary key on '${member.targetName}'`
        )
      );
      continue;
    }
    const names = resolveVariantMemberNames({
      ownerTableName: input.ownerTable,
      ownerModelName: modelName,
      relationField: relationName,
      publicType: member.variant,
      ownerRowKeyIsCompound: ownerRowKey.length > 1,
      targetRowKeyIsCompound: targetRowKey.length > 1,
      junction: member.junction,
    });
    try {
      const topology = resolveJunctionTopology({
        table: names.table,
        source: {
          model: input.model,
          modelName,
          rowKey: ownerRowKey,
          token: names.sourceToken,
        },
        target: {
          model: member.target,
          modelName: member.targetName,
          rowKey: targetRowKey,
          token: names.targetToken,
        },
        pairName: `${modelName}.${relationName}.${member.variant}`,
      });
      const sourceForeignKey = topology.foreignKeyName("source");
      const targetForeignKey = topology.foreignKeyName("target");
      const reverseIndex = topology.reverseIndexName();
      const uniqueTarget = topology.uniqueTargetName();
      const collision = [names.table, reverseIndex].find(
        (physicalName) =>
          !isValidSchemaIdentifier(physicalName) ||
          input.reservedColumns.has(physicalName) ||
          input.reservedIndexes.has(physicalName) ||
          // Counted for every member the prepass planned, this one included.
          input.memberNameCounts.get(physicalName)! > 1
      );
      // Reserved even when refused: a refused member still claims its physical
      // names, so an inverse flip elsewhere cannot newly collide a schema that
      // was already valid.
      input.reservedIndexes.add(names.table);
      input.reservedIndexes.add(sourceForeignKey);
      input.reservedIndexes.add(targetForeignKey);
      input.reservedIndexes.add(reverseIndex);
      input.reservedIndexes.add(uniqueTarget);
      if (collision !== undefined) {
        issues.push(
          issue(
            "P019",
            `Variant '${member.variant}' in '${modelName}.${relationName}' has an invalid or colliding junction name '${collision}'`,
            modelName,
            relationName,
            `Give this variant an explicit .through({ ${member.variant}: { table, source, target } }) entry`
          )
        );
        continue;
      }
      topologies.set(member.variant, topology);
    } catch (error) {
      // Every throw on this path is a physical-name refusal: both row keys are
      // proven non-empty above, and no other guard exists on the member path.
      input.reservedIndexes.add(names.table);
      issues.push(
        issue(
          "P019",
          thrownAsError(error).message,
          modelName,
          relationName,
          `Give this variant an explicit .through({ ${member.variant}: { table, source, target } }) entry`
        )
      );
    }
  }
  return { topologies, issues };
}

/**
 * The names one member junction WOULD claim — the counting prepass's input, so
 * a member can tell "someone else claims this name" from its own single claim.
 * `undefined` when the member has no complete row key to expand.
 */
export function planVariantMemberNames(input: {
  readonly model: Model<any>;
  readonly modelName: string;
  readonly ownerTable: string;
  readonly relationName: string;
  readonly member: VariantMemberInput;
}):
  | { readonly names: VariantMemberNames; readonly claims: readonly string[] }
  | undefined {
  const ownerRowKey = getModelKeyCatalog(input.model).rowKey?.fields;
  const targetRowKey = getModelKeyCatalog(input.member.target).rowKey?.fields;
  if (!(ownerRowKey?.length && targetRowKey?.length)) return undefined;
  const names = resolveVariantMemberNames({
    ownerTableName: input.ownerTable,
    ownerModelName: input.modelName,
    relationField: input.relationName,
    publicType: input.member.variant,
    ownerRowKeyIsCompound: ownerRowKey.length > 1,
    targetRowKeyIsCompound: targetRowKey.length > 1,
    junction: input.member.junction,
  });
  try {
    const topology = resolveJunctionTopology({
      table: names.table,
      source: {
        model: input.model,
        modelName: input.modelName,
        rowKey: ownerRowKey,
        token: names.sourceToken,
      },
      target: {
        model: input.member.target,
        modelName: input.member.targetName,
        rowKey: targetRowKey,
        token: names.targetToken,
      },
      pairName: undefined,
    });
    return {
      names,
      claims: [
        names.table,
        topology.foreignKeyName("source"),
        topology.foreignKeyName("target"),
        topology.reverseIndexName(),
      ],
    };
  } catch {
    // A member whose names cannot even be expanded claims only its table; the
    // per-member pass reports the refusal.
    return { names, claims: [names.table] };
  }
}
