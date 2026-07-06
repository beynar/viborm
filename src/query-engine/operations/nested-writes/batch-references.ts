import type { BatchReferenceSqlAdapter } from "@adapters/database-adapter";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getPrimaryKeyFields } from "../../builders/correlation-utils";
import { getTableName } from "../../context";
import { QueryEngineError } from "../../types";

export interface BatchValueRef {
  readonly kind: "batchValueRef";
  readonly batchId: string;
  readonly key: string;
}

export interface BatchPrimaryKeyRef {
  readonly kind: "batchPrimaryKeyRef";
  readonly modelName: string;
  readonly tableName: string;
  readonly fieldName: string;
  readonly valueRef: BatchValueRef;
}

export interface BatchRecordRef {
  readonly kind: "batchRecordRef";
  readonly modelName: string;
  readonly tableName: string;
  readonly primaryKey: Record<string, BatchResolvableValue>;
  readonly primaryKeyRefs: readonly BatchPrimaryKeyRef[];
}

export type BatchResolvableValue = unknown | Sql | BatchValueRef;

export interface PlanState {
  readonly batchId: string;
  readonly statements: Sql[];
  readonly setupStatements: Sql[];
  readonly cleanupStatements: Sql[];
  readonly references: BatchReferenceStore;
  readonly registerProducedPrimaryKeyRef: (
    model: Model<any>,
    record: Record<string, unknown>
  ) => BatchRecordRef;
}

interface BatchReferenceStoreStatements {
  readonly setup: Sql[];
  readonly cleanup: Sql[];
}

let fallbackBatchId = 0;

export function createPlanState(ctx: { adapter: unknown }): PlanState {
  const batchId = createBatchId();
  const setupStatements: Sql[] = [];
  const cleanupStatements: Sql[] = [];
  const references = new BatchReferenceStore(
    batchId,
    getBatchReferenceSqlAdapter(ctx.adapter),
    { setup: setupStatements, cleanup: cleanupStatements }
  );

  return {
    batchId,
    statements: [],
    setupStatements,
    cleanupStatements,
    references,
    registerProducedPrimaryKeyRef: (model, record) =>
      references.registerProducedPrimaryKeyRef(model, record),
  };
}

export function collectPlanStatements(state: PlanState): Sql[] {
  return [
    ...state.setupStatements,
    ...state.statements,
    ...state.cleanupStatements,
  ];
}

export function lowerBatchResolvableValue(
  adapter: unknown,
  value: BatchResolvableValue
): unknown | Sql {
  if (!isBatchValueRef(value)) {
    return value;
  }

  const batchRefs = getBatchReferenceSqlAdapter(adapter);
  if (!batchRefs) {
    throw new QueryEngineError(
      "Batch reference SQL support is not available for this adapter."
    );
  }
  return batchRefs.read(value.batchId, value.key);
}

export function isBatchValueRef(value: unknown): value is BatchValueRef {
  return (
    isObject(value) &&
    value.kind === "batchValueRef" &&
    typeof value.batchId === "string" &&
    typeof value.key === "string"
  );
}

export class BatchReferenceStore {
  private nextRefIndex = 0;
  private initialized = false;
  private readonly valueRefs: BatchValueRef[] = [];
  private readonly recordRefs: BatchRecordRef[] = [];

  constructor(
    readonly batchId: string,
    private readonly batchRefs: BatchReferenceSqlAdapter | undefined,
    private readonly statements: BatchReferenceStoreStatements
  ) {}

  get allocatedValueRefs(): readonly BatchValueRef[] {
    return this.valueRefs;
  }

  get registeredRecordRefs(): readonly BatchRecordRef[] {
    return this.recordRefs;
  }

  allocateValueRef(): BatchValueRef {
    this.initialize();
    const ref = {
      kind: "batchValueRef",
      batchId: this.batchId,
      key: `ref_${this.nextRefIndex}`,
    } satisfies BatchValueRef;
    this.nextRefIndex++;
    this.valueRefs.push(ref);
    return ref;
  }

  registerProducedPrimaryKeyRef(
    model: Model<any>,
    record: Record<string, unknown>
  ): BatchRecordRef {
    const primaryKey: Record<string, BatchResolvableValue> = {};
    const primaryKeyRefs: BatchPrimaryKeyRef[] = [];
    const tableName = getTableName(model);

    for (const fieldName of getPrimaryKeyFields(model)) {
      const value = record[fieldName];
      if (value !== undefined) {
        primaryKey[fieldName] = value;
        continue;
      }

      const valueRef = this.allocateValueRef();
      primaryKey[fieldName] = valueRef;
      primaryKeyRefs.push({
        kind: "batchPrimaryKeyRef",
        modelName: model["~"].names.ts ?? tableName,
        tableName,
        fieldName,
        valueRef,
      });
    }

    const recordRef = {
      kind: "batchRecordRef",
      modelName: model["~"].names.ts ?? tableName,
      tableName,
      primaryKey,
      primaryKeyRefs,
    } satisfies BatchRecordRef;
    this.recordRefs.push(recordRef);
    return recordRef;
  }

  private initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    if (!this.batchRefs) {
      return;
    }

    this.statements.setup.push(
      ...this.batchRefs.setup(this.batchId),
      this.batchRefs.clear(this.batchId)
    );
    this.statements.cleanup.push(this.batchRefs.cleanup(this.batchId));
  }
}

function getBatchReferenceSqlAdapter(
  adapter: unknown
): BatchReferenceSqlAdapter | undefined {
  if (!hasBatchReferenceSqlAdapter(adapter)) {
    return undefined;
  }
  return adapter.batchRefs;
}

function hasBatchReferenceSqlAdapter(
  adapter: unknown
): adapter is { batchRefs: BatchReferenceSqlAdapter } {
  return isObject(adapter) && isBatchReferenceSqlAdapter(adapter.batchRefs);
}

function isBatchReferenceSqlAdapter(
  value: unknown
): value is BatchReferenceSqlAdapter {
  return (
    isObject(value) &&
    typeof value.setup === "function" &&
    typeof value.clear === "function" &&
    typeof value.cleanup === "function" &&
    typeof value.read === "function" &&
    typeof value.store === "function" &&
    typeof value.storeLastInsertId === "function"
  );
}

function createBatchId(): string {
  if (globalThis.crypto?.randomUUID) {
    return `batch_${globalThis.crypto.randomUUID()}`;
  }

  fallbackBatchId++;
  return `batch_${Date.now()}_${fallbackBatchId}`;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object";
}
