/**
 * Nested Write Operations
 *
 * Handles transactional nested writes: create, connect, disconnect, connectOrCreate, delete.
 * These operations are executed within a transaction when needed.
 */

import type { Driver } from "@drivers";
import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import { getPrimaryKeyField } from "../builders/correlation-utils";
import {
  type ConnectOrCreateInput,
  type FkDirection,
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../builders/relation-data-builder";
import { buildValues } from "../builders/values-builder";
import { buildWhereUnique } from "../builders/where-builder";
import { createChildContext, getColumnName, getTableName } from "../context";
import type { QueryContext, RelationInfo } from "../types";
import { NestedWriteError } from "../types";

// ============================================================
// TYPES
// ============================================================

/**
 * Result of a nested create operation
 */
export interface NestedCreateResult {
  /** The created parent record */
  record: Record<string, unknown>;
  /** Created related records by relation name */
  related: Record<string, Record<string, unknown> | Record<string, unknown>[]>;
}

/**
 * Step in a transaction plan
 */
export interface TransactionStep {
  /** SQL to execute */
  sql: Sql;
  /** What to do with the result */
  resultHandler?: (
    result: Record<string, unknown>[],
    context: TransactionContext
  ) => void;
}

/**
 * Context passed through transaction steps
 */
export interface TransactionContext {
  /** Generated IDs from previous steps */
  generatedIds: Map<string, unknown>;
  /** Created records for return value assembly */
  createdRecords: Map<
    string,
    Record<string, unknown> | Record<string, unknown>[]
  >;
}

// ============================================================
// FK MATCH CONDITION HELPER
// ============================================================

/**
 * Build WHERE condition to match related records by FK
 *
 * When FK is on the related model (to-many from parent's perspective):
 *   WHERE related.fk = parent.pk
 *
 * When FK is on the current model (to-one from parent's perspective):
 *   WHERE related.pk = parent.fk
 *
 * @param ctx - Query context
 * @param fkDir - FK direction info
 * @param targetModel - Related model
 * @param parentData - Parent record data
 * @returns SQL WHERE condition
 */
function buildFkMatchCondition(
  ctx: QueryContext,
  fkDir: FkDirection,
  targetModel: Model<any>,
  parentData: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const conditions: Sql[] = [];

  if (fkDir.holdsFK) {
    // FK on current side - match related records where their PK = our FK value
    for (let i = 0; i < fkDir.pkFields.length; i++) {
      const pkField = fkDir.pkFields[i]!;
      const fkField = fkDir.fkFields[i]!;
      const pkColumn = getColumnName(targetModel, pkField);
      const column = adapter.identifiers.escape(pkColumn);
      const value = adapter.literals.value(parentData[fkField]);
      conditions.push(adapter.operators.eq(column, value));
    }
  } else {
    // FK on related side - match related records where their FK = parent PK
    for (let i = 0; i < fkDir.fkFields.length; i++) {
      const fkField = fkDir.fkFields[i]!;
      const pkField = fkDir.pkFields[i]!;
      const fkColumn = getColumnName(targetModel, fkField);
      const column = adapter.identifiers.escape(fkColumn);
      const value = adapter.literals.value(parentData[pkField]);
      conditions.push(adapter.operators.eq(column, value));
    }
  }

  return conditions.length === 1
    ? conditions[0]!
    : adapter.operators.and(...conditions);
}

/**
 * Build SET clause for FK null assignment
 *
 * Sets all FK fields to NULL for disconnect operations.
 *
 * @param ctx - Query context
 * @param fkDir - FK direction info
 * @param targetModel - Related model
 * @returns SQL SET clause assignments
 */
function buildFkNullAssignments(
  ctx: QueryContext,
  fkDir: FkDirection,
  targetModel: Model<any>
): Sql[] {
  const { adapter } = ctx;
  const assignments: Sql[] = [];

  for (const fkField of fkDir.fkFields) {
    const fkColumn = getColumnName(targetModel, fkField);
    const column = adapter.identifiers.escape(fkColumn);
    assignments.push(adapter.set.assign(column, adapter.literals.null()));
  }

  return assignments;
}

/**
 * Build SET clause for FK value assignment
 *
 * Sets FK fields to parent PK values for connect operations.
 *
 * @param ctx - Query context
 * @param fkDir - FK direction info
 * @param targetModel - Related model
 * @param parentData - Parent record data
 * @returns SQL SET clause assignments
 */
function buildFkValueAssignments(
  ctx: QueryContext,
  fkDir: FkDirection,
  targetModel: Model<any>,
  parentData: Record<string, unknown>
): Sql[] {
  const { adapter } = ctx;
  const assignments: Sql[] = [];

  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    const fkColumn = getColumnName(targetModel, fkField);
    const column = adapter.identifiers.escape(fkColumn);
    const value = adapter.literals.value(parentData[pkField]);
    assignments.push(adapter.set.assign(column, value));
  }

  return assignments;
}

// ============================================================
// NESTED CREATE
// ============================================================

/**
 * Execute a nested create operation
 *
 * Handles FK-direction-aware ordering:
 * - If current model holds FK: create related first, then current
 * - If related model holds FK: create current first, then related
 *
 * @param driver - Database driver with transaction support
 * @param ctx - Query context
 * @param data - Create data including nested relations
 * @returns Created record with nested records
 */
export async function executeNestedCreate(
  driver: Driver,
  ctx: QueryContext,
  data: Record<string, unknown>
): Promise<NestedCreateResult> {
  const { scalar, relations } = separateData(ctx, data);

  // If no relations, just do a simple insert
  if (Object.keys(relations).length === 0) {
    const result = await executeSimpleInsert(driver, ctx, scalar);
    return { record: result, related: {} };
  }

  // Execute in transaction
  return driver.transaction(async (tx) => {
    const txCtx: TransactionContext = {
      generatedIds: new Map(),
      createdRecords: new Map(),
    };

    // Separate relations by FK direction
    const currentHoldsFK: Array<[string, RelationMutation]> = [];
    const relatedHoldsFK: Array<[string, RelationMutation]> = [];

    for (const [name, mutation] of Object.entries(relations)) {
      const fkDir = getFkDirection(ctx, mutation.relationInfo);
      if (fkDir.holdsFK) {
        currentHoldsFK.push([name, mutation]);
      } else {
        relatedHoldsFK.push([name, mutation]);
      }
    }

    // Step 1: Process relations where current holds FK (create related first)
    for (const [relationName, mutation] of currentHoldsFK) {
      await processRelationMutation(
        tx,
        ctx,
        relationName,
        mutation,
        "before",
        scalar,
        txCtx
      );
    }

    // Step 2: Create current record
    const parentRecord = await executeSimpleInsert(tx, ctx, scalar);
    const parentPk = getPrimaryKeyField(ctx.model);
    const parentId = parentRecord[parentPk];
    txCtx.generatedIds.set("__parent__", parentId);

    // Step 3: Process relations where related holds FK (create related after)
    for (const [relationName, mutation] of relatedHoldsFK) {
      await processRelationMutation(
        tx,
        ctx,
        relationName,
        mutation,
        "after",
        parentRecord,
        txCtx
      );
    }

    // Assemble result
    const related: Record<
      string,
      Record<string, unknown> | Record<string, unknown>[]
    > = {};
    for (const [name] of [...currentHoldsFK, ...relatedHoldsFK]) {
      const created = txCtx.createdRecords.get(name);
      if (created) {
        related[name] = created;
      }
    }

    return { record: parentRecord, related };
  });
}

// ============================================================
// NESTED UPDATE
// ============================================================

/**
 * Result of a nested update operation
 */
export interface NestedUpdateResult {
  /** The updated parent record */
  record: Record<string, unknown>;
  /** Related records by relation name */
  related: Record<string, Record<string, unknown> | Record<string, unknown>[]>;
}

/**
 * Execute a nested update operation
 *
 * Handles relation mutations: connect, disconnect, create, delete.
 * Operations are executed after the parent update since the parent
 * already exists and we need its PK for FK operations.
 *
 * @param driver - Database driver with transaction support
 * @param ctx - Query context
 * @param parentRecord - The existing parent record (with its PK)
 * @param relations - Parsed relation mutations from separateData
 * @returns Updated record with related records
 */
export async function executeNestedUpdate(
  driver: Driver,
  ctx: QueryContext,
  parentRecord: Record<string, unknown>,
  relations: Record<string, RelationMutation>
): Promise<NestedUpdateResult> {
  // If no relations, nothing to do
  if (Object.keys(relations).length === 0) {
    return { record: parentRecord, related: {} };
  }

  // Execute in transaction
  return driver.transaction(async (tx) => {
    const txCtx: TransactionContext = {
      generatedIds: new Map(),
      createdRecords: new Map(),
    };

    // Store parent PK for FK operations
    const parentPk = getPrimaryKeyField(ctx.model);
    const parentId = parentRecord[parentPk];
    txCtx.generatedIds.set("__parent__", parentId);

    // For updates, all relation operations happen "after" since parent exists
    for (const [relationName, mutation] of Object.entries(relations)) {
      await processRelationMutation(
        tx,
        ctx,
        relationName,
        mutation,
        "after",
        parentRecord,
        txCtx
      );
    }

    // Assemble result
    const related: Record<
      string,
      Record<string, unknown> | Record<string, unknown>[]
    > = {};
    for (const [name] of Object.entries(relations)) {
      const created = txCtx.createdRecords.get(name);
      if (created) {
        related[name] = created;
      }
    }

    return { record: parentRecord, related };
  });
}

/**
 * Process a single relation mutation
 */
async function processRelationMutation(
  tx: Driver,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  timing: "before" | "after",
  parentData: Record<string, unknown>,
  txCtx: TransactionContext
): Promise<void> {
  const { relationInfo } = mutation;

  // Handle create
  if (mutation.create) {
    const creates = Array.isArray(mutation.create)
      ? mutation.create
      : [mutation.create];

    const createdRecords: Record<string, unknown>[] = [];

    for (const createData of creates) {
      const record = await executeRelationCreate(
        tx,
        ctx,
        relationInfo,
        createData,
        timing,
        parentData,
        txCtx
      );
      createdRecords.push(record);
    }

    // Store for return value
    if (relationInfo.isToMany) {
      txCtx.createdRecords.set(relationName, createdRecords);
    } else {
      txCtx.createdRecords.set(relationName, createdRecords[0]!);
    }
  }

  // Handle connect (when FK is on other side)
  if (mutation.connect && timing === "after") {
    const connects = Array.isArray(mutation.connect)
      ? mutation.connect
      : [mutation.connect];

    for (const connectInput of connects) {
      await executeRelationConnect(
        tx,
        ctx,
        relationInfo,
        connectInput,
        parentData,
        txCtx
      );
    }
  }

  // Handle connectOrCreate
  if (mutation.connectOrCreate) {
    const cocs = Array.isArray(mutation.connectOrCreate)
      ? mutation.connectOrCreate
      : [mutation.connectOrCreate];

    const records: Record<string, unknown>[] = [];

    for (const coc of cocs) {
      const record = await executeConnectOrCreate(
        tx,
        ctx,
        relationInfo,
        coc,
        timing,
        parentData,
        txCtx
      );
      if (record) {
        records.push(record);
      }
    }

    if (records.length > 0) {
      if (relationInfo.isToMany) {
        const existing = txCtx.createdRecords.get(relationName);
        if (Array.isArray(existing)) {
          txCtx.createdRecords.set(relationName, [...existing, ...records]);
        } else {
          txCtx.createdRecords.set(relationName, records);
        }
      } else {
        txCtx.createdRecords.set(relationName, records[0]!);
      }
    }
  }

  // Handle disconnect
  if (mutation.disconnect && timing === "after") {
    await executeRelationDisconnect(
      tx,
      ctx,
      relationInfo,
      mutation.disconnect,
      parentData
    );
  }

  // Handle delete
  if (mutation.delete && timing === "after") {
    await executeRelationDelete(
      tx,
      ctx,
      relationInfo,
      mutation.delete,
      parentData
    );
  }

  // Handle set (replace all related records)
  if (mutation.set && timing === "after") {
    await executeRelationSet(tx, ctx, relationInfo, mutation.set, parentData);
  }
}

/**
 * Execute a nested create for a relation
 */
async function executeRelationCreate(
  tx: Driver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  createData: Record<string, unknown>,
  timing: "before" | "after",
  parentData: Record<string, unknown>,
  txCtx: TransactionContext
): Promise<Record<string, unknown>> {
  const { targetModel } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());

  // Prepare data with FK if needed
  const dataWithFk = { ...createData };

  if (timing === "after" && !fkDir.holdsFK) {
    // Related holds FK - add parent's PK to the data
    const parentPkFields = fkDir.pkFields;
    const fkFields = fkDir.fkFields;

    for (let i = 0; i < fkFields.length; i++) {
      const fkField = fkFields[i]!;
      const pkField = parentPkFields[i]!;
      dataWithFk[fkField] = parentData[pkField];
    }
  }

  // Recursively handle nested relations in the create data
  const { scalar, relations } = separateData(childCtx, dataWithFk);

  if (Object.keys(relations).length > 0) {
    // Recursive nested create
    const result = await executeNestedCreate(tx, childCtx, dataWithFk);
    return result.record;
  }

  // Simple insert
  return executeSimpleInsert(tx, childCtx, scalar);
}

/**
 * Execute a relation connect (when FK is on related side)
 */
async function executeRelationConnect(
  tx: Driver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  parentData: Record<string, unknown>,
  _txCtx: TransactionContext
): Promise<void> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);

  if (fkDir.holdsFK) {
    // FK on current side - this should have been handled via subquery
    // in the scalar data, not here
    return;
  }

  // FK on related side - UPDATE the related record to point to parent
  const targetTable = getTableName(targetModel);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());

  // Build WHERE for the record to connect
  const whereClause = buildWhereUnique(
    childCtx,
    connectInput,
    childCtx.rootAlias
  );
  if (!whereClause) {
    throw new NestedWriteError(
      `Invalid connect input for relation '${name}'`,
      name
    );
  }

  // Build SET clause - set FK fields to parent PK values
  const assignments: Sql[] = [];
  const fkFields = fkDir.fkFields;
  const pkFields = fkDir.pkFields;

  for (let i = 0; i < fkFields.length; i++) {
    const fkField = fkFields[i]!;
    const pkField = pkFields[i]!;
    const fkColumn = getColumnName(targetModel, fkField);
    const column = adapter.identifiers.escape(fkColumn);
    const value = adapter.literals.value(parentData[pkField]);
    assignments.push(adapter.set.assign(column, value));
  }

  const setSql = sql.join(assignments, ", ");
  const table = adapter.identifiers.escape(targetTable);
  const updateSql = adapter.mutations.update(table, setSql, whereClause);

  await tx.execute(updateSql);
}

/**
 * Execute a connectOrCreate operation
 */
async function executeConnectOrCreate(
  tx: Driver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  input: ConnectOrCreateInput,
  timing: "before" | "after",
  parentData: Record<string, unknown>,
  txCtx: TransactionContext
): Promise<Record<string, unknown> | undefined> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());

  // Check if record exists
  const targetTable = getTableName(targetModel);
  const alias = childCtx.rootAlias;

  const whereClause = buildWhereUnique(childCtx, input.where, alias);
  if (!whereClause) {
    throw new NestedWriteError(
      `Invalid connectOrCreate where for relation '${name}'`,
      name
    );
  }

  // SELECT to check existence and fetch full record
  const selectSql = sql`SELECT * FROM ${adapter.identifiers.escape(targetTable)} ${adapter.identifiers.escape(alias)} WHERE ${whereClause} LIMIT 1`;

  const result = await tx.execute<Record<string, unknown>>(selectSql);

  if (result.rows.length > 0) {
    // Record exists - connect it and return full record
    const existingRecord = result.rows[0]!;

    // If FK is on related side, update it to point to parent
    const fkDir = getFkDirection(ctx, relationInfo);
    if (!fkDir.holdsFK && timing === "after") {
      await executeRelationConnect(
        tx,
        ctx,
        relationInfo,
        input.where,
        parentData,
        txCtx
      );
    }

    return existingRecord;
  }

  // Record doesn't exist - create it
  return executeRelationCreate(
    tx,
    ctx,
    relationInfo,
    input.create,
    timing,
    parentData,
    txCtx
  );
}

/**
 * Execute a disconnect operation
 */
async function executeRelationDisconnect(
  tx: Driver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  disconnectInput:
    | boolean
    | Record<string, unknown>
    | Record<string, unknown>[],
  parentData: Record<string, unknown>
): Promise<void> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);

  if (fkDir.holdsFK) {
    // FK on current side - should be handled by setting FK to NULL in scalar update
    return;
  }

  // FK on related side - UPDATE related records to set FK to NULL
  const targetTable = getTableName(targetModel);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());

  // Build WHERE clause
  let whereClause: Sql;

  if (disconnectInput === true) {
    // Disconnect all - WHERE FK = parent PK
    whereClause = buildFkMatchCondition(ctx, fkDir, targetModel, parentData);
  } else {
    // Disconnect specific record(s)
    const inputs = Array.isArray(disconnectInput)
      ? disconnectInput
      : [disconnectInput];
    const conditions: Sql[] = [];

    for (const input of inputs) {
      const condition = buildWhereUnique(childCtx, input, childCtx.rootAlias);
      if (condition) {
        conditions.push(condition);
      }
    }

    if (conditions.length === 0) {
      throw new NestedWriteError(
        `Invalid disconnect input for relation '${name}'`,
        name
      );
    }

    whereClause =
      conditions.length === 1
        ? conditions[0]!
        : adapter.operators.or(...conditions);
  }

  // Build SET clause - set FK fields to NULL
  const assignments = buildFkNullAssignments(ctx, fkDir, targetModel);
  const setSql = sql.join(assignments, ", ");
  const table = adapter.identifiers.escape(targetTable);
  const updateSql = adapter.mutations.update(table, setSql, whereClause);

  await tx.execute(updateSql);
}

/**
 * Execute a nested delete operation
 */
async function executeRelationDelete(
  tx: Driver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  deleteInput: boolean | Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>
): Promise<void> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);

  const targetTable = getTableName(targetModel);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());

  // Build WHERE clause
  let whereClause: Sql;

  if (deleteInput === true) {
    // Delete all related - use FK match condition
    whereClause = buildFkMatchCondition(ctx, fkDir, targetModel, parentData);
  } else {
    // Delete specific record(s)
    const inputs = Array.isArray(deleteInput) ? deleteInput : [deleteInput];
    const conditions: Sql[] = [];

    for (const input of inputs) {
      const condition = buildWhereUnique(childCtx, input, childCtx.rootAlias);
      if (condition) {
        conditions.push(condition);
      }
    }

    if (conditions.length === 0) {
      throw new NestedWriteError(
        `Invalid delete input for relation '${name}'`,
        name
      );
    }

    whereClause =
      conditions.length === 1
        ? conditions[0]!
        : adapter.operators.or(...conditions);
  }

  // Execute DELETE
  const table = adapter.identifiers.escape(targetTable);
  const deleteSql = adapter.mutations.delete(table, whereClause);

  await tx.execute(deleteSql);
}

/**
 * Execute a set operation (replace all related records)
 *
 * For to-many relations where related model holds FK:
 * 1. Disconnect all existing (set FK to NULL)
 * 2. Connect all items in the set array
 */
async function executeRelationSet(
  tx: Driver,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  setItems: Record<string, unknown>[],
  parentData: Record<string, unknown>
): Promise<void> {
  const { adapter } = ctx;
  const { targetModel, name } = relationInfo;
  const fkDir = getFkDirection(ctx, relationInfo);

  if (fkDir.holdsFK) {
    // FK on current side - set operation doesn't make sense for to-one
    throw new NestedWriteError(
      `'set' operation is not supported for relation '${name}' where current model holds FK. ` +
        `Use 'connect' instead for to-one relations.`,
      name
    );
  }

  // Validate that parent has the required PK fields
  for (const pkField of fkDir.pkFields) {
    if (parentData[pkField] === undefined || parentData[pkField] === null) {
      throw new NestedWriteError(
        `Cannot execute 'set' for relation '${name}': parent record is missing primary key field '${pkField}'. ` +
          "Ensure the parent record is saved before performing nested operations.",
        name
      );
    }
  }

  // FK on related side - this is a to-many relation
  const targetTable = getTableName(targetModel);
  const childCtx = createChildContext(ctx, targetModel, ctx.nextAlias());
  const table = adapter.identifiers.escape(targetTable);

  // Step 1: Disconnect all existing (set FK to NULL for all related records)
  const disconnectWhere = buildFkMatchCondition(
    ctx,
    fkDir,
    targetModel,
    parentData
  );
  const nullAssignments = buildFkNullAssignments(ctx, fkDir, targetModel);
  const disconnectSetSql = sql.join(nullAssignments, ", ");
  const disconnectSql = adapter.mutations.update(
    table,
    disconnectSetSql,
    disconnectWhere
  );

  await tx.execute(disconnectSql);

  // Step 2: Connect all items in the set array
  const valueAssignments = buildFkValueAssignments(
    ctx,
    fkDir,
    targetModel,
    parentData
  );
  const connectSetSql = sql.join(valueAssignments, ", ");

  for (const setItem of setItems) {
    // Build WHERE to find the record to connect
    const whereClause = buildWhereUnique(childCtx, setItem, childCtx.rootAlias);
    if (!whereClause) {
      throw new NestedWriteError(
        `Invalid set input for relation '${name}'`,
        name
      );
    }

    const connectSql = adapter.mutations.update(
      table,
      connectSetSql,
      whereClause
    );
    await tx.execute(connectSql);
  }
}

// ============================================================
// SIMPLE INSERT HELPER
// ============================================================

/**
 * Execute a simple INSERT and return the created record
 */
async function executeSimpleInsert(
  driver: Driver,
  ctx: QueryContext,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);
  const modelName = ctx.model.name ?? tableName;

  const { columns, values } = buildValues(ctx, data);

  if (columns.length === 0) {
    throw new NestedWriteError(
      `No data to insert for model '${modelName}'`,
      modelName
    );
  }

  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);

  // Add RETURNING * to get the created record
  const returningSql = adapter.mutations.returning(sql`*`);

  // Check if RETURNING is supported (PostgreSQL) or empty (MySQL/SQLite)
  const hasReturning = returningSql.strings.join("").trim() !== "";

  if (hasReturning) {
    // PostgreSQL with RETURNING - single query returns the created record
    const finalSql = sql`${insertSql} ${returningSql}`;
    const result = await driver.execute<Record<string, unknown>>(finalSql);

    if (result.rows.length === 0) {
      throw new NestedWriteError(
        `Insert did not return a record for model '${modelName}'`,
        modelName
      );
    }

    return result.rows[0]!;
  }

  // MySQL/SQLite without RETURNING - INSERT then refetch
  await driver.execute(insertSql);

  // Get the last inserted ID based on dialect
  const pkField = getPrimaryKeyField(ctx.model);
  const pkValue = data[pkField];

  if (pkValue !== undefined) {
    // PK was provided in data - use it to refetch
    return refetchInsertedRecord(
      driver,
      ctx,
      pkField,
      pkValue,
      data,
      modelName
    );
  }

  // PK was auto-generated - get last insert ID
  const lastInsertId = await getLastInsertId(driver);

  if (lastInsertId !== undefined) {
    return refetchInsertedRecord(
      driver,
      ctx,
      pkField,
      lastInsertId,
      data,
      modelName
    );
  }

  // Fallback: return input data (can't refetch without ID)
  return { ...data };
}

/**
 * Get the last inserted ID using dialect-specific query
 */
async function getLastInsertId(driver: Driver): Promise<unknown | undefined> {
  const dialect = driver.dialect;

  // PostgreSQL uses RETURNING, no need to query for last insert ID
  if (dialect === "postgresql") {
    return undefined;
  }

  let query: string;
  if (dialect === "mysql") {
    query = "SELECT LAST_INSERT_ID() as id";
  } else if (dialect === "sqlite") {
    query = "SELECT last_insert_rowid() as id";
  } else {
    // Unknown dialect - let errors propagate
    return undefined;
  }

  // Let DB errors propagate - don't silently return undefined
  const result = await driver.executeRaw<{ id: unknown }>(query, []);
  return result.rows[0]?.id;
}

/**
 * Refetch the inserted record by primary key
 *
 * This is needed for MySQL/SQLite which don't support RETURNING.
 * If refetch fails, we throw rather than returning partial data.
 */
async function refetchInsertedRecord(
  driver: Driver,
  ctx: QueryContext,
  pkField: string,
  pkValue: unknown,
  originalData: Record<string, unknown>,
  modelName: string
): Promise<Record<string, unknown>> {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);
  const alias = ctx.rootAlias;

  // Build SELECT * FROM table WHERE pk = value
  const pkColumn = getColumnName(ctx.model, pkField);
  const table = adapter.identifiers.table(tableName, alias);
  const columns = sql`*`;
  const where = adapter.operators.eq(
    adapter.identifiers.column(alias, pkColumn),
    adapter.literals.value(pkValue)
  );

  const selectSql = adapter.assemble.select({
    columns,
    from: table,
    where,
  });

  // Let DB errors propagate - don't silently return partial data
  const result = await driver.execute<Record<string, unknown>>(selectSql);

  if (result.rows.length > 0) {
    return result.rows[0]!;
  }

  // Record not found after insert - this is a bug or race condition
  // Return original data with PK as a fallback, but this shouldn't happen
  console.warn(
    `[nested-writes] Record not found after insert for ${modelName}.${pkField}=${pkValue}. ` +
      "This may indicate a race condition or transaction isolation issue."
  );
  return { ...originalData, [pkField]: pkValue };
}
