import { s as Sql, t as DatabaseAdapter } from "./database-adapter-C-t7bvr_.mjs";
import { A as Dialect, D as FieldState, N as QueryResult, O as Driver, P as TransactionOptions, a as AnyRelation, d as ModelState, m as Field, t as FieldRecord, u as Model } from "./helper-ssyhqKyM.mjs";
import { dn as Prettify } from "./index-DfCVh_Ql.mjs";
import { StandardSchemaV1 } from "@standard-schema/spec";

//#region src/drivers/errors.d.ts

/**
 * Driver Errors
 *
 * Standardized errors for database operations.
 */
/**
 * Base driver error
 */
declare class DriverError extends Error {
  readonly cause?: Error | undefined;
  readonly code?: string | undefined;
  constructor(message: string, options?: {
    cause?: Error | undefined;
    code?: string | undefined;
  });
}
/**
 * Connection failed
 */
declare class ConnectionError extends DriverError {
  constructor(message: string, options?: {
    cause?: Error | undefined;
    code?: string | undefined;
  });
}
/**
 * Query execution failed
 */
declare class QueryError extends DriverError {
  readonly query?: string | undefined;
  readonly params?: unknown[] | undefined;
  constructor(message: string, options?: {
    cause?: Error;
    code?: string;
    query?: string;
    params?: unknown[];
  });
}
/**
 * Unique constraint violation
 */
declare class UniqueConstraintError extends QueryError {
  readonly constraint?: string | undefined;
  readonly table?: string | undefined;
  readonly columns?: string[] | undefined;
  constructor(message: string, options?: {
    cause?: Error;
    code?: string;
    query?: string;
    params?: unknown[];
    constraint?: string;
    table?: string;
    columns?: string[];
  });
}
/**
 * Foreign key constraint violation
 */
declare class ForeignKeyError extends QueryError {
  readonly constraint?: string | undefined;
  constructor(message: string, options?: {
    cause?: Error;
    code?: string;
    query?: string;
    params?: unknown[];
    constraint?: string;
  });
}
/**
 * Transaction error
 */
declare class TransactionError extends DriverError {
  constructor(message: string, options?: {
    cause?: Error;
    code?: string;
  });
}
/**
 * Check if error is retryable (deadlock, serialization failure)
 */
declare function isRetryableError(error: unknown): boolean;
/**
 * Check if error is a unique constraint violation
 */
declare function isUniqueConstraintError(error: unknown): error is UniqueConstraintError;
/**
 * Feature not supported by driver
 *
 * Thrown when a driver doesn't support a specific feature
 * (e.g., vector operations without pgvector extension).
 */
declare class FeatureNotSupportedError extends DriverError {
  readonly feature: string;
  readonly method: string;
  constructor(feature: string, method: string, suggestion?: string);
}
/**
 * Unsupported vector operations
 *
 * Use this to override adapter.vector when pgvector is not available.
 */
declare const unsupportedVector: {
  literal: () => never;
  l2: () => never;
  cosine: () => never;
};
/**
 * Unsupported geospatial operations
 *
 * Use this to override adapter.geospatial when PostGIS is not available.
 */
declare const unsupportedGeospatial: {
  point: () => never;
  equals: () => never;
  intersects: () => never;
  contains: () => never;
  within: () => never;
  crosses: () => never;
  overlaps: () => never;
  touches: () => never;
  covers: () => never;
  dWithin: () => never;
};
//#endregion
//#region src/client/cache/types.d.ts
type CacheOptions = {
  ttl: number;
};
interface CacheDriver {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options: CacheOptions) => Promise<void>;
  delete: (key: string) => Promise<void>;
  clear: (prefix?: string) => Promise<void>;
}
//#endregion
//#region src/client/result-types.d.ts
/**
 * Maps scalar field types to their DATABASE RESULT types.
 * This is what the ORM returns after querying the database.
 *
 * Key difference from validation schema output:
 * - datetime/date/time: returns Date (not ISO string)
 * - json: inferred from custom schema if present, otherwise unknown
 * - enum: inferred from schema values
 */
type ScalarResultTypeMap = {
  string: string;
  int: number;
  float: number;
  decimal: number;
  boolean: boolean;
  datetime: Date;
  date: Date;
  time: Date;
  bigint: bigint;
  json: unknown;
  blob: Uint8Array;
  vector: number[];
  point: {
    x: number;
    y: number;
  };
  enum: string;
};
/**
 * Extract the FieldState from a Field using infer to preserve literal types.
 */
type ExtractFieldState<F$1> = F$1 extends {
  "~": {
    state: infer S;
  };
} ? S extends FieldState ? S : never : never;
/**
 * Get the base scalar type for a field, handling custom schemas.
 * For json/enum fields with custom schemas, infer from the schema.
 * For datetime fields, always return Date (regardless of validation schema output).
 */
type GetScalarResultType<F$1 extends Field> = ExtractFieldState<F$1> extends infer S ? S extends FieldState ? S["type"] extends "json" ? S["schema"] extends StandardSchemaV1<any, infer O> ? O : unknown : S["type"] extends "enum" ? S["schema"] extends StandardSchemaV1<any, infer O> ? O : string : S["type"] extends keyof ScalarResultTypeMap ? ScalarResultTypeMap[S["type"]] : unknown : unknown : unknown;
/**
 * Apply nullable wrapper based on field state.
 * Uses non-distributive check to handle boolean literals correctly.
 */
type ApplyNullable<T, Nullable> = [Nullable] extends [true] ? T | null : T;
/**
 * Apply array wrapper based on field state.
 * Uses non-distributive check to handle boolean literals correctly.
 */
type ApplyArray<T, IsArray> = [IsArray] extends [true] ? T[] : T;
/**
 * Infer the DATABASE RESULT type for a scalar field.
 *
 * This is the canonical helper for inferring output types from fields.
 * It correctly handles:
 * - All scalar types with proper DB result mapping (datetime → Date)
 * - Custom schemas for json/enum fields
 * - Nullable fields
 * - Array fields
 *
 * @example
 * // For s.dateTime().nullable() → Date | null
 * // For s.string().array() → string[]
 * // For s.json().schema(z.object({...})) → { ... }
 */
type InferScalarOutput<F$1 extends Field> = ExtractFieldState<F$1> extends infer S ? S extends FieldState ? ApplyArray<ApplyNullable<GetScalarResultType<F$1>, S["nullable"]>, S["array"]> : never : never;
/**
 * Result for batch operations (createMany, updateMany, deleteMany)
 */
interface BatchPayload {
  count: number;
}
/**
 * Result type for count operations
 * Supports select for per-field counts like Prisma: count({ select: { _all: true, name: true } })
 */
type CountResultType<Args> = Args extends {
  select: infer S;
} ? Prettify<{ [K in keyof S as S[K] extends true ? K : never]: number }> : number;
/**
 * Get the target model's state from a relation
 */
type GetTargetModelState<R extends AnyRelation> = R["~"]["state"]["getter"] extends (() => infer T) ? T extends Model<infer S> ? S extends ModelState ? S : never : never : never;
/**
 * Infer the output type for a model, respecting omit settings.
 * Uses InferScalarOutput for correct DB result types (e.g., Date for datetime).
 */
type InferModelOutput<S$1 extends ModelState> = S$1["omit"] extends Record<string, true> ? Omit<{ [K in keyof S$1["scalars"]]: S$1["scalars"][K] extends Field ? InferScalarOutput<S$1["scalars"][K]> : never }, keyof S$1["omit"]> : { [K in keyof S$1["scalars"]]: S$1["scalars"][K] extends Field ? InferScalarOutput<S$1["scalars"][K]> : never };
/**
 * Get relation type (oneToMany, manyToMany, oneToOne, manyToOne)
 */
type GetRelationType<R extends AnyRelation> = R["~"]["state"]["type"];
/**
 * Check if a relation is optional
 */
type GetRelationOptional<R extends AnyRelation> = R["~"]["state"]["optional"];
/**
 * Result for a relation when included
 * - To-many relations return arrays
 * - To-one relations return single objects (nullable if optional)
 */
type InferRelationResult<R extends AnyRelation> = [GetRelationType<R>] extends ["oneToMany" | "manyToMany"] ? InferModelOutput<GetTargetModelState<R>>[] : [GetRelationOptional<R>] extends [true] ? InferModelOutput<GetTargetModelState<R>> | null : InferModelOutput<GetTargetModelState<R>>;
/**
 * Infer result from select/include args
 * - select: ONLY returns selected fields
 * - include: returns base model + included relations
 * - neither: returns base model output
 */
type InferSelectInclude<S$1 extends ModelState, Args> = Args extends {
  select: infer Selection;
} ? InferSelectResult<S$1, Selection> : Args extends {
  include: infer Include;
} ? InferIncludeResult<S$1, Include> : InferModelOutput<S$1>;
/**
 * Result when select is provided - ONLY selected fields are returned
 */
type InferSelectResult<S$1 extends ModelState, Selection$1> = Prettify<{ [K in keyof Selection$1 & keyof S$1["fields"] as Selection$1[K] extends true | object ? K : never]: S$1["fields"][K] extends Field ? InferScalarOutput<S$1["fields"][K]> : S$1["fields"][K] extends AnyRelation ? Selection$1[K] extends true ? InferRelationResult<S$1["fields"][K]> : Selection$1[K] extends {
  select: infer NS;
} ? InferNestedSelectResult<S$1["fields"][K], NS> : Selection$1[K] extends {
  include: infer NI;
} ? InferNestedIncludeResult<S$1["fields"][K], NI> : Selection$1[K] extends object ? InferRelationResult<S$1["fields"][K]> : never : never }>;
/**
 * Result when include is provided - base result + included relations
 */
type InferIncludeResult<S$1 extends ModelState, Include$1> = Prettify<InferModelOutput<S$1> & { [K in keyof Include$1 & keyof S$1["relations"] as Include$1[K] extends true | object ? K : never]: S$1["relations"][K] extends AnyRelation ? Include$1[K] extends true ? InferRelationResult<S$1["relations"][K]> : Include$1[K] extends {
  select: infer NS;
} ? InferNestedSelectResult<S$1["relations"][K], NS> : Include$1[K] extends {
  include: infer NI;
} ? InferNestedIncludeResult<S$1["relations"][K], NI> : Include$1[K] extends object ? InferRelationResult<S$1["relations"][K]> : never : never }>;
/**
 * Nested select result for a relation
 */
type InferNestedSelectResult<R extends AnyRelation, NS$1> = [GetRelationType<R>] extends ["oneToMany" | "manyToMany"] ? InferSelectResult<GetTargetModelState<R>, NS$1>[] : [GetRelationOptional<R>] extends [true] ? InferSelectResult<GetTargetModelState<R>, NS$1> | null : InferSelectResult<GetTargetModelState<R>, NS$1>;
/**
 * Nested include result for a relation
 */
type InferNestedIncludeResult<R extends AnyRelation, NI$1> = [GetRelationType<R>] extends ["oneToMany" | "manyToMany"] ? InferIncludeResult<GetTargetModelState<R>, NI$1>[] : [GetRelationOptional<R>] extends [true] ? InferIncludeResult<GetTargetModelState<R>, NI$1> | null : InferIncludeResult<GetTargetModelState<R>, NI$1>;
/**
 * Extract scalar field keys from a FieldRecord
 */
type ScalarFieldKeys<T extends FieldRecord> = { [K in keyof T]: T[K] extends Field ? K : never }[keyof T];
/**
 * Infer base type from a field for aggregates.
 * Uses InferScalarOutput for correct DB result types.
 */
type InferFieldBase<F$1> = F$1 extends Field ? InferScalarOutput<F$1> : never;
/**
 * Result type for aggregate operations
 * Dynamically typed based on which aggregates are requested
 */
type AggregateResultType<T extends FieldRecord, Args> = Prettify<{ [K in keyof Args as K extends `_${string}` ? K : never]: K extends "_count" ? Args[K] extends true ? number : Args[K] extends object ? { [F in keyof Args[K]]: number } : never : K extends "_avg" | "_sum" ? Args[K] extends object ? { [F in keyof Args[K]]: number | null } : never : K extends "_min" | "_max" ? Args[K] extends object ? { [F in keyof Args[K]]: F extends ScalarFieldKeys<T> ? InferFieldBase<T[F]> | null : never } : never : never }>;
/**
 * Result type for groupBy operations
 * Includes the grouped-by fields plus any requested aggregates
 */
type GroupByResultType<T extends FieldRecord, Args> = Args extends {
  by: infer B;
} ? Prettify<(B extends readonly (infer K)[] ? K extends ScalarFieldKeys<T> & keyof T ? { [F in K]: InferFieldBase<T[F]> } : never : B extends ScalarFieldKeys<T> & keyof T ? { [F in B]: InferFieldBase<T[F]> } : never) & AggregateResultType<T, Args>> : never;
//#endregion
//#region src/client/types.d.ts
type Schema = Record<string, Model<any>>;
type Operations = "findFirst" | "findMany" | "findUnique" | "create" | "createMany" | "update" | "updateMany" | "delete" | "deleteMany" | "findUniqueOrThrow" | "findFirstOrThrow" | "count" | "aggregate" | "groupBy" | "upsert" | "exist";
/**
 * Extract fields from a Model - works with Model<any>
 */
type ExtractFields<M> = M extends Model<infer S> ? S extends {
  fields: infer F;
} ? F extends FieldRecord ? F : FieldRecord : FieldRecord : FieldRecord;
/**
 * Operation payload type - passes Model directly to args types
 * Each args type extracts what it needs internally from schema inference
 */
type OperationPayload<O$1 extends Operations, M extends Model<any>> = O$1 extends "findMany" ? M["~"]["schemas"]["args"]["findMany"][" vibInferred"]["0"] : O$1 extends "findUnique" ? M["~"]["schemas"]["args"]["findUnique"][" vibInferred"]["0"] : O$1 extends "findFirst" ? M["~"]["schemas"]["args"]["findFirst"][" vibInferred"]["0"] : O$1 extends "create" ? M["~"]["schemas"]["args"]["create"][" vibInferred"]["0"] : O$1 extends "update" ? M["~"]["schemas"]["args"]["update"][" vibInferred"]["0"] : O$1 extends "delete" ? M["~"]["schemas"]["args"]["delete"][" vibInferred"]["0"] : O$1 extends "deleteMany" ? M["~"]["schemas"]["args"]["deleteMany"][" vibInferred"]["0"] : O$1 extends "upsert" ? M["~"]["schemas"]["args"]["upsert"][" vibInferred"]["0"] : O$1 extends "findUniqueOrThrow" ? M["~"]["schemas"]["args"]["findUnique"][" vibInferred"]["0"] : O$1 extends "findFirstOrThrow" ? M["~"]["schemas"]["args"]["findFirst"][" vibInferred"]["0"] : O$1 extends "count" ? M["~"]["schemas"]["args"]["count"][" vibInferred"]["0"] : O$1 extends "aggregate" ? M["~"]["schemas"]["args"]["aggregate"][" vibInferred"]["0"] : O$1 extends "groupBy" ? M["~"]["schemas"]["args"]["groupBy"][" vibInferred"]["0"] : O$1 extends "createMany" ? M["~"]["schemas"]["args"]["createMany"][" vibInferred"]["0"] : O$1 extends "updateMany" ? M["~"]["schemas"]["args"]["updateMany"][" vibInferred"]["0"] : O$1 extends "exist" ? {
  where: M["~"]["schemas"]["where"][" vibInferred"]["0"];
} : never;
/**
 * Operation result type - infers result shape based on select/include args
 * This provides full type safety for ORM operation results
 */
type OperationResult<O$1 extends Operations, M extends Model<any>, Args> = M extends Model<infer S> ? O$1 extends "findFirst" | "findUnique" ? Prettify<InferSelectInclude<S, Args>> | null : O$1 extends "findFirstOrThrow" | "findUniqueOrThrow" ? Prettify<InferSelectInclude<S, Args>> : O$1 extends "findMany" ? Prettify<InferSelectInclude<S, Args>>[] : O$1 extends "create" | "update" | "delete" | "upsert" ? Prettify<InferSelectInclude<S, Args>> : O$1 extends "createMany" | "updateMany" | "deleteMany" ? BatchPayload : O$1 extends "count" ? CountResultType<Args> : O$1 extends "exist" ? boolean : O$1 extends "aggregate" ? AggregateResultType<ExtractFields<M>, Args> : O$1 extends "groupBy" ? GroupByResultType<ExtractFields<M>, Args>[] : never : never;
/**
 * Client type - provides fully typed access to all model operations
 * Each operation returns a Promise with the properly inferred result type
 */
type Client<S$1 extends Schema> = { [K in keyof S$1]: { [O in Operations]: Operation<O, S$1[K]> } };
type Operation<O$1 extends Operations, M extends Model<any>, Payload = OperationPayload<O$1, M>> = undefined extends Payload ? <Arg extends Payload>(args?: Exclude<Arg, undefined>) => Promise<OperationResult<O$1, M, Arg>> : <Arg extends Payload>(args: Arg) => Promise<OperationResult<O$1, M, Arg>>;
//#endregion
//#region src/client/client.d.ts
/**
 * Error thrown when a record is not found for OrThrow operations
 */
declare class NotFoundError extends Error {
  readonly model: string;
  readonly operation: string;
  constructor(model: string, operation: string);
}
/**
 * VibORM Configuration
 */
interface VibORMConfig<S$1 extends Schema> {
  schema: S$1;
  driver: Driver;
  cache?: CacheDriver;
}
/**
 * Extended client type with utility methods
 */
type VibORMClient<S$1 extends Schema> = Client<S$1> & {
  /** Access the underlying driver */
  $driver: Driver;
  /** Execute a raw SQL query */
  $executeRaw: <T = Record<string, unknown>>(query: Sql) => Promise<QueryResult<T>>;
  /** Execute a raw SQL string */
  $queryRaw: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;
  /** Run operations in a transaction */
  $transaction: <T>(fn: (tx: Client<S$1>) => Promise<T>, options?: TransactionOptions) => Promise<T>;
  /** Connect to the database */
  $connect: () => Promise<void>;
  /** Disconnect from the database */
  $disconnect: () => Promise<void>;
  /** Create a client with cache */
  withCache: (config: CacheOptions) => Client<S$1>;
};
/**
 * Create a VibORM client
 *
 * @example
 * ```ts
 * import { PGlite } from "@electric-sql/pglite";
 * import { PGliteDriver } from "viborm/drivers/pglite";
 * import { createClient } from "viborm";
 *
 * const db = new PGlite();
 * const driver = new PGliteDriver({ client: db });
 * const client = createClient({ driver, schema: { user, post } });
 *
 * // Query
 * const users = await client.user.findMany({ where: { name: "Alice" } });
 *
 * // Transaction
 * await client.$transaction(async (tx) => {
 *   const user = await tx.user.create({ data: { name: "Bob" } });
 *   await tx.post.create({ data: { title: "Hello", authorId: user.id } });
 * });
 *
 * // Raw query
 * const result = await client.$executeRaw(sql`SELECT * FROM users`);
 *
 * // Disconnect
 * await client.$disconnect();
 * ```
 */
declare const createClient$1: <S$1 extends Schema>(config: VibORMConfig<S$1>) => VibORMClient<S$1>;
//#endregion
//#region src/drivers/pglite/index.d.ts
/**
 * PGlite client interface (from @electric-sql/pglite)
 */
interface PGliteClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{
    rows: T[];
    affectedRows?: number;
  }>;
  transaction<T>(fn: (tx: PGliteTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
/**
 * PGlite transaction interface
 */
interface PGliteTransaction {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{
    rows: T[];
    affectedRows?: number;
  }>;
}
/**
 * PGlite driver options
 */
interface PGliteDriverOptions {
  /**
   * PGlite client instance.
   * If not provided, a new PGlite instance will be created with the dataDir option.
   */
  client?: PGliteClient;
  /**
   * Data directory for PGlite persistence.
   * Only used when client is not provided.
   * Defaults to ".pglite"
   */
  dataDir?: string;
  /** Enable pgvector extension support (default: false) */
  pgvector?: boolean;
  /** Enable PostGIS extension support (default: false) */
  postgis?: boolean;
}
/**
 * PGlite client config for createClient
 */
interface PGliteClientConfig<S$1 extends Schema> {
  /** Schema models */
  schema: S$1;
  /**
   * PGlite client instance.
   * If not provided, a new PGlite instance will be created with the dataDir option.
   */
  client?: PGliteClient;
  /**
   * Data directory for PGlite persistence.
   * Only used when client is not provided.
   * Defaults to ".pglite"
   */
  dataDir?: string;
  /** Enable pgvector extension support (default: false) */
  pgvector?: boolean;
  /** Enable PostGIS extension support (default: false) */
  postgis?: boolean;
}
/**
 * PGlite Driver
 *
 * Implements the Driver interface for PGlite.
 *
 * @example Basic usage with auto-created client
 * ```ts
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const client = await createClient({ schema });
 * // Data persisted to .viborm/pglite by default
 * ```
 *
 * @example With custom data directory
 * ```ts
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const client = await createClient({
 *   schema,
 *   dataDir: "./my-data/db"
 * });
 * ```
 *
 * @example With existing PGlite client
 * ```ts
 * import { PGlite } from "@electric-sql/pglite";
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const db = new PGlite();
 * const client = await createClient({ client: db, schema });
 * ```
 *
 * @example With pgvector extension
 * ```ts
 * import { PGlite } from "@electric-sql/pglite";
 * import { vector } from "@electric-sql/pglite/vector";
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const db = new PGlite({ extensions: { vector } });
 * const client = await createClient({ client: db, schema, pgvector: true });
 * ```
 */
declare class PGliteDriver implements Driver {
  readonly dialect: Dialect;
  readonly adapter: DatabaseAdapter;
  private readonly client;
  constructor(options: PGliteDriverOptions & {
    client: PGliteClient;
  });
  /**
   * Create a PGliteDriver, auto-creating the PGlite client if not provided
   */
  static create(options?: PGliteDriverOptions): Promise<PGliteDriver>;
  execute<T = Record<string, unknown>>(query: Sql): Promise<QueryResult<T>>;
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (tx: Driver) => Promise<T>, _options?: TransactionOptions): Promise<T>;
  disconnect(): Promise<void>;
}
/**
 * Create a VibORM client with PGlite driver
 *
 * Convenience function that creates the driver and client in one step.
 * If no PGlite client is provided, one will be created automatically
 * with data persisted to `.viborm/pglite` (or custom dataDir).
 *
 * @example
 * ```ts
 * import { createClient } from "viborm/drivers/pglite";
 *
 * const client = await createClient({ schema: { user, post } });
 *
 * // With custom data directory
 * const client = await createClient({
 *   schema: { user, post },
 *   dataDir: "./data/mydb"
 * });
 * ```
 */
declare function createClient<S$1 extends Schema>(config: PGliteClientConfig<S$1>): Promise<VibORMClient<S$1>>;
//#endregion
export { isUniqueConstraintError as _, NotFoundError as a, createClient$1 as c, FeatureNotSupportedError as d, ForeignKeyError as f, isRetryableError as g, UniqueConstraintError as h, createClient as i, ConnectionError as l, TransactionError as m, PGliteDriver as n, VibORMClient as o, QueryError as p, PGliteDriverOptions as r, VibORMConfig as s, PGliteClientConfig as t, DriverError as u, unsupportedGeospatial as v, unsupportedVector as y };
//# sourceMappingURL=index-CVpKlbOg.d.mts.map