/**
 * Relation Data Builder
 *
 * Handles nested write operations: create, createMany, connect,
 * connectOrCreate, disconnect, delete, deleteMany, set, update,
 * updateMany, and upsert.
 * Separates scalar and relation data, builds connect subqueries, and manages FK direction.
 */

import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import {
  createChildContext,
  getColumnName,
  getRelationInfo,
  getTableName,
  isRelation,
} from "../context";
import {
  NestedWriteError,
  type QueryContext,
  QueryEngineError,
  type RelationInfo,
} from "../types";
import {
  findInverseRelationState,
  getPrimaryKeyFields,
} from "./correlation-utils";
import {
  hasSupportedNestedWriteInput,
  SUPPORTED_NESTED_WRITE_KEYS,
} from "./nested-write-detector";
import { buildWhereUnique } from "./where-unique-builder";

// ============================================================
// TYPES
// ============================================================

/**
 * Separated scalar and relation data from input
 */
export interface SeparatedData {
  /** Scalar data to INSERT/UPDATE directly */
  scalarData: Record<string, unknown>;
  /** Relation mutations to process */
  relations: Record<string, RelationMutation>;
}

/**
 * CreateMany input shape
 */
export interface CreateManyInput {
  data: Record<string, unknown>[];
  skipDuplicates?: boolean;
}

/**
 * Targeted nested update input for to-many relations
 */
export interface NestedUpdateInput {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

/**
 * Set-based nested update input for to-many relations
 */
export interface NestedUpdateManyInput {
  where?: Record<string, unknown>;
  data: Record<string, unknown>;
}

/**
 * Nested upsert input. To-one upserts do not use where; to-many upserts do.
 */
export interface NestedUpsertInput {
  where?: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/**
 * A single relation mutation operation
 */
export interface RelationMutation {
  /** Relation metadata */
  relationInfo: RelationInfo;
  /** Connect to existing record(s) */
  connect?: Record<string, unknown> | Record<string, unknown>[];
  /** Disconnect from related record(s) */
  disconnect?: boolean | Record<string, unknown> | Record<string, unknown>[];
  /** Create new related record(s) */
  create?: Record<string, unknown> | Record<string, unknown>[];
  /** Create many new related records */
  createMany?: CreateManyInput;
  /** Connect if exists, otherwise create */
  connectOrCreate?: ConnectOrCreateInput | ConnectOrCreateInput[];
  /** Delete related record(s) */
  delete?: boolean | Record<string, unknown> | Record<string, unknown>[];
  /** Set (replace) related records - only for to-many */
  set?: Record<string, unknown>[];
  /** Update related record(s) */
  update?: Record<string, unknown> | NestedUpdateInput | NestedUpdateInput[];
  /** Update many related records */
  updateMany?: NestedUpdateManyInput | NestedUpdateManyInput[];
  /** Upsert related record(s). */
  upsert?: NestedUpsertInput | NestedUpsertInput[];
  /** Delete many related records */
  deleteMany?: Record<string, unknown> | Record<string, unknown>[];
}

/**
 * ConnectOrCreate input shape
 */
export interface ConnectOrCreateInput {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
}

/**
 * Information about FK direction for a relation
 */
export interface FkDirection {
  /** Does current model hold the FK? */
  holdsFK: boolean;
  /** FK field names on FK holder */
  fkFields: string[];
  /** PK field names on referenced model */
  pkFields: string[];
  /** Which model holds the FK */
  fkHolder: Model<any>;
  /** Which model is referenced */
  referenced: Model<any>;
}

// ============================================================
// SEPARATING DATA
// ============================================================

/**
 * Separate scalar data from relation mutations
 *
 * @param ctx - Query context
 * @param data - Input data with mixed scalar and relation fields
 * @returns Separated scalar and relation data
 */
export function separateData(
  ctx: QueryContext,
  data: Record<string, unknown>
): SeparatedData {
  const scalarData: Record<string, unknown> = {};
  const relations: Record<string, RelationMutation> = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }

    if (isRelation(ctx.model, key)) {
      const relationInfo = getRelationInfo(ctx, key);
      if (!relationInfo) {
        continue;
      }

      // Parse relation mutation
      const mutation = parseRelationMutation(relationInfo, value);
      if (mutation) {
        relations[key] = mutation;
      }
    } else {
      // Scalar field
      scalarData[key] = value;
    }
  }

  return { scalarData, relations };
}

/**
 * Parse a relation value into a RelationMutation
 */
function parseRelationMutation(
  relationInfo: RelationInfo,
  value: unknown
): RelationMutation | undefined {
  if (!hasSupportedNestedWriteInput(value)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    ) {
      throw new NestedWriteError(
        `Unsupported nested write operation on relation '${relationInfo.name}': ${Object.keys(
          value
        ).join(", ")}`,
        relationInfo.name
      );
    }
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const mutation: RelationMutation = { relationInfo };

  for (const key of SUPPORTED_NESTED_WRITE_KEYS) {
    if (!(key in input) || input[key] === undefined) {
      continue;
    }

    switch (key) {
      case "connect":
        mutation.connect = input.connect as
          | Record<string, unknown>
          | Record<string, unknown>[];
        break;
      case "disconnect":
        mutation.disconnect = input.disconnect as
          | boolean
          | Record<string, unknown>
          | Record<string, unknown>[];
        break;
      case "create":
        mutation.create = input.create as
          | Record<string, unknown>
          | Record<string, unknown>[];
        break;
      case "createMany":
        mutation.createMany = input.createMany as CreateManyInput;
        break;
      case "connectOrCreate":
        mutation.connectOrCreate = input.connectOrCreate as
          | ConnectOrCreateInput
          | ConnectOrCreateInput[];
        break;
      case "delete":
        mutation.delete = input.delete as
          | boolean
          | Record<string, unknown>
          | Record<string, unknown>[];
        break;
      case "set":
        mutation.set = Array.isArray(input.set)
          ? (input.set as Record<string, unknown>[])
          : ([input.set] as Record<string, unknown>[]);
        break;
      case "update":
        mutation.update = parseNestedUpdateInput(relationInfo, input.update);
        break;
      case "updateMany":
        mutation.updateMany = parseNestedUpdateManyInput(
          relationInfo,
          input.updateMany
        );
        break;
      case "upsert":
        mutation.upsert = parseNestedUpsertInput(relationInfo, input.upsert);
        break;
      case "deleteMany":
        mutation.deleteMany = parseNestedDeleteManyInput(
          relationInfo,
          input.deleteMany
        );
        break;
      default:
        break;
    }
  }

  return mutation;
}

function parseNestedUpdateInput(
  relationInfo: RelationInfo,
  value: unknown
): Record<string, unknown> | NestedUpdateInput | NestedUpdateInput[] {
  if (relationInfo.isToOne) {
    return requireRecordEnvelope(relationInfo, "update", value);
  }

  return parseSingleOrArrayRecord(value, relationInfo, "update").map(
    (input) => {
      const where = requireRecordField(relationInfo, "update", input, "where");
      const data = requireRecordField(relationInfo, "update", input, "data");
      return { where, data };
    }
  );
}

function parseNestedUpdateManyInput(
  relationInfo: RelationInfo,
  value: unknown
): NestedUpdateManyInput | NestedUpdateManyInput[] {
  rejectToOneOperation(relationInfo, "updateMany");

  return parseSingleOrArrayRecord(value, relationInfo, "updateMany").map(
    (input) => {
      const data = requireRecordField(
        relationInfo,
        "updateMany",
        input,
        "data"
      );
      const parsed: NestedUpdateManyInput = { data };
      if (input.where !== undefined) {
        parsed.where = requireRecordField(
          relationInfo,
          "updateMany",
          input,
          "where"
        );
      }
      return parsed;
    }
  );
}

function parseNestedUpsertInput(
  relationInfo: RelationInfo,
  value: unknown
): NestedUpsertInput | NestedUpsertInput[] {
  if (relationInfo.isToOne && Array.isArray(value)) {
    throw new NestedWriteError(
      `Malformed nested 'upsert' operation on relation '${relationInfo.name}': expected a single object envelope for to-one relations.`,
      relationInfo.name,
      { meta: { operation: "upsert" } }
    );
  }

  const inputs = parseSingleOrArrayRecord(value, relationInfo, "upsert");
  const parsed = inputs.map((input) => {
    const create = requireRecordField(relationInfo, "upsert", input, "create");
    const update = requireRecordField(relationInfo, "upsert", input, "update");
    const upsertInput: NestedUpsertInput = { create, update };

    if (relationInfo.isToMany) {
      upsertInput.where = requireRecordField(
        relationInfo,
        "upsert",
        input,
        "where"
      );
    }

    return upsertInput;
  });

  return relationInfo.isToOne ? parsed[0]! : parsed;
}

function parseNestedDeleteManyInput(
  relationInfo: RelationInfo,
  value: unknown
): Record<string, unknown> | Record<string, unknown>[] {
  rejectToOneOperation(relationInfo, "deleteMany");
  return parseSingleOrArrayRecord(value, relationInfo, "deleteMany");
}

function parseSingleOrArrayRecord(
  value: unknown,
  relationInfo: RelationInfo,
  operation: string
): Record<string, unknown>[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) =>
    requireRecordEnvelope(relationInfo, operation, entry)
  );
}

function requireRecordEnvelope(
  relationInfo: RelationInfo,
  operation: string,
  value: unknown
): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  throw new NestedWriteError(
    `Malformed nested '${operation}' operation on relation '${relationInfo.name}': expected an object envelope.`,
    relationInfo.name,
    { meta: { operation } }
  );
}

function requireRecordField(
  relationInfo: RelationInfo,
  operation: string,
  input: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  const value = input[field];
  if (isRecord(value)) {
    return value;
  }

  throw new NestedWriteError(
    `Malformed nested '${operation}' operation on relation '${relationInfo.name}': expected '${field}' to be an object.`,
    relationInfo.name,
    { meta: { operation, field } }
  );
}

function rejectToOneOperation(
  relationInfo: RelationInfo,
  operation: string
): void {
  if (!relationInfo.isToOne) {
    return;
  }

  throw new NestedWriteError(
    `Nested operation '${operation}' is not supported for to-one relation '${relationInfo.name}'.`,
    relationInfo.name,
    { meta: { operation } }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ============================================================
// FK DIRECTION
// ============================================================

/**
 * Determine FK direction for a relation
 *
 * FK direction affects order of operations:
 * - If current model holds FK: create related first, then current
 * - If related model holds FK: create current first, then related
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @returns FK direction info
 */
export function getFkDirection(
  ctx: QueryContext,
  relationInfo: RelationInfo
): FkDirection {
  // Must come before any inverse-FK scanning: a to-one relation on the target
  // pointing back at this model (e.g. tag.featuredIn) would otherwise be
  // mistaken for this relation's FK and get silently overwritten.
  if (relationInfo.type === "manyToMany") {
    throw new QueryEngineError(
      `Relation '${relationInfo.name}' is many-to-many and has no FK direction. ` +
        "Many-to-many writes must go through the junction table handlers."
    );
  }

  const { fields, references, targetModel } = relationInfo;

  // If fields defined on this relation, current model holds the FK
  const holdsFK = !!(fields && fields.length > 0);

  if (holdsFK) {
    return {
      holdsFK: true,
      fkFields: fields!,
      pkFields: references ?? getPrimaryKeyFields(targetModel),
      fkHolder: ctx.model,
      referenced: targetModel,
    };
  }

  // Otherwise, the target model holds the FK (to-many from current's perspective)
  // Look for the inverse relation to find the actual FK fields on target model
  const inverse = findInverseRelationState(ctx.model, relationInfo);
  if (!inverse) {
    throw new QueryEngineError(
      `Cannot determine FK fields for relation '${relationInfo.name}'. ` +
        "Define the inverse relation with .fields([...]) or use explicit FK fields."
    );
  }

  return {
    holdsFK: false,
    fkFields: inverse.fields,
    // Prefer the inverse relation's references: the fields on this model the
    // FK actually points at. Falling back to getPrimaryKeyFields is only
    // correct when the FK targets the PK.
    pkFields:
      inverse.references && inverse.references.length > 0
        ? inverse.references
        : getPrimaryKeyFields(ctx.model),
    fkHolder: targetModel,
    referenced: ctx.model,
  };
}

// ============================================================
// CONNECT SUBQUERY
// ============================================================

/**
 * Build FK assignments for a connect operation
 *
 * Returns a map of FK field -> subquery for each FK field.
 * Handles both single and compound FKs.
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param connectInput - WhereUnique input for the record to connect
 * @returns Map of FK field name to value/subquery
 */
export function buildConnectFkValues(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>
): Record<string, Sql> {
  const fkDir = getFkDirection(ctx, relationInfo);

  if (!fkDir.holdsFK) {
    // Can't assign FK - it's on the other side
    return {};
  }

  const fkFields = fkDir.fkFields;
  const pkFields = fkDir.pkFields;

  if (fkFields.length !== pkFields.length) {
    throw new NestedWriteError(
      `FK/PK mismatch for relation '${relationInfo.name}': ` +
        `${fkFields.length} FK fields, ${pkFields.length} PK fields`,
      relationInfo.name
    );
  }

  const result: Record<string, Sql> = {};

  // Check if all PK values are directly provided in the connect input
  const allPkValuesProvided = pkFields.every(
    (pkField) => pkField in connectInput
  );

  if (allPkValuesProvided) {
    // Simple case: all PK values provided directly - no subqueries needed
    for (let i = 0; i < fkFields.length; i++) {
      const fkField = fkFields[i]!;
      const pkField = pkFields[i]!;
      const value = connectInput[pkField];
      result[fkField] = ctx.adapter.literals.value(value);
    }
  } else {
    // Need subqueries to get the PK values
    // For compound FKs, build a separate subquery for each FK field
    for (let i = 0; i < fkFields.length; i++) {
      const fkField = fkFields[i]!;
      const pkField = pkFields[i]!;

      // Check if this specific PK value is directly provided
      if (pkField in connectInput) {
        const value = connectInput[pkField];
        result[fkField] = ctx.adapter.literals.value(value);
      } else {
        // Build subquery to select this specific PK field
        result[fkField] = buildConnectSubqueryForField(
          ctx,
          relationInfo,
          connectInput,
          pkField
        );
      }
    }
  }

  return result;
}

/**
 * Build subquery to select a specific field for connect
 */
function buildConnectSubqueryForField(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  selectField: string
): Sql {
  const { adapter } = ctx;
  const { targetModel } = relationInfo;

  const targetTable = getTableName(targetModel);
  const subAlias = ctx.nextAlias();
  const childCtx = createChildContext(ctx, targetModel, subAlias);

  const whereClause = buildWhereUnique(childCtx, connectInput, subAlias);

  const fieldColumn = getColumnName(targetModel, selectField);
  const fieldSql = adapter.identifiers.column(subAlias, fieldColumn);
  const tableSql = adapter.identifiers.escape(targetTable);

  return sql`(SELECT ${fieldSql} FROM ${tableSql} ${sql.raw([
    subAlias,
  ])} WHERE ${whereClause})`;
}
// ============================================================
// ANALYSIS HELPERS
// ============================================================

/**
 * Check if the current model holds the FK for a relation
 *
 * Simplified check that doesn't require full QueryContext.
 * For to-many relations (oneToMany), FK is always on the related model.
 * For to-one relations (manyToOne), FK is on current model if fields defined.
 *
 * @param relationInfo - Relation metadata
 * @returns true if current model holds FK, false if related model holds FK
 */
function currentHoldsFK(relationInfo: RelationInfo): boolean {
  // For to-many (oneToMany), FK is always on the related side
  if (relationInfo.isToMany) {
    return false;
  }
  // For to-one (manyToOne), check if fields are defined on current model
  return !!(relationInfo.fields && relationInfo.fields.length > 0);
}

/**
 * Check if any relation mutations require a transaction
 *
 * Transactions needed for:
 * - create (need to get generated ID)
 * - connectOrCreate (check existence + create)
 * - disconnect/delete on to-many (update related records)
 * - set on to-many (delete existing + connect new)
 * - update/updateMany/upsert/deleteMany on related records
 *
 * NOT needed for:
 * - connect when current model holds FK (use subquery)
 */
export function needsTransaction(
  relations: Record<string, RelationMutation>
): boolean {
  for (const mutation of Object.values(relations)) {
    // Create always needs transaction to get generated ID
    if (mutation.create) {
      return true;
    }

    // CreateMany needs transaction to set FK values from parent
    if (mutation.createMany) {
      return true;
    }

    // ConnectOrCreate needs transaction
    if (mutation.connectOrCreate) {
      return true;
    }

    // Delete on relations needs transaction
    if (mutation.delete) {
      return true;
    }

    // Set on to-many needs transaction
    if (mutation.set) {
      return true;
    }

    // Multi-step nested operations must route through atomic nested-write
    // handling instead of single-statement mutation building.
    if (
      mutation.update ||
      mutation.updateMany ||
      mutation.upsert ||
      mutation.deleteMany
    ) {
      return true;
    }

    // Disconnect where FK is on other side needs transaction
    if (mutation.disconnect && !currentHoldsFK(mutation.relationInfo)) {
      return true;
    }
    // Connect needs target existence checks before mutation.
    if (mutation.connect) {
      return true;
    }

    // Disconnect needs required-relation checks before mutation.
    if (mutation.disconnect) {
      return true;
    }
  }

  return false;
}

/**
 * Check if relation mutations can be handled with subqueries only
 */
export function canUseSubqueryOnly(
  relations: Record<string, RelationMutation>
): boolean {
  return !needsTransaction(relations);
}
