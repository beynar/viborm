import { isValidSchemaIdentifier } from "../../identifier";
import { Model } from "../../model";
import {
  collectInverseCandidates,
  generateJunctionFieldName,
  generateJunctionTableName,
  getPolymorphicInverseBinding,
  getPolymorphicInverseCandidates,
  type PolymorphicInverseCardinality,
  type PolymorphicStorageMember,
} from "../../relation";
import { string } from "../../scalars";
import type { Scalar } from "../../scalars/base";
import type {
  Schema,
  SchemaValidationIssue,
  ValidationContext,
  ValidationRule,
} from "../types";
import {
  findModelName,
  getPolymorphicRelations,
  getRelations,
  getScalars,
} from "./model-members";

const STORED_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;
const PORTABLE_ID_TYPES = new Set(["string", "int", "bigint"]);

function issue(
  code: string,
  message: string,
  model: string,
  relation: string,
  severity: "error" | "warning" = "error"
): SchemaValidationIssue {
  return { code, message, severity, model, relation };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeys(value: unknown): readonly PropertyKey[] {
  if (typeof value !== "object" || value === null) return [];
  return Reflect.ownKeys(value);
}

function ownStringKeys(value: unknown): string[] {
  return ownKeys(value).filter((key): key is string => typeof key === "string");
}

function junctionPhysicalNames(
  schema: Schema,
  ctx: ValidationContext
): Set<string> {
  const names = new Set<string>();
  for (const [sourceName, source] of schema) {
    for (const [, relation] of getRelations(source)) {
      const state = relation["~"].state;
      if (state.type !== "manyToMany") continue;
      const target = state.getter();
      const targetName = findModelName(ctx, target);
      if (!targetName) continue;
      const candidates = getRelations(target).filter(([, candidate]) => {
        const candidateState = candidate["~"].state;
        return (
          candidateState.type === "manyToMany" &&
          candidateState.getter() === source
        );
      });
      const compatible = candidates.filter(([, candidate]) => {
        const pairedName = candidate["~"].state.name;
        return !(
          state.name !== undefined &&
          pairedName !== undefined &&
          state.name !== pairedName
        );
      });
      const paired =
        compatible.length === 1
          ? compatible[0]?.[1]["~"].state
          : compatible.filter(
                ([, candidate]) => candidate["~"].state.name === state.name
              ).length === 1
            ? compatible.find(
                ([, candidate]) => candidate["~"].state.name === state.name
              )?.[1]["~"].state
            : undefined;
      if (
        state.through !== undefined &&
        paired?.through !== undefined &&
        state.through !== paired.through
      ) {
        continue;
      }
      const explicit = state.through ?? paired?.through;
      const base = generateJunctionTableName(sourceName, targetName);
      const tableName =
        explicit ??
        ((state.name ?? paired?.name)
          ? `${base}_${state.name ?? paired?.name}`
          : base);
      names.add(tableName);
      const sourceColumn =
        state.A ??
        paired?.B ??
        (sourceName === targetName
          ? `${sourceName.toLowerCase()}AId`
          : generateJunctionFieldName(sourceName));
      const targetColumn =
        state.B ??
        paired?.A ??
        (sourceName === targetName
          ? `${targetName.toLowerCase()}BId`
          : generateJunctionFieldName(targetName));
      const sourceSide = {
        column: sourceColumn,
        sortKey: sourceName.toLowerCase(),
      };
      const targetSide = {
        column: targetColumn,
        sortKey: targetName.toLowerCase(),
      };
      let [first, second] = [sourceSide, targetSide];
      if (
        first.sortKey > second.sortKey ||
        (first.sortKey === second.sortKey && first.column > second.column)
      ) {
        [first, second] = [second, first];
      }
      names.add(`${tableName}_${second.column}_idx`);
    }
  }
  return names;
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

function serializedForeignKeyIndexNames(
  model: Model<any>,
  tableName: string
): readonly string[] {
  const state = model["~"].state;
  const columnName = (field: string) =>
    state.scalars[field]?.["~"].state.columnName ?? field;
  const primaryKeyColumns = getScalars(model)
    .filter(([, scalar]) => scalar["~"].state.isId)
    .map(([field]) => columnName(field));
  if (state.compoundId) {
    const compoundIdName = Object.keys(state.compoundId)[0];
    const compoundId = compoundIdName
      ? state.compoundId[compoundIdName]
      : undefined;
    if (compoundId?.entries) {
      primaryKeyColumns.push(
        ...Object.keys(compoundId.entries).map(columnName)
      );
    }
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
  const declaredIndexes = state.indexes.map((index) => ({
    name: index.options.name ?? `${tableName}_${index.fields.join("_")}_idx`,
    columns: index.fields.map(columnName),
    where: index.options.where,
  }));
  const oneToOneColumns = getRelations(model)
    .map(([, relation]) => relation["~"].state)
    .filter(
      (relation) =>
        relation.type === "oneToOne" &&
        relation.fields !== undefined &&
        relation.references !== undefined &&
        relation.getter()?.["~"]
    )
    .map((relation) => relation.fields!.map(columnName));
  const coveringColumns = [
    primaryKeyColumns,
    ...uniqueColumns,
    ...oneToOneColumns,
    ...declaredIndexes
      .filter((index) => !index.where)
      .map((index) => index.columns),
  ];
  const emittedNames = new Set(declaredIndexes.map((index) => index.name));
  const automaticNames: string[] = [];
  for (const [, relation] of getRelations(model)) {
    const relationState = relation["~"].state;
    if (
      relationState.type !== "manyToOne" ||
      relationState.fields === undefined ||
      relationState.references === undefined ||
      !relationState.getter()?.["~"]
    ) {
      continue;
    }
    const foreignKeyColumns = relationState.fields.map(columnName);
    const alreadyIndexed = coveringColumns.some((columns) =>
      foreignKeyColumns.every(
        (column, position) => columns[position] === column
      )
    );
    if (alreadyIndexed) continue;
    const preferredName = `${tableName}_${foreignKeyColumns.join("_")}_idx`;
    const name = emittedNames.has(preferredName)
      ? `${tableName}_${foreignKeyColumns.join("_")}_fkey_idx`
      : preferredName;
    if (emittedNames.has(name)) continue;
    emittedNames.add(name);
    automaticNames.push(name);
  }
  return automaticNames;
}

function validateInverseBindings(
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  for (const [relationName, relation] of getRelations(model)) {
    const relationState = relation["~"].state;
    const isPolymorphicInverseCandidate =
      relationState.type === "oneToMany" ||
      (relationState.type === "oneToOne" &&
        (relationState.fields === undefined ||
          relationState.fields.length === 0));
    if (!isPolymorphicInverseCandidate) continue;
    const target = relationState.getter();
    if (!findModelName(ctx, target)) continue;
    const candidates = getPolymorphicInverseCandidates(target, model);
    if (candidates.length === 0) continue;
    const relationGroups = getPolymorphicRelations(target);
    const pairingName = relationState.name;
    // The ONE ordinary-candidate scan (`@schema/relation/inverse`). What
    // follows is NOT a second resolution: the resolver answers WHICH edge
    // wins, while this rule enumerates the ways a polymorphic pairing can be
    // ill-formed (P004/P005/P010) — reasons a bare `missing` verdict cannot
    // carry. The two agree by construction on the atoms they share.
    const ordinaryInverses = collectInverseCandidates(target, model);
    const namedPolymorphic =
      pairingName === undefined
        ? []
        : relationGroups.filter(
            ([, candidate]) => candidate["~"].state.name === pairingName
          );
    const namedOrdinary =
      pairingName === undefined
        ? []
        : ordinaryInverses.filter(
            (candidate) => candidate.pairingName === pairingName
          );
    if (namedPolymorphic.length > 0 && namedOrdinary.length > 0) {
      issues.push(
        issue(
          "P004",
          `Polymorphic inverse '${relationName}' in '${name}' cannot share pairing name '${pairingName}' with an ordinary inverse`,
          name,
          relationName
        )
      );
      continue;
    }
    if (namedPolymorphic.length !== 1 && ordinaryInverses.length > 0) {
      continue;
    }
    let selectedRelationKey: string | undefined;
    if (relationGroups.length === 1) {
      selectedRelationKey = relationGroups[0]?.[0];
    } else if (pairingName === undefined) {
      issues.push(
        issue(
          "P005",
          `Polymorphic inverse '${relationName}' in '${name}' targets a model with multiple polymorphic relations and requires .name()`,
          name,
          relationName
        )
      );
      continue;
    } else {
      const named = relationGroups.filter(
        ([, candidate]) => candidate["~"].state.name === pairingName
      );
      if (named.length !== 1) {
        issues.push(
          issue(
            "P004",
            `Polymorphic inverse '${relationName}' in '${name}' must select exactly one candidate with .name('${pairingName}')`,
            name,
            relationName
          )
        );
        continue;
      }
      selectedRelationKey = named[0]?.[0];
    }
    const selected = candidates.filter(
      (candidate) => candidate.relationKey === selectedRelationKey
    );
    if (selected?.length !== 1) {
      issues.push(
        issue(
          "P010",
          `Polymorphic inverse '${relationName}' in '${name}' occurs more than once in its selected target map`,
          name,
          relationName
        )
      );
    }
  }
  return issues;
}

function inverseCardinality(
  schema: Schema,
  owner: Model<any>,
  relationName: string
): PolymorphicInverseCardinality | "mixed" {
  const cardinalities = new Set<PolymorphicInverseCardinality>();
  for (const [, source] of schema) {
    for (const [, relation] of getRelations(source)) {
      const state = relation["~"].state;
      const cardinality =
        state.type === "oneToMany"
          ? "many"
          : state.type === "oneToOne" &&
              (state.fields === undefined || state.fields.length === 0)
            ? "one"
            : undefined;
      if (!cardinality || state.getter() !== owner) continue;
      const binding = getPolymorphicInverseBinding(owner, source, state.name);
      if (binding?.relationKey === relationName) cardinalities.add(cardinality);
    }
  }
  if (cardinalities.size > 1) return "mixed";
  return cardinalities.values().next().value ?? "many";
}

export function validatePolymorphicRelations(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const issues = validateInverseBindings(name, model, ctx);
  const reservedColumns = new Set(
    getScalars(model).map(
      ([field, scalar]) => scalar["~"].state.columnName ?? field
    )
  );
  const reservedIndexes = new Set<string>();
  for (const [candidateName, candidate] of schema) {
    const tableName = candidate["~"].state.tableName ?? candidateName;
    for (const index of candidate["~"].state.indexes) {
      reservedIndexes.add(
        index.options.name ?? `${tableName}_${index.fields.join("_")}_idx`
      );
    }
    const scalars = getScalars(candidate);
    if (
      scalars.some(([, scalar]) => scalar["~"].state.isId) ||
      candidate["~"].state.compoundId
    ) {
      reservedIndexes.add(`${tableName}_pkey`);
    }
    for (const [field, scalar] of scalars) {
      if (scalar["~"].state.isUnique && !scalar["~"].state.isId) {
        const column = scalar["~"].state.columnName ?? field;
        reservedIndexes.add(`${tableName}_${column}_key`);
      }
    }
    for (const constraint of Object.keys(
      candidate["~"].state.compoundUniques ?? {}
    )) {
      reservedIndexes.add(`${tableName}_${constraint}_key`);
    }
    for (const indexName of serializedForeignKeyIndexNames(
      candidate,
      tableName
    )) {
      reservedIndexes.add(indexName);
    }
  }
  for (const tableName of ctx.tableToModels.keys())
    reservedIndexes.add(tableName);
  for (const physicalName of junctionPhysicalNames(schema, ctx)) {
    reservedIndexes.add(physicalName);
  }
  const ownerTable = model["~"].state.tableName ?? name;

  for (const [relationName, relation] of getPolymorphicRelations(model)) {
    const errorCount = issues.filter(
      (entry) => entry.severity === "error"
    ).length;
    const state = relation["~"].state;
    const targets: unknown = state.targets;
    const values: unknown = state.values;
    const targetOwnKeys = ownKeys(targets);
    const valueOwnKeys = ownKeys(values);
    const targetKeys = ownStringKeys(targets);
    const valueKeys = ownStringKeys(values);

    if (isPlainRecord(targets) && targetKeys.length === 0) {
      issues.push(
        issue(
          "P007",
          `Polymorphic relation '${relationName}' in '${name}' requires at least one target`,
          name,
          relationName
        )
      );
    }
    const targetEntries = isPlainRecord(targets)
      ? relation["~"].targetEntries()
      : [];
    if (targetKeys.length === 1) {
      issues.push(
        issue(
          "P011",
          `Polymorphic relation '${relationName}' in '${name}' has one target; use an ordinary relation unless future variants are required`,
          name,
          relationName,
          "warning"
        )
      );
    }

    const exactValues =
      isPlainRecord(targets) &&
      isPlainRecord(values) &&
      targetOwnKeys.length === targetKeys.length &&
      valueOwnKeys.length === valueKeys.length &&
      targetKeys.length === valueKeys.length &&
      targetKeys.every((publicType) => valueKeys.includes(publicType));
    const storedValues = isPlainRecord(values)
      ? valueKeys.map((publicType) => Reflect.get(values, publicType))
      : [];
    if (
      !exactValues ||
      targetKeys.some((publicType) => !isValidSchemaIdentifier(publicType)) ||
      storedValues.some(
        (storedType) =>
          typeof storedType !== "string" || !STORED_TYPE.test(storedType)
      ) ||
      new Set(storedValues).size !== storedValues.length
    ) {
      issues.push(
        issue(
          "P003",
          `Polymorphic relation '${relationName}' in '${name}' has invalid or non-unique discriminator keys/values`,
          name,
          relationName
        )
      );
    }

    const typeColumnName = `${relationName}_type`;
    const idColumnName = `${relationName}_id`;
    const indexName = `${ownerTable}_${relationName}_poly_idx`;
    const generatedNamesValid =
      isValidSchemaIdentifier(typeColumnName) &&
      isValidSchemaIdentifier(idColumnName) &&
      isValidSchemaIdentifier(indexName) &&
      !reservedColumns.has(typeColumnName) &&
      !reservedColumns.has(idColumnName) &&
      !reservedIndexes.has(indexName) &&
      [...schema].filter(([candidateName, candidate]) => {
        const table = candidate["~"].state.tableName ?? candidateName;
        return getPolymorphicRelations(candidate).some(
          ([candidateRelation]) =>
            `${table}_${candidateRelation}_poly_idx` === indexName
        );
      }).length === 1;
    if (!generatedNamesValid) {
      issues.push(
        issue(
          "P008",
          `Polymorphic relation '${relationName}' in '${name}' has invalid or colliding generated storage names`,
          name,
          relationName
        )
      );
    }
    reservedColumns.add(typeColumnName);
    reservedColumns.add(idColumnName);
    reservedIndexes.add(indexName);

    const resolvedTargets: Array<{
      readonly publicType: string;
      readonly storedType: string;
      readonly targetModel: Model<any>;
      readonly primaryKey: { readonly field: string; readonly scalar: Scalar };
    }> = [];
    for (const {
      publicType,
      targetGetter,
      targetModel,
      storedType,
    } of targetEntries) {
      if (typeof targetGetter !== "function") {
        issues.push(
          issue(
            "P001",
            `Polymorphic target '${publicType}' in '${name}.${relationName}' is not a model getter`,
            name,
            relationName
          )
        );
        continue;
      }
      if (!(targetModel instanceof Model && ctx.modelToName.has(targetModel))) {
        issues.push(
          issue(
            "P001",
            `Polymorphic target '${publicType}' in '${name}.${relationName}' is not registered in the schema`,
            name,
            relationName
          )
        );
        continue;
      }
      const primaryKey = singlePrimaryKey(targetModel);
      if (!primaryKey) {
        issues.push(
          issue(
            "P009",
            `Polymorphic target '${publicType}' in '${name}.${relationName}' requires one scalar primary key`,
            name,
            relationName
          )
        );
        continue;
      }
      if (typeof storedType !== "string") continue;
      resolvedTargets.push({
        publicType,
        storedType,
        targetModel,
        primaryKey,
      });
    }

    const firstType = resolvedTargets[0]?.primaryKey.scalar["~"].state.type;
    const portableIds = resolvedTargets.every(({ primaryKey }) => {
      const scalar = primaryKey.scalar;
      return (
        PORTABLE_ID_TYPES.has(scalar["~"].state.type) &&
        !scalar["~"].state.array &&
        scalar["~"].nativeType === undefined &&
        scalar["~"].state.type === firstType
      );
    });
    if (resolvedTargets.length > 0 && !portableIds) {
      issues.push(
        issue(
          "P002",
          `Polymorphic targets in '${name}.${relationName}' require one compatible portable primary-key representation`,
          name,
          relationName
        )
      );
    }

    const nextErrorCount = issues.filter(
      (entry) => entry.severity === "error"
    ).length;
    if (
      nextErrorCount !== errorCount ||
      resolvedTargets.length !== targetEntries.length ||
      resolvedTargets.length === 0
    ) {
      continue;
    }

    const firstTarget = resolvedTargets[0]!;
    const cardinality = inverseCardinality(schema, model, relationName);
    if (cardinality === "mixed") {
      issues.push(
        issue(
          "P012",
          `Polymorphic relation '${relationName}' in '${name}' cannot mix one-to-one and one-to-many inverses`,
          name,
          relationName
        )
      );
      continue;
    }
    const members = new Map<string, PolymorphicStorageMember>();
    for (const target of resolvedTargets) {
      members.set(target.publicType, {
        storedType: target.storedType,
        targetModel: target.targetModel,
        referencedField: target.primaryKey.field,
      });
    }
    const nullable = state.optional === true;
    model["~"].setPolymorphicStorage(relationName, {
      relationName,
      ownerModel: model,
      indexName,
      typeColumn: { name: typeColumnName, scalar: string(), nullable },
      idColumn: {
        name: idColumnName,
        scalar: firstTarget.primaryKey.scalar,
        nullable,
      },
      inverseCardinality: cardinality,
      members,
    });
  }
  return issues;
}

export const polymorphicRules: ValidationRule[] = [
  validatePolymorphicRelations,
];
