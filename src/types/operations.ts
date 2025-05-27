// Operation Type Definitions
// For create, update, delete, and other database operations

// Create input types
export interface CreateInputBase<TModel> {
  // Fields that are required for creation
}

export interface UncheckedCreateInputBase<TModel> {
  // Create input without relation validation
}

// Update input types
export interface UpdateInputBase<TModel> {
  // All fields optional for updates
}

export interface UncheckedUpdateInputBase<TModel> {
  // Update input without relation validation
}

// Update many mutation input
export interface UpdateManyMutationInputBase<TModel> {
  // Fields that can be updated in batch operations
}

// Upsert input types
export interface UpsertInputBase<TModel> {
  update: UpdateInputBase<TModel>;
  create: CreateInputBase<TModel>;
}

// Where input types for filtering
export interface WhereInputBase<TModel> {
  AND?: TModel | TModel[];
  OR?: TModel[];
  NOT?: TModel | TModel[];
}

export interface WhereUniqueInputBase<TModel> {
  // Unique fields for identification
}

// Order by types
export interface OrderByInputBase<TModel> {
  // Field ordering options
}

export interface OrderByWithRelationInputBase<TModel> {
  // Ordering with relation support
}

export interface OrderByWithAggregationInputBase<TModel> {
  // Ordering with aggregation support
}

// Scalar where with aggregates
export interface ScalarWhereWithAggregatesInputBase<TModel> {
  AND?: TModel | TModel[];
  OR?: TModel[];
  NOT?: TModel | TModel[];
}

// Count aggregate types
export interface CountAggregateInputBase<TModel> {
  [key: string]: boolean;
}

export interface CountAggregateInputWithAll<TModel> {
  [key: string]: boolean | undefined;
  _all?: boolean;
}

export interface CountAggregateOutputBase<TModel> {
  [key: string]: number;
  _all: number;
}

// Min/Max aggregate types
export interface MinAggregateInputBase<TModel> {
  [key: string]: boolean;
}

export interface MinAggregateOutputBase<TModel> {
  [key: string]: any;
}

export interface MaxAggregateInputBase<TModel> {
  [key: string]: boolean;
}

export interface MaxAggregateOutputBase<TModel> {
  [key: string]: any;
}

// Sum/Avg aggregate types (numeric fields only)
export interface SumAggregateInputBase<TModel> {
  [key: string]: boolean;
}

export interface SumAggregateOutputBase<TModel> {
  [key: string]: number | bigint | null;
}

export interface AvgAggregateInputBase<TModel> {
  [key: string]: boolean;
}

export interface AvgAggregateOutputBase<TModel> {
  [key: string]: number | null;
}

// Combined aggregate result
export interface AggregateResultBase<TModel> {
  _count?: CountAggregateOutputBase<TModel>;
  _min?: MinAggregateOutputBase<TModel>;
  _max?: MaxAggregateOutputBase<TModel>;
  _sum?: SumAggregateOutputBase<TModel>;
  _avg?: AvgAggregateOutputBase<TModel>;
}

// Batch operation result
export interface BatchPayload {
  count: number;
}

// Error types
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class UniqueConstraintViolationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = "UniqueConstraintViolationError";
  }
}

export class ForeignKeyConstraintViolationError extends Error {
  constructor(message: string, public field?: string) {
    super(message);
    this.name = "ForeignKeyConstraintViolationError";
  }
}

// Transaction types
export interface TransactionOptions {
  isolationLevel?:
    | "READ_UNCOMMITTED"
    | "READ_COMMITTED"
    | "REPEATABLE_READ"
    | "SERIALIZABLE";
  timeout?: number;
  maxWait?: number;
}

export type TransactionClient = any; // Will be defined when transactions are implemented

// Raw query types
export interface RawQueryResult<T = any> {
  rows: T[];
  rowCount: number;
  fields: Array<{
    name: string;
    type: string;
  }>;
}

// Connection and client types
export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean | object;
  poolSize?: number;
  connectionTimeout?: number;
}

export interface ClientOptions {
  connection: ConnectionConfig;
  debug?: boolean;
  errorFormat?: "pretty" | "colorless" | "minimal";
}

// Operation context
export interface OperationContext {
  model?: string;
  operation?: string;
  args?: any;
  query?: string;
  timestamp?: Date;
}
