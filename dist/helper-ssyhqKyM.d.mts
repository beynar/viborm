import { s as Sql, t as DatabaseAdapter } from "./database-adapter-C-t7bvr_.mjs";
import { A as BasePointSchema, Bt as BaseBlobSchema, D as StringSchema, E as BaseStringSchema, Gt as BigIntSchema, H as BaseNumberSchema, It as BaseBooleanSchema, V as BaseIntegerSchema, Wt as BaseBigIntSchema, _t as BaseIsoTimestampSchema, an as ComputeInput, b as BaseVectorSchema, dt as JsonValue, gt as BaseIsoTimeSchema, ht as BaseIsoDateSchema, kt as BaseEnumSchema, lt as BaseJsonSchema, on as ComputeOutput, r as V, sn as InferInput, vn as VibSchema, z as ObjectSchema } from "./index-DfCVh_Ql.mjs";
import { StandardSchemaOf, StandardSchemaV1 } from "@standard-schema/spec";

//#region src/drivers/types.d.ts

/**
 * Driver Types
 *
 * Core types for database drivers.
 */
/**
 * Supported database dialects
 */
type Dialect = "postgresql" | "mysql" | "sqlite";
/**
 * Query result from database execution
 */
interface QueryResult<T = Record<string, unknown>> {
  /** Returned rows */
  rows: T[];
  /** Number of affected rows (INSERT/UPDATE/DELETE) */
  rowCount: number;
}
/**
 * Transaction isolation levels
 */
type IsolationLevel = "read_uncommitted" | "read_committed" | "repeatable_read" | "serializable";
/**
 * Transaction options
 */
interface TransactionOptions {
  isolationLevel?: IsolationLevel;
  timeout?: number;
}
/**
 * Log function signature
 */
type LogFunction = (query: string, params: unknown[], duration: number) => void;
//#endregion
//#region src/drivers/driver.d.ts
/**
 * Database Driver Interface
 *
 * All database drivers (pg, mysql2, better-sqlite3, D1, etc.) implement this interface.
 * The driver is passed to createClient and used internally by the query engine.
 *
 * @example
 * ```ts
 * import { PgDriver } from "viborm/drivers/pg";
 * import { createClient } from "viborm";
 *
 * const driver = new PgDriver({ connectionString: "..." });
 * const client = createClient(driver, { user, post });
 *
 * // Driver accessible on client
 * await client.$driver.execute(sql`SELECT 1`);
 *
 * // Client operations use query engine → driver
 * await client.user.findMany({ where: { name: "Alice" } });
 * ```
 */
interface Driver {
  /**
   * Database dialect
   */
  readonly dialect: Dialect;
  /**
   * Database adapter for SQL generation
   *
   * The driver owns the adapter and may override specific features
   * (e.g., vector/geospatial) based on available extensions.
   */
  readonly adapter: DatabaseAdapter;
  /**
   * Execute a parameterized SQL query
   *
   * @param query - SQL query built with sql template tag
   * @returns Query result with rows and rowCount
   */
  execute<T = Record<string, unknown>>(query: Sql): Promise<QueryResult<T>>;
  /**
   * Execute a raw SQL string
   *
   * ⚠️ No SQL injection protection - use with caution
   *
   * @param sql - Raw SQL string
   * @param params - Query parameters
   * @returns Query result
   */
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /**
   * Execute a transaction
   *
   * Automatically commits on success, rolls back on error.
   * The callback receives a transactional driver instance.
   *
   * @param fn - Callback receiving transactional driver
   * @param options - Transaction options
   * @returns Result of callback
   *
   * @example
   * ```ts
   * const user = await driver.transaction(async (tx) => {
   *   const result = await tx.execute(sql`INSERT INTO users ...`);
   *   await tx.execute(sql`INSERT INTO profiles ...`);
   *   return result.rows[0];
   * });
   * ```
   */
  transaction<T>(fn: (tx: Driver) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /**
   * Connect to the database (if needed)
   *
   * Some drivers (like D1) don't need explicit connection.
   * For pooled drivers, this initializes the pool.
   */
  connect?(): Promise<void>;
  /**
   * Disconnect from the database
   *
   * Closes connections/pool. Call when shutting down.
   */
  disconnect?(): Promise<void>;
}
/**
 * Type guard to check if an object is a Driver
 */
declare function isDriver(obj: unknown): obj is Driver;
//#endregion
//#region src/schema/fields/common.d.ts
/**
 * Name slots for fields, models, and relations.
 * These are hydrated by the client at initialization time when the full
 * schema context is available.
 *
 * - ts: TypeScript/schema key name (e.g., "email", "User")
 * - sql: Resolved database name (e.g., "email_column", "users")
 */
interface SchemaNames {
  /** TypeScript key name in the schema */
  ts?: string;
  /** Resolved SQL name (column/table) */
  sql?: string;
}
/**
 * Hydrated schema names - guaranteed to have both ts and sql defined.
 * Returned by model["~"].getFieldName() and model["~"].getRelationName().
 */
interface HydratedSchemaNames {
  /** TypeScript key name in the schema */
  ts: string;
  /** Resolved SQL name (column/table) */
  sql: string;
}
type ScalarFieldType = "string" | "int" | "float" | "decimal" | "boolean" | "datetime" | "date" | "time" | "bigint" | "json" | "blob" | "vector" | "point" | "enum";
type AutoGenerateType = "uuid" | "ulid" | "nanoid" | "cuid" | "increment" | "now" | "updatedAt";
/**
 * Complete state for a field instance.
 * This is the single generic that flows through the field class.
 */
interface FieldState<T extends ScalarFieldType = ScalarFieldType> {
  type: T;
  nullable: boolean;
  array: boolean;
  hasDefault: boolean;
  isId: boolean;
  isUnique: boolean;
  default: DefaultValue<any> | undefined;
  autoGenerate: AutoGenerateType | undefined;
  schema: StandardSchemaV1<any, any> | undefined;
  optional: boolean;
  /** Custom column name in the database (set via .map()) */
  columnName: string | undefined;
  base: VibSchema;
}
/**
 * Computes the new state type after applying an update.
 * Used by chainable methods to derive the return type.
 *
 * @example
 * nullable(): StringField<UpdateState<State, { nullable: true }>>
 */
type UpdateState$1<State extends FieldState, Update extends Partial<FieldState>> = Omit<State, keyof Update> & Update;
/**
 * Conditionally wraps a type with null
 */
type MaybeNullable<T, Nullable extends boolean = false> = Nullable extends true ? T | null : T;
/**
 * Conditionally wraps a type as array
 */
type MaybeArray<T, IsArray extends boolean = false> = IsArray extends true ? T[] : T;
/**
 * Type for default value - can be direct value or factory function
 */
type DefaultValue<T> = T | (() => T);
type DefaultValueInput<S extends FieldState> = DefaultValue<MaybeNullable<MaybeArray<InferInput<S["base"]>, S["array"]>, S["nullable"]>>;
//#endregion
//#region src/schema/fields/bigint/schemas.d.ts
type BigIntFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.BigInt<{
    array: true;
  }>;
  notIn: V.BigInt<{
    array: true;
  }>;
  lt: V.BigInt;
  lte: V.BigInt;
  gt: V.BigInt;
  gte: V.BigInt;
};
type BigIntFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<BigIntFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<BigIntFilterBase<S>>]>;
}>]>;
type BigIntListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.BigInt;
  hasEvery: V.BigInt<{
    array: true;
  }>;
  hasSome: V.BigInt<{
    array: true;
  }>;
  isEmpty: V.Boolean;
};
type BigIntListFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<BigIntListFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<BigIntListFilterBase<S>>]>;
}>]>;
type BigIntUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  increment: V.BigInt;
  decrement: V.BigInt;
  multiply: V.BigInt;
  divide: V.BigInt;
}>]>;
type BigIntListUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  push: V.Union<readonly [V.ShorthandArray<V.BigInt>, V.BigInt<{
    array: true;
  }>]>;
  unshift: V.Union<readonly [V.ShorthandArray<V.BigInt>, V.BigInt<{
    array: true;
  }>]>;
}>]>;
interface BigIntSchemas<F$1 extends FieldState<"bigint">> {
  base: F$1["base"];
  create: BaseBigIntSchema<F$1>;
  update: F$1["array"] extends true ? BigIntListUpdateSchema<F$1["base"]> : BigIntUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? BigIntListFilterSchema<F$1["base"]> : BigIntFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/native-types.d.ts
interface NativeType {
  readonly db: "pg" | "mysql" | "sqlite";
  readonly type: string;
}
//#endregion
//#region src/schema/fields/blob/schemas.d.ts
type BlobFilterBase<S extends V.Schema> = {
  equals: S;
};
type BlobFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<BlobFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<BlobFilterBase<S>>]>;
}>]>;
type BlobUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
}, {
  partial: false;
}>]>;
interface BlobSchemas<F$1 extends FieldState<"blob">> {
  base: F$1["base"];
  create: BaseBlobSchema<F$1>;
  update: BlobUpdateSchema<F$1["base"]>;
  filter: BlobFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/blob/field.d.ts
declare class BlobField<State extends FieldState<"blob">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): BlobField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseBlobSchema<{
      nullable: true;
    }>;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): BlobField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this;
  array(): never;
  id(): never;
  unique(): never;
  get ["~"](): {
    state: State;
    schemas: BlobSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/boolean/schemas.d.ts
type BooleanFilterBase<S extends V.Schema> = {
  equals: S;
};
type BooleanFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<BooleanFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<BooleanFilterBase<S>>]>;
}>]>;
type BooleanListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Boolean;
  hasEvery: V.Boolean<{
    array: true;
  }>;
  hasSome: V.Boolean<{
    array: true;
  }>;
  isEmpty: V.Boolean;
};
type BooleanListFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<BooleanListFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<BooleanListFilterBase<S>>]>;
}>]>;
type BooleanUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
}, {
  partial: false;
}>]>;
type BooleanListUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  push: V.Union<readonly [V.ShorthandArray<V.Boolean>, V.Boolean<{
    array: true;
  }>]>;
  unshift: V.Union<readonly [V.ShorthandArray<V.Boolean>, V.Boolean<{
    array: true;
  }>]>;
}>]>;
interface BooleanSchemas<F$1 extends FieldState<"boolean">> {
  base: F$1["base"];
  create: BaseBooleanSchema<F$1>;
  update: F$1["array"] extends true ? BooleanListUpdateSchema<F$1["base"]> : BooleanUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? BooleanListFilterSchema<F$1["base"]> : BooleanFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/boolean/field.d.ts
declare class BooleanField<State extends FieldState<"boolean">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): BooleanField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseBooleanSchema<{
      nullable: true;
      array: State["array"];
    }>;
  }>>;
  array(): BooleanField<UpdateState$1<State, {
    array: true;
    base: BaseBooleanSchema<{
      nullable: State["nullable"];
      array: true;
    }>;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): BooleanField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this;
  get ["~"](): {
    state: State;
    schemas: BooleanSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/datetime/schemas.d.ts
type DateTimeFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.IsoTimestamp<{
    array: true;
  }>;
  notIn: V.IsoTimestamp<{
    array: true;
  }>;
  lt: V.IsoTimestamp;
  lte: V.IsoTimestamp;
  gt: V.IsoTimestamp;
  gte: V.IsoTimestamp;
};
type DateTimeFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<DateTimeFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<DateTimeFilterBase<S>>]>;
}>]>;
type DateTimeListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.IsoTimestamp;
  hasEvery: V.IsoTimestamp<{
    array: true;
  }>;
  hasSome: V.IsoTimestamp<{
    array: true;
  }>;
  isEmpty: V.Boolean;
};
type DateTimeListFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<DateTimeListFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<DateTimeListFilterBase<S>>]>;
}>]>;
type DateTimeUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
}, {
  partial: false;
}>]>;
type DateTimeListUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  push: V.Union<readonly [V.ShorthandArray<V.IsoTimestamp>, V.IsoTimestamp<{
    array: true;
  }>]>;
  unshift: V.Union<readonly [V.ShorthandArray<V.IsoTimestamp>, V.IsoTimestamp<{
    array: true;
  }>]>;
}>]>;
type DateFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.IsoDate<{
    array: true;
  }>;
  notIn: V.IsoDate<{
    array: true;
  }>;
  lt: V.IsoDate;
  lte: V.IsoDate;
  gt: V.IsoDate;
  gte: V.IsoDate;
};
type DateFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<DateFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<DateFilterBase<S>>]>;
}>]>;
type DateListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.IsoDate;
  hasEvery: V.IsoDate<{
    array: true;
  }>;
  hasSome: V.IsoDate<{
    array: true;
  }>;
  isEmpty: V.Boolean;
};
type DateListFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<DateListFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<DateListFilterBase<S>>]>;
}>]>;
type DateUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
}, {
  partial: false;
}>]>;
type DateListUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  push: V.Union<readonly [V.ShorthandArray<V.IsoDate>, V.IsoDate<{
    array: true;
  }>]>;
  unshift: V.Union<readonly [V.ShorthandArray<V.IsoDate>, V.IsoDate<{
    array: true;
  }>]>;
}>]>;
type TimeFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.IsoTime<{
    array: true;
  }>;
  notIn: V.IsoTime<{
    array: true;
  }>;
  lt: V.IsoTime;
  lte: V.IsoTime;
  gt: V.IsoTime;
  gte: V.IsoTime;
};
type TimeFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<TimeFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<TimeFilterBase<S>>]>;
}>]>;
type TimeListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.IsoTime;
  hasEvery: V.IsoTime<{
    array: true;
  }>;
  hasSome: V.IsoTime<{
    array: true;
  }>;
  isEmpty: V.Boolean;
};
type TimeListFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<TimeListFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<TimeListFilterBase<S>>]>;
}>]>;
type TimeUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
}, {
  partial: false;
}>]>;
type TimeListUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  push: V.Union<readonly [V.ShorthandArray<V.IsoTime>, V.IsoTime<{
    array: true;
  }>]>;
  unshift: V.Union<readonly [V.ShorthandArray<V.IsoTime>, V.IsoTime<{
    array: true;
  }>]>;
}>]>;
interface DateTimeSchemas<F$1 extends FieldState<"datetime">> {
  base: F$1["base"];
  create: BaseIsoTimestampSchema<F$1>;
  update: F$1["array"] extends true ? DateTimeListUpdateSchema<F$1["base"]> : DateTimeUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? DateTimeListFilterSchema<F$1["base"]> : DateTimeFilterSchema<F$1["base"]>;
}
interface DateSchemas<F$1 extends FieldState<"date">> {
  base: F$1["base"];
  create: BaseIsoDateSchema<F$1>;
  update: F$1["array"] extends true ? DateListUpdateSchema<F$1["base"]> : DateUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? DateListFilterSchema<F$1["base"]> : DateFilterSchema<F$1["base"]>;
}
interface TimeSchemas<F$1 extends FieldState<"time">> {
  base: F$1["base"];
  create: BaseIsoTimeSchema<F$1>;
  update: F$1["array"] extends true ? TimeListUpdateSchema<F$1["base"]> : TimeUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? TimeListFilterSchema<F$1["base"]> : TimeFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/datetime/date-field.d.ts
declare class DateField<State extends FieldState<"date">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): DateField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseIsoDateSchema<{
      nullable: true;
      array: State["array"];
    }>;
  }>>;
  array(): DateField<UpdateState$1<State, {
    array: true;
    base: BaseIsoDateSchema<{
      nullable: State["nullable"];
      array: true;
    }>;
  }>>;
  id(): DateField<UpdateState$1<State, {
    isId: true;
    isUnique: true;
  }>>;
  unique(): DateField<UpdateState$1<State, {
    isUnique: true;
  }>>;
  schema<S extends StandardSchemaOf<string>>(schema: S): DateField<UpdateState$1<State, {
    schema: S;
    base: BaseIsoDateSchema<{
      nullable: State["nullable"];
      array: State["array"];
      schema: S;
    }>;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): DateField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this;
  now(): DateField<UpdateState$1<State, {
    hasDefault: true;
    autoGenerate: "now";
    default: DefaultValue<string>;
    optional: true;
  }>>;
  updatedAt(): DateField<UpdateState$1<State, {
    hasDefault: true;
    autoGenerate: "updatedAt";
    default: DefaultValue<string>;
    optional: true;
  }>>;
  get ["~"](): {
    state: State;
    schemas: DateSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/datetime/field.d.ts
declare class DateTimeField<State extends FieldState<"datetime">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): DateTimeField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseIsoTimestampSchema<{
      nullable: true;
      array: State["array"];
    }>;
  }>>;
  array(): DateTimeField<UpdateState$1<State, {
    array: true;
    base: BaseIsoTimestampSchema<{
      nullable: State["nullable"];
      array: true;
    }>;
  }>>;
  id(): DateTimeField<UpdateState$1<State, {
    isId: true;
    isUnique: true;
  }>>;
  unique(): DateTimeField<UpdateState$1<State, {
    isUnique: true;
  }>>;
  schema<S extends StandardSchemaOf<string>>(schema: S): DateTimeField<UpdateState$1<State, {
    schema: S;
    base: BaseIsoTimestampSchema<{
      nullable: State["nullable"];
      array: State["array"];
      schema: S;
    }>;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): DateTimeField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this;
  now(): DateTimeField<UpdateState$1<State, {
    hasDefault: true;
    autoGenerate: "now";
    default: DefaultValue<string>;
    optional: true;
  }>>;
  updatedAt(): DateTimeField<UpdateState$1<State, {
    hasDefault: true;
    autoGenerate: "updatedAt";
    default: DefaultValue<string>;
    optional: true;
  }>>;
  get ["~"](): {
    state: State;
    schemas: DateTimeSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/datetime/time-field.d.ts
declare class TimeField<State extends FieldState<"time">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): TimeField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseIsoTimeSchema<{
      nullable: true;
      array: State["array"];
    }>;
  }>>;
  array(): TimeField<UpdateState$1<State, {
    array: true;
    base: BaseIsoTimeSchema<{
      nullable: State["nullable"];
      array: true;
    }>;
  }>>;
  id(): TimeField<UpdateState$1<State, {
    isId: true;
    isUnique: true;
  }>>;
  unique(): TimeField<UpdateState$1<State, {
    isUnique: true;
  }>>;
  schema<S extends StandardSchemaOf<string>>(schema: S): TimeField<UpdateState$1<State, {
    schema: S;
    base: BaseIsoTimeSchema<{
      nullable: State["nullable"];
      array: State["array"];
      schema: S;
    }>;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): TimeField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this;
  now(): TimeField<UpdateState$1<State, {
    hasDefault: true;
    autoGenerate: "now";
    default: DefaultValue<string>;
    optional: true;
  }>>;
  updatedAt(): TimeField<UpdateState$1<State, {
    hasDefault: true;
    autoGenerate: "updatedAt";
    default: DefaultValue<string>;
    optional: true;
  }>>;
  get ["~"](): {
    state: State;
    schemas: TimeSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/float/schemas.d.ts
type FloatFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.Number<{
    array: true;
  }>;
  notIn: V.Number<{
    array: true;
  }>;
  lt: V.Number;
  lte: V.Number;
  gt: V.Number;
  gte: V.Number;
};
type FloatFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<FloatFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<FloatFilterBase<S>>]>;
}>]>;
type FloatListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Number;
  hasEvery: V.Number<{
    array: true;
  }>;
  hasSome: V.Number<{
    array: true;
  }>;
  isEmpty: V.Boolean;
};
type FloatListFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<FloatListFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<FloatListFilterBase<S>>]>;
}>]>;
type FloatUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  increment: V.Number;
  decrement: V.Number;
  multiply: V.Number;
  divide: V.Number;
}>]>;
type FloatListUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  push: V.Union<readonly [V.ShorthandArray<V.Number>, V.Number<{
    array: true;
  }>]>;
  unshift: V.Union<readonly [V.ShorthandArray<V.Number>, V.Number<{
    array: true;
  }>]>;
}>]>;
interface FloatSchemas<F$1 extends FieldState<"float">> {
  base: F$1["base"];
  create: BaseNumberSchema<F$1>;
  update: F$1["array"] extends true ? FloatListUpdateSchema<F$1["base"]> : FloatUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? FloatListFilterSchema<F$1["base"]> : FloatFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/decimal/schemas.d.ts
interface DecimalSchemas<F$1 extends FieldState<"decimal">> {
  base: F$1["base"];
  create: BaseNumberSchema<F$1>;
  update: F$1["array"] extends true ? FloatListUpdateSchema<F$1["base"]> : FloatUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? FloatListFilterSchema<F$1["base"]> : FloatFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/decimal/field.d.ts
declare class DecimalField<State extends FieldState<"decimal">> {
  private readonly state;
  private readonly _nativeType?;
  private _schemas;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): DecimalField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseNumberSchema<{
      nullable: true;
      array: State["array"];
    }>;
  }>>;
  array(): DecimalField<UpdateState$1<State, {
    array: true;
    base: BaseNumberSchema<{
      nullable: State["nullable"];
      array: true;
    }>;
  }>>;
  id(): DecimalField<UpdateState$1<State, {
    isId: true;
    isUnique: true;
  }>>;
  unique(): DecimalField<UpdateState$1<State, {
    isUnique: true;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): DecimalField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  schema<S extends StandardSchemaOf<number>>(schema: S): DecimalField<UpdateState$1<State, {
    schema: S;
    base: BaseNumberSchema<{
      nullable: State["nullable"];
      array: State["array"];
      schema: S;
    }>;
  }>>;
  map(columnName: string): this;
  get ["~"](): {
    state: State;
    schemas: DecimalSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/enum/schemas.d.ts
type EnumFilterBase<S extends V.Schema, Values extends string[]> = {
  equals: S;
  in: V.Enum<Values, {
    array: true;
  }>;
  notIn: V.Enum<Values, {
    array: true;
  }>;
};
type EnumFilterSchema<S extends V.Schema, Values extends string[]> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<EnumFilterBase<S, Values> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<EnumFilterBase<S, Values>>]>;
}>]>;
type EnumListFilterBase<S extends V.Schema, Values extends string[]> = {
  equals: S;
  has: V.Enum<Values>;
  hasEvery: V.Enum<Values, {
    array: true;
  }>;
  hasSome: V.Enum<Values, {
    array: true;
  }>;
  isEmpty: V.Boolean;
};
type EnumListFilterSchema<S extends V.Schema, Values extends string[]> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<EnumListFilterBase<S, Values> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<EnumListFilterBase<S, Values>>]>;
}>]>;
type EnumUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
}, {
  partial: false;
}>]>;
type EnumListUpdateSchema<S extends V.Schema, Values extends string[]> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  push: V.Union<readonly [V.ShorthandArray<V.Enum<Values>>, V.Enum<Values, {
    array: true;
  }>]>;
  unshift: V.Union<readonly [V.ShorthandArray<V.Enum<Values>>, V.Enum<Values, {
    array: true;
  }>]>;
}>]>;
interface EnumSchemas<Values extends string[], F$1 extends FieldState<"enum">> {
  base: F$1["base"];
  create: BaseEnumSchema<Values, F$1>;
  update: F$1["array"] extends true ? EnumListUpdateSchema<F$1["base"], Values> : EnumUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? EnumListFilterSchema<F$1["base"], Values> : EnumFilterSchema<F$1["base"], Values>;
}
//#endregion
//#region src/schema/fields/enum/field.d.ts
declare class EnumField<Values extends string[], State extends FieldState<"enum"> = FieldState<"enum">> {
  readonly values: Values;
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(values: Values, state: State, _nativeType?: NativeType);
  nullable(): EnumField<Values, UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseEnumSchema<Values, {
      nullable: true;
      array: State["array"];
    }>;
  }>>;
  array(): EnumField<Values, UpdateState$1<State, {
    array: true;
    base: BaseEnumSchema<Values, {
      nullable: State["nullable"];
      array: true;
    }>;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): EnumField<Values, UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  map(columnName: string): this;
  get ["~"](): {
    state: State;
    schemas: EnumSchemas<Values, State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/float/field.d.ts
declare class FloatField<State extends FieldState<"float">> {
  private readonly state;
  private readonly _nativeType?;
  private _schemas;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): FloatField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseNumberSchema<{
      nullable: true;
      array: State["array"];
    }>;
  }>>;
  array(): FloatField<UpdateState$1<State, {
    array: true;
    base: BaseNumberSchema<{
      nullable: State["nullable"];
      array: true;
    }>;
  }>>;
  id(): FloatField<UpdateState$1<State, {
    isId: true;
    isUnique: true;
  }>>;
  unique(): FloatField<UpdateState$1<State, {
    isUnique: true;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): FloatField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  schema<S extends StandardSchemaOf<number>>(schema: S): FloatField<UpdateState$1<State, {
    schema: S;
    base: BaseNumberSchema<{
      nullable: State["nullable"];
      array: State["array"];
      schema: S;
    }>;
  }>>;
  map(columnName: string): this;
  get ["~"](): {
    state: State;
    schemas: FloatSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/int/schemas.d.ts
type IntFilterBase<S extends V.Schema> = {
  equals: S;
  in: V.Integer<{
    array: true;
  }>;
  notIn: V.Integer<{
    array: true;
  }>;
  lt: V.Integer;
  lte: V.Integer;
  gt: V.Integer;
  gte: V.Integer;
};
type IntFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<IntFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<IntFilterBase<S>>]>;
}>]>;
type IntListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Integer;
  hasEvery: V.Integer<{
    array: true;
  }>;
  hasSome: V.Integer<{
    array: true;
  }>;
  isEmpty: V.Boolean;
};
type IntListFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<IntListFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<IntListFilterBase<S>>]>;
}>]>;
type IntUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  increment: V.Integer;
  decrement: V.Integer;
  multiply: V.Integer;
  divide: V.Integer;
}>]>;
type IntListUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
  push: V.Union<readonly [V.ShorthandArray<V.Integer>, V.Integer<{
    array: true;
  }>]>;
  unshift: V.Union<readonly [V.ShorthandArray<V.Integer>, V.Integer<{
    array: true;
  }>]>;
}>]>;
interface IntSchemas<F$1 extends FieldState<"int">> {
  base: F$1["base"];
  create: BaseIntegerSchema<F$1>;
  update: F$1["array"] extends true ? IntListUpdateSchema<F$1["base"]> : IntUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? IntListFilterSchema<F$1["base"]> : IntFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/int/field.d.ts
declare class IntField<State extends FieldState<"int">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): IntField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseIntegerSchema<{
      nullable: true;
      array: State["array"];
    }>;
  }>>;
  array(): IntField<UpdateState$1<State, {
    array: true;
    base: BaseIntegerSchema<{
      nullable: State["nullable"];
      array: true;
    }>;
  }>>;
  id(): IntField<UpdateState$1<State, {
    isId: true;
    isUnique: true;
  }>>;
  unique(): IntField<UpdateState$1<State, {
    isUnique: true;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): IntField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  schema<S extends StandardSchemaOf<number>>(schema: S): IntField<UpdateState$1<State, {
    schema: S;
    base: BaseIntegerSchema<{
      nullable: State["nullable"];
      array: State["array"];
      schema: S;
    }>;
  }>>;
  map(columnName: string): this;
  increment(): IntField<UpdateState$1<State, {
    hasDefault: true;
    autoGenerate: "increment";
    default: DefaultValue<number>;
    optional: true;
  }>>;
  get ["~"](): {
    state: State;
    schemas: IntSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/json/schemas.d.ts
type JsonFilterBase<S extends V.Schema> = {
  equals: S;
  path: V.Array<V.String>;
  string_contains: V.String;
  string_starts_with: V.String;
  string_ends_with: V.String;
  array_contains: S;
  array_starts_with: S;
  array_ends_with: S;
};
type JsonFilterSchema<S extends V.Schema> = V.Object<JsonFilterBase<S> & {
  not: V.Object<JsonFilterBase<S>>;
}>;
type JsonUpdateSchema<S extends V.Schema> = V.Coerce<S, {
  set: S[" vibInferred"]["1"];
}>;
interface JsonSchemas<F$1 extends FieldState<"json">> {
  base: F$1["base"];
  create: BaseJsonSchema<F$1>;
  update: JsonUpdateSchema<F$1["base"]>;
  filter: JsonFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/json/field.d.ts
declare class JsonField<State extends FieldState<"json"> = FieldState<"json">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): JsonField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseJsonSchema<{
      nullable: true;
      schema: State["schema"];
    }>;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): JsonField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  schema<S extends StandardSchemaOf<JsonValue>>(schema: S): JsonField<UpdateState$1<State, {
    schema: S;
    base: BaseJsonSchema<{
      nullable: State["nullable"];
      schema: S;
    }>;
  }>>;
  map(columnName: string): this;
  get ["~"](): {
    state: State;
    schemas: JsonSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/point/schemas.d.ts
type PointFilterBase<S extends V.Schema> = {
  equals: S;
  intersects: S;
  contains: S;
  within: S;
  crosses: S;
  overlaps: S;
  touches: S;
  covers: S;
  dWithin: V.Object<{
    geometry: S;
    distance: V.Number;
  }>;
};
type PointFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<PointFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<PointFilterBase<S>>]>;
}>]>;
type PointUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
}, {
  partial: false;
}>]>;
interface PointSchemas<F$1 extends FieldState<"point">> {
  base: F$1["base"];
  create: BasePointSchema<F$1>;
  update: PointUpdateSchema<F$1["base"]>;
  filter: PointFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/point/field.d.ts
declare class PointField<State extends FieldState<"point">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): PointField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BasePointSchema<{
      nullable: true;
    }>;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): PointField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  map(columnName: string): this;
  get ["~"](): {
    state: State;
    schemas: PointSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/string/schemas.d.ts
type StringFilterBase<S extends V.Schema> = {
  equals: S;
  lt: S;
  lte: S;
  gt: S;
  gte: S;
  in: V.String<{
    array: true;
  }>;
  notIn: V.String<{
    array: true;
  }>;
  contains: V.String;
  startsWith: V.String;
  endsWith: V.String;
  mode: V.Enum<["default", "insensitive"]>;
};
type StringFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<StringFilterBase<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<StringFilterBase<S>>]>;
}>]>;
type StringListFilterBaseSchema<S extends V.Schema> = {
  equals: S;
  has: V.String;
  hasEvery: V.String<{
    array: true;
  }>;
  hasSome: V.String<{
    array: true;
  }>;
  isEmpty: V.Boolean;
};
type StringListFilterSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandFilter<S>, V.Object<StringListFilterBaseSchema<S> & {
  not: V.Union<readonly [V.ShorthandFilter<S>, V.Object<StringListFilterBaseSchema<S>>]>;
}>]>;
type StringUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
}, {
  partial: false;
}>]>;
type StringListUpdateSchema<S extends V.Schema> = V.Union<[V.ShorthandUpdate<S>, V.Object<{
  set: S;
  push: V.Union<readonly [V.ShorthandArray<V.String>, V.String<{
    array: true;
  }>]>;
  unshift: V.Union<readonly [V.ShorthandArray<V.String>, V.String<{
    array: true;
  }>]>;
}>]>;
interface StringSchemas<F$1 extends FieldState<"string">> {
  base: F$1["base"];
  create: V.String<F$1>;
  update: F$1["array"] extends true ? StringListUpdateSchema<F$1["base"]> : StringUpdateSchema<F$1["base"]>;
  filter: F$1["array"] extends true ? StringListFilterSchema<F$1["base"]> : StringFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/string/field.d.ts
declare class StringField<State extends FieldState<"string">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): StringField<UpdateState$1<this["~"]["state"], {
    nullable: true;
    hasDefault: true;
    default: null;
    optional: true;
    base: StringSchema<ComputeInput<string, {
      nullable: true;
      array: State["array"];
      schema: State["schema"];
    }>, ComputeOutput<string, {
      nullable: true;
      array: State["array"];
      schema: State["schema"];
    }>>;
  }>>;
  array(): StringField<UpdateState$1<this["~"]["state"], {
    array: true;
    base: StringSchema<ComputeInput<string, {
      nullable: State["nullable"];
      array: true;
      schema: State["schema"];
    }>, ComputeOutput<string, {
      nullable: State["nullable"];
      array: true;
      schema: State["schema"];
    }>>;
  }>>;
  id(prefix?: string): StringField<UpdateState$1<this["~"]["state"], {
    isId: true;
    isUnique: true;
    autoGenerate: "ulid";
    default: () => string;
    optional: true;
  }>>;
  unique(): StringField<UpdateState$1<this["~"]["state"], {
    isUnique: true;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): StringField<UpdateState$1<this["~"]["state"], {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  schema<S extends StandardSchemaOf<string>>(schema: S): StringField<UpdateState$1<State, {
    schema: S;
    base: BaseStringSchema<{
      nullable: State["nullable"];
      array: State["array"];
      schema: S;
    }>;
  }>>;
  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): StringField<UpdateState$1<this["~"]["state"], {
    columnName: string;
  }>>;
  uuid(prefix?: string): StringField<UpdateState$1<this["~"]["state"], {
    hasDefault: true;
    default: () => string;
    autoGenerate: "uuid";
    optional: true;
  }>>;
  ulid(prefix?: string): StringField<UpdateState$1<this["~"]["state"], {
    hasDefault: true;
    default: () => string;
    autoGenerate: "ulid";
    optional: true;
  }>>;
  nanoid(length?: number, prefix?: string): StringField<UpdateState$1<this["~"]["state"], {
    hasDefault: true;
    default: () => string;
    autoGenerate: "nanoid";
    optional: true;
  }>>;
  cuid(prefix?: string): StringField<UpdateState$1<this["~"]["state"], {
    hasDefault: true;
    default: () => string;
    autoGenerate: "cuid";
    optional: true;
  }>>;
  get ["~"](): {
    state: State;
    schemas: StringSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/vector/schemas.d.ts
type VectorFilterBase<S extends V.Schema> = {
  l2: S;
  cosine: S;
};
type VectorFilterSchema<S extends V.Schema> = V.Union<readonly [V.Coerce<S, {
  cosine: S[" vibInferred"]["1"];
}>, V.Object<VectorFilterBase<S>>]>;
type VectorUpdateSchema<S extends V.Schema> = V.Union<readonly [V.ShorthandUpdate<S>, V.Object<{
  set: S;
}, {
  partial: false;
}>]>;
interface VectorSchemas<F$1 extends FieldState<"vector">> {
  base: F$1["base"];
  create: BaseVectorSchema<F$1>;
  update: VectorUpdateSchema<F$1["base"]>;
  filter: VectorFilterSchema<F$1["base"]>;
}
//#endregion
//#region src/schema/fields/vector/field.d.ts
declare class VectorField<State extends FieldState<"vector">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): VectorField<UpdateState$1<State, {
    nullable: true;
    hasDefault: true;
    default: DefaultValue<null>;
    optional: true;
    base: BaseVectorSchema<{
      nullable: true;
    }>;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): VectorField<UpdateState$1<State, {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this;
  dimension(dim: number): VectorField<State & {
    dimension: number;
  }>;
  get ["~"](): {
    state: State;
    schemas: VectorSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/bigint/field.d.ts
declare class BigIntField<State extends FieldState<"bigint">> {
  private _schemas;
  private readonly state;
  private readonly _nativeType?;
  constructor(state: State, _nativeType?: NativeType);
  nullable(): BigIntField<UpdateState$1<this["~"]["state"], {
    nullable: true;
    hasDefault: true;
    default: null;
    optional: true;
    base: BigIntSchema<ComputeInput<bigint, {
      nullable: true;
      array: State["array"];
    }>, ComputeOutput<bigint, {
      nullable: true;
      array: State["array"];
    }>>;
  }>>;
  array(): BigIntField<UpdateState$1<this["~"]["state"], State & {
    array: true;
    base: BigIntSchema<ComputeInput<bigint, {
      nullable: State["nullable"];
      array: true;
    }>, ComputeOutput<bigint, {
      nullable: State["nullable"];
      array: true;
    }>>;
  }>>;
  id(): BigIntField<UpdateState$1<this["~"]["state"], {
    isId: true;
    isUnique: true;
  }>>;
  unique(): BigIntField<UpdateState$1<this["~"]["state"], {
    isUnique: true;
  }>>;
  default<V$1 extends DefaultValueInput<State>>(value: V$1): BigIntField<UpdateState$1<this["~"]["state"], {
    hasDefault: true;
    default: V$1;
    optional: true;
  }>>;
  schema<S extends StandardSchemaOf<bigint>>(schema: S): BigIntField<UpdateState$1<this["~"]["state"], {
    schema: S;
    base: BigIntSchema<ComputeInput<bigint, {
      nullable: State["nullable"];
      array: State["array"];
      schema: S;
    }>, ComputeOutput<bigint, {
      nullable: State["nullable"];
      array: State["array"];
      schema: S;
    }>>;
  }>>;
  map(columnName: string): BigIntField<UpdateState$1<this["~"]["state"], {
    columnName: string;
  }>>;
  increment(): BigIntField<UpdateState$1<this["~"]["state"], {
    hasDefault: true;
    autoGenerate: "increment";
    default: bigint;
    optional: true;
  }>>;
  get ["~"](): {
    state: State;
    schemas: BigIntSchemas<State>;
    nativeType: NativeType | undefined;
  };
}
//#endregion
//#region src/schema/fields/base.d.ts
/**
 * Union type of all concrete field classes with any state.
 * This is the canonical "Field" type used throughout the codebase.
 *
 * Benefits over an interface:
 * - No need to maintain a separate interface in sync with classes
 * - TypeScript infers exact shape from actual implementations
 * - Adding new properties (like nativeType) automatically works
 */
type Field = StringField<FieldState<"string">> | IntField<FieldState<"int">> | FloatField<FieldState<"float">> | DecimalField<FieldState<"decimal">> | BooleanField<FieldState<"boolean">> | DateTimeField<FieldState<"datetime">> | DateField<FieldState<"date">> | TimeField<FieldState<"time">> | BigIntField<FieldState<"bigint">> | JsonField<FieldState<"json">> | VectorField<FieldState<"vector">> | BlobField<FieldState<"blob">> | PointField<FieldState<"point">> | EnumField<any, FieldState<"enum">>;
//#endregion
//#region src/schema/relation/types.d.ts
/** Workaround to allow circular dependencies */
type Getter = () => any;
/** Relation cardinality types */
type RelationType = "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";
/** Referential action for foreign key constraints */
type ReferentialAction = "cascade" | "setNull" | "restrict" | "noAction";
/**
 * Unified relation state interface
 * All properties are optional except type and getter
 * Specific relation types will only use relevant properties
 */
interface RelationState {
  type: RelationType;
  getter: Getter;
  name?: string;
  fields?: string[];
  references?: string[];
  optional?: boolean;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  through?: string;
  A?: string;
  B?: string;
}
/** State for ToOne relations (oneToOne, manyToOne) */
interface ToOneRelationState extends RelationState {
  type: "oneToOne" | "manyToOne";
}
/** State for ToMany relations (oneToMany) */
interface ToManyRelationState extends RelationState {
  type: "oneToMany";
}
/** State for ManyToMany relations */
interface ManyToManyRelationState extends RelationState {
  type: "manyToMany";
}
//#endregion
//#region src/schema/model/model.d.ts
interface ModelState {
  fields: FieldRecord;
  compoundId: Record<string, ObjectSchema<Record<string, VibSchema>>> | undefined;
  compoundUniques: Record<string, ObjectSchema<Record<string, VibSchema>>> | undefined;
  tableName: string | undefined;
  indexes: IndexDefinition[];
  omit: Record<string, true> | undefined;
  scalars: Record<string, Field>;
  relations: Record<string, AnyRelation>;
  uniques: Record<string, Field>;
}
/**
 * Internal accessor return type for Model["~"]
 * Explicit type annotation to avoid TS7056 (type too complex to serialize)
 */
interface ModelInternal<T extends ModelState> {
  state: T;
  schemas: ModelSchemas<T>;
  names: SchemaNames;
  nameRegistry: {
    fields: Map<string, SchemaNames>;
    relations: Map<string, SchemaNames>;
  };
  getFieldName: (key: string) => HydratedSchemaNames;
  getRelationName: (key: string) => HydratedSchemaNames;
}
type IndexType = "btree" | "hash" | "gin" | "gist";
interface IndexOptions {
  name?: string;
  unique?: boolean;
  type?: IndexType;
  where?: string;
}
interface IndexDefinition<Keys extends string[] = string[], O extends IndexOptions = IndexOptions> {
  fields: Keys;
  options: O;
}
type UpdateIndexDefinition<State extends ModelState, Index extends IndexDefinition> = [...State["indexes"], Index];
type UpdateState<State extends ModelState, Update extends Partial<ModelState>> = Omit<State, keyof Update> & Update;
declare class Model<State extends ModelState> {
  private _names;
  private _nameRegistry;
  private readonly state;
  constructor(state: State);
  /**
   * Maps the model to a specific database table name
   */
  map<Name extends string>(tableName: Name): Model<UpdateState<State, {
    tableName: Name;
  }>>;
  omit<OmitItems extends Record<string, true>>(items: OmitItems): Model<UpdateState<State, {
    omit: OmitItems;
  }>>;
  index<const Keys extends StringKeyOf<State["scalars"]>[], O extends IndexOptions = IndexOptions>(fields: Keys, options?: O): Model<UpdateState<State, {
    indexes: UpdateIndexDefinition<State, {
      fields: any;
      options: any;
    }>;
  }>>;
  id<const Keys extends StringKeyOf<State["scalars"]>[], Name extends string | undefined = undefined>(fields: Keys, options?: {
    name?: Name;
  }): Model<UpdateState<State, {
    compoundId: { [K in Name extends undefined ? NameFromKeys<Keys> : Name]: ObjectSchema<{ [K2 in Keys[number]]: State["scalars"][K2]["~"]["schemas"]["base"] }> };
  }>>;
  unique<const Keys extends StringKeyOf<State["scalars"]>[], Name extends string | undefined = undefined>(fields: Keys, options?: {
    name?: Name;
  }): Model<UpdateState<State, {
    compoundUniques: { [K in Name extends undefined ? NameFromKeys<Keys> : Name]: ObjectSchema<{ [K2 in Keys[number]]: State["scalars"][K2]["~"]["schemas"]["base"] }> };
  }>>;
  extends<ETFields extends FieldRecord>(fields: ETFields): Model<UpdateState<State, {
    fields: State["fields"] & ETFields;
    scalars: ScalarFields<State["fields"] & ETFields>;
    relations: RelationFields<State["fields"] & ETFields>;
    uniques: UniqueFields<State["fields"] & ETFields>;
  }>>;
  get "~"(): ModelInternal<State>;
}
type AnyModel = Model<any>;
//#endregion
//#region src/schema/model/schemas/core/create.d.ts
/**
 * Build scalar create schema - all scalar fields for create input
 */
type ScalarCreateSchema<T extends ModelState> = V.FromObject<T["scalars"], "~.schemas.create", {
  atLeast: RequiredFieldKeys<T["fields"]>[];
}>;
/**
 * Build relation create schema - combines all relation create inputs
 */
type RelationCreateSchema<T extends ModelState> = V.FromObject<T["relations"], "~.schemas.create">;
/**
 * Build full create schema - scalar + relation creates
 *
 * FK fields (like authorId) are optional because they can be derived from
 * nested relation operations (connect, create).
 */
type CreateSchema<T extends ModelState> = V.Object<V.FromObject<T["scalars"], "~.schemas.create">["entries"] & V.FromObject<T["relations"], "~.schemas.create">["entries"], {
  atLeast: RequiredFieldKeys<T["fields"]>[];
}>;
//#endregion
//#region src/schema/model/schemas/core/filter.d.ts
type ScalarFilterSchema<T extends ModelState> = V.FromObject<T["scalars"], "~.schemas.filter">;
type UniqueFilterSchema<T extends ModelState> = V.FromObject<T["uniques"], "~.schemas.base">;
type RelationFilterSchema<T extends ModelState> = V.FromObject<T["relations"], "~.schemas.filter">;
/**
 * Build compound constraint filter schema
 * Creates an object schema where each compound key maps to an optional object of field base schemas
 */
type CompoundConstraintFilterSchema<T extends ModelState> = T["compoundId"] extends Record<string, Record<string, Field>> ? T["compoundUniques"] extends Record<string, Record<string, Field>> ? ObjectSchema<T["compoundId"] & T["compoundUniques"]> : ObjectSchema<T["compoundId"]> : T["compoundUniques"] extends Record<string, Record<string, Field>> ? ObjectSchema<T["compoundUniques"]> : ObjectSchema<{}, undefined>;
//#endregion
//#region src/schema/model/schemas/core/orderby.d.ts
type OrderEnum = V.Enum<["asc", "desc"]>;
type SortOrderSchema = V.Union<readonly [OrderEnum, V.Object<{
  sort: OrderEnum;
  nulls: V.Enum<["first", "last"]>;
}, {
  partial: false;
}>]>;
/**
 * Build orderBy schema - sort direction for each scalar field and nested relation ordering
 */
type OrderBySchema<T extends ModelState> = V.Object<V.FromKeys<StringKeyOf<T["scalars"]>[], SortOrderSchema>["entries"] & V.FromObject<T["relations"], "~.schemas.orderBy">["entries"]>;
//#endregion
//#region src/schema/model/schemas/core/select.d.ts
/**
 * Build select schema - boolean selection for each scalar field, nested select for relations
 */
type SelectSchema<T extends ModelState> = V.Object<V.FromKeys<StringKeyOf<T["scalars"]>[], V.Boolean>["entries"] & V.FromObject<T["relations"], "~.schemas.select">["entries"] & {
  _count: V.Object<{
    select: V.FromObject<T["relations"], "~.schemas.countFilter", {
      optional: true;
    }>;
  }, {
    optional: true;
  }>;
}>;
/**
 * Build include schema - nested include for each relation
 */
type IncludeSchema<T extends ModelState> = V.FromObject<T["relations"], "~.schemas.include", {
  optional: true;
}>;
//#endregion
//#region src/schema/model/schemas/core/update.d.ts
/**
 * Build scalar update schema - all scalar fields for update input (all optional)
 */
type ScalarUpdateSchema<T extends ModelState> = V.FromObject<T["scalars"], "~.schemas.update">;
/**
 * Build relation update schema - combines all relation update inputs
 */
type RelationUpdateSchema<T extends ModelState> = V.FromObject<T["relations"], "~.schemas.update">;
/**
 * Build full update schema - scalar + relation updates (all optional)
 */
type UpdateSchema<T extends ModelState> = V.Object<ScalarUpdateSchema<T>["entries"] & RelationUpdateSchema<T>["entries"]>;
//#endregion
//#region src/schema/model/schemas/core/where.d.ts
/**
 * Build full where schema - scalar + relation filters + AND/OR/NOT
 * Uses thunks for recursive self-references
 */
type WhereSchemaBase<T extends ModelState> = V.Object<V.FromObject<T["scalars"], "~.schemas.filter">["entries"] & V.FromObject<T["relations"], "~.schemas.filter">["entries"]>;
type WhereSchema<T extends ModelState> = V.Object<{
  AND: () => V.Optional<V.Union<readonly [WhereSchema<T>, V.Array<WhereSchema<T>>]>>;
  OR: () => V.Optional<V.Array<WhereSchema<T>>>;
  NOT: () => V.Optional<V.Union<readonly [WhereSchema<T>, V.Array<WhereSchema<T>>]>>;
} & WhereSchemaBase<T>["entries"]>;
/**
 * Build whereUnique schema - unique fields + compound constraints
 * Combines single-field uniques with compound ID and compound uniques
 */
type WhereUniqueSchema<T extends ModelState> = V.Object<V.FromObject<T["uniques"], "~.schemas.base">["entries"] & CompoundConstraintFilterSchema<T>["entries"]>;
//#endregion
//#region src/schema/model/schemas/core/index.d.ts
type CoreSchemas<T extends ModelState> = {
  scalarFilter: ScalarFilterSchema<T>;
  uniqueFilter: UniqueFilterSchema<T>;
  relationFilter: RelationFilterSchema<T>;
  scalarCreate: ScalarCreateSchema<T>;
  relationCreate: RelationCreateSchema<T>;
  scalarUpdate: ScalarUpdateSchema<T>;
  relationUpdate: RelationUpdateSchema<T>;
  where: WhereSchema<T>;
  whereUnique: WhereUniqueSchema<T>;
  create: CreateSchema<T>;
  update: UpdateSchema<T>;
  select: SelectSchema<T>;
  include: IncludeSchema<T>;
  orderBy: OrderBySchema<T>;
};
//#endregion
//#region src/schema/model/schemas/args/aggregate.d.ts
/**
 * Build aggregate field schemas (for _count, _avg, _sum, _min, _max)
 */
type OptionalBoolean = V.Boolean<{
  optional: true;
}>;
type AggregateFieldSchemas<T extends ModelState> = {
  count: V.FromKeys<string[], OptionalBoolean>;
  avg: V.FromKeys<StringKeyOf<T["scalars"]>[], OptionalBoolean>;
  sum: V.FromKeys<StringKeyOf<T["scalars"]>[], OptionalBoolean>;
  min: V.FromKeys<StringKeyOf<T["scalars"]>[], OptionalBoolean>;
  max: V.FromKeys<StringKeyOf<T["scalars"]>[], OptionalBoolean>;
};
/**
 * Count args: { where?, cursor?, take?, skip? }
 */
type CountArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["where"];
  cursor: CoreSchemas<T>["whereUnique"];
  take: V.Number;
  skip: V.Number;
}, {
  optional: true;
}>;
/**
 * Aggregate args: { where?, orderBy?, cursor?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */
type AggregateArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["where"];
  orderBy: V.Union<readonly [CoreSchemas<T>["orderBy"], V.Array<CoreSchemas<T>["orderBy"]>]>;
  cursor: CoreSchemas<T>["whereUnique"];
  take: V.Number;
  skip: V.Number;
  _count: V.Union<readonly [V.Literal<true>, AggregateFieldSchemas<T>["count"]]>;
  _avg: AggregateFieldSchemas<T>["avg"];
  _sum: AggregateFieldSchemas<T>["sum"];
  _min: AggregateFieldSchemas<T>["min"];
  _max: AggregateFieldSchemas<T>["max"];
}>;
/**
 * GroupBy args: { by, where?, having?, orderBy?, take?, skip?, _count?, _avg?, _sum?, _min?, _max? }
 */
type EnumOfFields<T extends ModelState> = V.Enum<StringKeyOf<T["fields"]>[]>;
type GroupByArgs<T extends ModelState> = V.Object<{
  by: V.Union<readonly [EnumOfFields<T>, V.Array<EnumOfFields<T>>]>;
  where: CoreSchemas<T>["where"];
  having: CoreSchemas<T>["where"];
  orderBy: V.Union<readonly [CoreSchemas<T>["orderBy"], V.Array<CoreSchemas<T>["orderBy"]>]>;
  take: V.Number;
  skip: V.Number;
  _count: V.Union<readonly [V.Literal<true>, AggregateFieldSchemas<T>["count"]]>;
  _avg: AggregateFieldSchemas<T>["avg"];
  _sum: AggregateFieldSchemas<T>["sum"];
  _min: AggregateFieldSchemas<T>["min"];
  _max: AggregateFieldSchemas<T>["max"];
}, {
  atLeast: ["by"];
}>;
//#endregion
//#region src/schema/model/schemas/args/find.d.ts
/**
 * FindUnique args: { where: whereUnique, select?, include? }
 */
type FindUniqueArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["whereUnique"];
  select: CoreSchemas<T>["select"];
  include: CoreSchemas<T>["include"];
}, {
  atLeast: ["where"];
}>;
/**
 * FindFirst args: { where?, orderBy?, take?, skip?, cursor?, select?, include? }
 */
type FindFirstArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["where"];
  orderBy: V.Union<readonly [CoreSchemas<T>["orderBy"], V.Array<CoreSchemas<T>["orderBy"]>]>;
  take: V.Number;
  skip: V.Number;
  cursor: CoreSchemas<T>["whereUnique"];
  select: CoreSchemas<T>["select"];
  include: CoreSchemas<T>["include"];
}, {
  optional: true;
}>;
/**
 * FindMany args: { where?, orderBy?, take?, skip?, cursor?, select?, include?, distinct? }
 */
type FindManyArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["where"];
  orderBy: V.Union<readonly [CoreSchemas<T>["orderBy"], V.Array<CoreSchemas<T>["orderBy"]>]>;
  take: V.Number;
  skip: V.Number;
  cursor: CoreSchemas<T>["whereUnique"];
  select: CoreSchemas<T>["select"];
  include: CoreSchemas<T>["include"];
  distinct: V.Enum<StringKeyOf<T["scalars"]>[], {
    array: true;
  }>;
}, {
  optional: true;
}>;
//#endregion
//#region src/schema/model/schemas/args/mutation.d.ts
/**
 * Create args: { data: create, select?, include? }
 */
type CreateArgs<T extends ModelState> = V.Object<{
  data: CoreSchemas<T>["create"];
  select: CoreSchemas<T>["select"];
  include: CoreSchemas<T>["include"];
}, {
  atLeast: ["data"];
}>;
/**
 * CreateMany args: { data: create[], skipDuplicates? }
 */
type CreateManyArgs<T extends ModelState> = V.Object<{
  data: V.Array<CoreSchemas<T>["scalarCreate"]>;
  skipDuplicates: V.Boolean<{
    optional: true;
  }>;
}, {
  atLeast: ["data"];
}>;
/**
 * Update args: { where: whereUnique, data: update, select?, include? }
 */
type UpdateArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["whereUnique"];
  data: CoreSchemas<T>["update"];
  select: CoreSchemas<T>["select"];
  include: CoreSchemas<T>["include"];
}, {
  atLeast: ["where", "data"];
}>;
/**
 * UpdateMany args: { where?, data: update }
 */
type UpdateManyArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["where"];
  data: CoreSchemas<T>["update"];
}, {
  atLeast: ["data"];
}>;
/**
 * Delete args: { where: whereUnique, select?, include? }
 */
type DeleteArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["whereUnique"];
  select: CoreSchemas<T>["select"];
  include: CoreSchemas<T>["include"];
}, {
  atLeast: ["where"];
}>;
/**
 * DeleteMany args: { where? }
 */
type DeleteManyArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["where"];
}, {
  optional: true;
}>;
/**
 * Upsert args: { where: whereUnique, create, update, select?, include? }
 */
type UpsertArgs<T extends ModelState> = V.Object<{
  where: CoreSchemas<T>["whereUnique"];
  create: CoreSchemas<T>["create"];
  update: CoreSchemas<T>["update"];
  select: CoreSchemas<T>["select"];
  include: CoreSchemas<T>["include"];
}, {
  atLeast: ["where", "create", "update"];
}>;
//#endregion
//#region src/schema/model/schemas/args/index.d.ts
type ModelArgs<T extends ModelState> = {
  findUnique: FindUniqueArgs<T>;
  findFirst: FindFirstArgs<T>;
  findMany: FindManyArgs<T>;
  create: CreateArgs<T>;
  createMany: CreateManyArgs<T>;
  update: UpdateArgs<T>;
  updateMany: UpdateManyArgs<T>;
  delete: DeleteArgs<T>;
  deleteMany: DeleteManyArgs<T>;
  upsert: UpsertArgs<T>;
  count: CountArgs<T>;
  aggregate: AggregateArgs<T>;
  groupBy: GroupByArgs<T>;
};
//#endregion
//#region src/schema/model/schemas/types.d.ts
/**
 * Complete model schemas type
 * Used as explicit return type for getModelSchemas to avoid TS7056
 */
type ModelSchemas<T extends ModelState> = CoreSchemas<T> & {
  args: ModelArgs<T>;
};
//#endregion
//#region src/schema/relation/schemas/helpers.d.ts
type TargetModel<S extends RelationState> = S["getter"] extends (() => infer T) ? T extends AnyModel ? T : never : never;
/** Infer a specific schema type from the target model */
type InferTargetSchema<S extends RelationState, K$1 extends keyof ModelSchemas<TargetModel<S>>> = TargetModel<S>["~"]["schemas"][K$1];
//#endregion
//#region src/schema/relation/schemas/count-filter.d.ts
/**
 * Count filter schema: true or { where: <filter> }
 *
 * Used in _count select to filter which related records to count.
 * - true: count all related records
 * - { where: ... }: count related records matching the filter
 */
type CountFilterSchema<S extends RelationState> = V.Union<readonly [V.Literal<true>, V.Object<{
  where: () => InferTargetSchema<S, "where">;
}>]>;
declare const countFilterFactory: <S extends RelationState>(state: S) => CountFilterSchema<S>;
//#endregion
//#region src/schema/relation/schemas/create.d.ts
/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
type ToOneCreateSchema<S extends RelationState> = V.Object<{
  create: () => InferTargetSchema<S, "create">;
  connect: () => InferTargetSchema<S, "whereUnique">;
  connectOrCreate: V.Object<{
    where: () => InferTargetSchema<S, "whereUnique">;
    create: () => InferTargetSchema<S, "create">;
  }>;
}, {
  optional: true;
}>;
declare const toOneCreateFactory: <S extends RelationState>(state: S) => ToOneCreateSchema<S>;
/**
 * To-many create: { create?, createMany?, connect?, connectOrCreate? }
 * All accept single or array, normalized to array
 * Uses thunks for lazy evaluation to avoid circular reference issues
 *
 * Note: createMany uses scalarCreate (no nested relations) because
 * nested creates within createMany are not supported.
 */
type ToManyCreateSchema<S extends RelationState> = V.Object<{
  create: () => V.SingleOrArray<InferTargetSchema<S, "create">>;
  createMany: V.Object<{
    data: () => V.Array<InferTargetSchema<S, "scalarCreate">>;
    skipDuplicates: V.Boolean<{
      optional: true;
    }>;
  }>;
  connect: () => V.SingleOrArray<InferTargetSchema<S, "whereUnique">>;
  connectOrCreate: () => V.SingleOrArray<V.Object<{
    where: () => InferTargetSchema<S, "whereUnique">;
    create: () => InferTargetSchema<S, "create">;
  }, {
    partial: false;
  }>>;
}, {
  optional: true;
}>;
declare const toManyCreateFactory: <S extends RelationState>(state: S) => ToManyCreateSchema<S>;
//#endregion
//#region src/schema/relation/schemas/filter.d.ts
/**
 * To-one filter: { is?, isNot? }
 * For optional relations, `is` can also be null
 * Uses thunks for lazy evaluation to avoid circular reference issues
 */
type ToOneFilterSchema<S extends RelationState> = V.Object<{
  is: () => V.MaybeNullable<InferTargetSchema<S, "where">, S["optional"] extends true ? true : false>;
  isNot: () => V.MaybeNullable<InferTargetSchema<S, "where">, S["optional"] extends true ? true : false>;
}>;
declare const toOneFilterFactory: <S extends RelationState>(state: S) => ToOneFilterSchema<S>;
/**
 * To-many filter: { some?, every?, none? }
 * Uses thunks for lazy evaluation - getTargetWhereSchema already returns thunk
 */
type ToManyFilterSchema<S extends RelationState> = V.Object<{
  some: () => V.MaybeNullable<InferTargetSchema<S, "where">, S["optional"] extends true ? true : false>;
  every: () => V.MaybeNullable<InferTargetSchema<S, "where">, S["optional"] extends true ? true : false>;
  none: () => V.MaybeNullable<InferTargetSchema<S, "where">, S["optional"] extends true ? true : false>;
}>;
declare const toManyFilterFactory: <S extends RelationState>(state: S) => ToManyFilterSchema<S>;
//#endregion
//#region src/schema/relation/schemas/order-by.d.ts
/**
 * To-one orderBy: nested orderBy from the related model's fields
 * e.g., orderBy: { author: { name: 'asc' } }
 */
type ToOneOrderBySchema<S extends RelationState> = () => InferTargetSchema<S, "orderBy">;
declare const toOneOrderByFactory: <S extends RelationState>(state: S) => ToOneOrderBySchema<S>;
/**
 * To-many orderBy: can order by _count aggregate
 * e.g., orderBy: { posts: { _count: 'desc' } }
 */
type ToManyOrderBySchema<S extends RelationState> = V.Object<{
  _count: V.Enum<["asc", "desc"]>;
}>;
declare const toManyOrderByFactory: <S extends RelationState>(_state: S) => ToManyOrderBySchema<S>;
//#endregion
//#region src/schema/relation/schemas/select-include.d.ts
type IncludeToField<Schema extends V.Object<any>> = V.Coerce<Schema, Schema[" vibInferred"]["1"] & {
  select?: Record<string, true>;
}>;
type BooleanToSelect = V.Coerce<V.Boolean, {
  select: Record<string, true> | false;
}>;
/**
 * To-one select: true or nested { select }
 */
type ToOneSelect<S extends RelationState> = V.Union<readonly [BooleanToSelect, V.Object<{
  select: () => InferTargetSchema<S, "select">;
}>]>;
declare const toOneSelectFactory: <S extends RelationState>(state: S) => ToOneSelect<S>;
/**
 * To-many select: true or nested { where, orderBy, take, skip, select }
 */
type ToManySelect<S extends RelationState> = V.Union<readonly [BooleanToSelect, V.Object<{
  where: () => InferTargetSchema<S, "where">;
  orderBy: () => InferTargetSchema<S, "orderBy">;
  take: V.Number;
  skip: V.Number;
  cursor: V.String;
  select: () => InferTargetSchema<S, "select">;
}>]>;
declare const toManySelectFactory: <S extends RelationState>(state: S) => ToManySelect<S>;
/**
 * To-one include: true or nested { select, include }
 */
type ToOneInclude<S extends RelationState> = V.Union<readonly [BooleanToSelect, IncludeToField<V.Object<{
  select: () => InferTargetSchema<S, "select">;
  include: () => InferTargetSchema<S, "include">;
}>>]>;
declare const toOneIncludeFactory: <S extends RelationState>(state: S) => ToOneInclude<S>;
/**
 * To-many include: true or nested { where, orderBy, take, skip, cursor, select, include }
 */
type ToManyInclude<S extends RelationState> = V.Union<readonly [BooleanToSelect, IncludeToField<V.Object<{
  where: () => InferTargetSchema<S, "where">;
  orderBy: () => InferTargetSchema<S, "orderBy">;
  take: V.Number;
  skip: V.Number;
  cursor: V.String;
  select: () => InferTargetSchema<S, "select">;
  include: () => InferTargetSchema<S, "include">;
}>>]>;
declare const toManyIncludeFactory: <S extends RelationState>(state: S) => ToManyInclude<S>;
//#endregion
//#region src/schema/relation/schemas/update.d.ts
/**
 * To-one update: { create?, connect?, connectOrCreate?, update?, upsert?, disconnect?, delete? }
 * disconnect and delete only available for optional relations
 */
type ToOneUpdateSchemaBase<S extends RelationState> = V.Object<{
  create: () => InferTargetSchema<S, "create">;
  connect: () => InferTargetSchema<S, "whereUnique">;
  connectOrCreate: V.Object<{
    where: () => InferTargetSchema<S, "whereUnique">;
    create: () => InferTargetSchema<S, "create">;
  }>;
}>;
type ToOneUpdateSchemaOptional<S extends RelationState> = V.Object<{
  disconnect: V.Boolean;
  delete: V.Boolean;
}>;
type ToOneUpdateSchema<S extends RelationState> = S["optional"] extends true ? V.Object<ToOneUpdateSchemaOptional<S>["entries"] & ToOneUpdateSchemaBase<S>["entries"]> : ToOneUpdateSchemaBase<S>;
declare const toOneUpdateFactory: <S extends RelationState>(state: S) => ToOneUpdateSchema<S>;
/**
 * To-many update: { create?, connect?, disconnect?, set?, delete?, update?, updateMany?, deleteMany?, upsert? }
 * Most operations accept single or array
 */
type ToManyUpdateSchema<S extends RelationState> = V.Object<{
  create: () => V.SingleOrArray<InferTargetSchema<S, "create">>;
  connect: () => V.SingleOrArray<InferTargetSchema<S, "whereUnique">>;
  disconnect: () => V.Union<readonly [V.Boolean, V.SingleOrArray<InferTargetSchema<S, "whereUnique">>]>;
  delete: () => V.SingleOrArray<InferTargetSchema<S, "whereUnique">>;
  connectOrCreate: V.SingleOrArray<V.Object<{
    where: () => InferTargetSchema<S, "whereUnique">;
    create: () => InferTargetSchema<S, "create">;
  }>>;
  set: () => V.SingleOrArray<InferTargetSchema<S, "whereUnique">>;
  update: V.SingleOrArray<V.Object<{
    where: () => InferTargetSchema<S, "where">;
    data: () => InferTargetSchema<S, "update">;
  }>>;
  updateMany: V.SingleOrArray<V.Object<{
    where: () => InferTargetSchema<S, "where">;
    data: () => InferTargetSchema<S, "update">;
  }>>;
  deleteMany: () => V.SingleOrArray<InferTargetSchema<S, "where">>;
  upsert: V.SingleOrArray<V.Object<{
    where: () => InferTargetSchema<S, "whereUnique">;
    create: () => InferTargetSchema<S, "create">;
    update: () => InferTargetSchema<S, "update">;
  }>>;
}>;
declare const toManyUpdateFactory: <S extends RelationState>(state: S) => ToManyUpdateSchema<S>;
//#endregion
//#region src/schema/relation/schemas/index.d.ts
type ToOneSchemas<S extends RelationState> = {
  filter: ReturnType<typeof toOneFilterFactory<S>>;
  create: ReturnType<typeof toOneCreateFactory<S>>;
  update: ReturnType<typeof toOneUpdateFactory<S>>;
  select: ReturnType<typeof toOneSelectFactory<S>>;
  include: ReturnType<typeof toOneIncludeFactory<S>>;
  orderBy: ReturnType<typeof toOneOrderByFactory<S>>;
  countFilter: ReturnType<typeof countFilterFactory<S>>;
};
type ToManySchemas<S extends RelationState> = {
  filter: ReturnType<typeof toManyFilterFactory<S>>;
  create: ReturnType<typeof toManyCreateFactory<S>>;
  update: ReturnType<typeof toManyUpdateFactory<S>>;
  select: ReturnType<typeof toManySelectFactory<S>>;
  include: ReturnType<typeof toManyIncludeFactory<S>>;
  orderBy: ReturnType<typeof toManyOrderByFactory<S>>;
  countFilter: ReturnType<typeof countFilterFactory<S>>;
};
type InferRelationSchemas<S extends RelationState> = S["type"] extends "manyToMany" | "oneToMany" ? ToManySchemas<S> : ToOneSchemas<S>;
//#endregion
//#region src/schema/relation/many-to-many.d.ts
/**
 * Relation class for many-to-many relations
 * Supports configuration for junction table name and field names
 *
 * @example
 * ```ts
 * // Simple - auto-generated junction table "post_tag"
 * const post = s.model({
 *   tags: s.manyToMany(() => tag),
 * });
 *
 * // With explicit junction table
 * const post = s.model({
 *   tags: s.manyToMany(() => tag).through("post_tags"),
 * });
 *
 * // With custom field names in junction table
 * const post = s.model({
 *   tags: s.manyToMany(() => tag)
 *     .through("post_tags")
 *     .A("postId")
 *     .B("tagId"),
 * });
 * ```
 */
declare class ManyToManyRelation<State extends ManyToManyRelationState> {
  private readonly _state;
  private _schemas;
  constructor(state: State);
  /**
   * Specify the junction table name
   */
  through(tableName: string): ManyToManyRelation<State & {
    through: string;
  }>;
  /**
   * Specify the source field name in the junction table
   */
  A(fieldName: string): ManyToManyRelation<State & {
    A: string;
  }>;
  /**
   * Specify the target field name in the junction table
   */
  B(fieldName: string): ManyToManyRelation<State & {
    B: string;
  }>;
  /**
   * Specify the referential action when a related record is deleted
   */
  onDelete(action: ReferentialAction): ManyToManyRelation<State & {
    onDelete: ReferentialAction;
  }>;
  /**
   * Specify the referential action when a related record's key is updated
   */
  onUpdate(action: ReferentialAction): ManyToManyRelation<State & {
    onUpdate: ReferentialAction;
  }>;
  /**
   * Set a custom name for this relation
   */
  name(name: string): ManyToManyRelation<State & {
    name: string;
  }>;
  /**
   * Internal accessor for state and schemas
   */
  get "~"(): {
    state: State;
    schemas: InferRelationSchemas<State>;
  };
}
//#endregion
//#region src/schema/relation/to-many.d.ts
/**
 * Relation class for one-to-many relations (oneToMany)
 * This is the inverse side of a relationship - FK lives on the other model
 * Minimal configuration needed since it doesn't own the FK
 *
 * @example
 * ```ts
 * const user = s.model({
 *   posts: s.oneToMany(() => post),  // No config needed - FK is on post.authorId
 * });
 * ```
 */
declare class ToManyRelation<State extends ToManyRelationState> {
  private readonly _state;
  private _schemas;
  constructor(state: State);
  /**
   * Set a custom name for this relation
   */
  name(name: string): ToManyRelation<State & {
    name: string;
  }>;
  /**
   * Internal accessor for state and schemas
   */
  get "~"(): {
    state: State;
    schemas: InferRelationSchemas<State>;
  };
}
//#endregion
//#region src/schema/relation/to-one.d.ts
/**
 * Relation class for to-one relations (oneToOne, manyToOne)
 * Supports chainable configuration for FK fields, references, and referential actions
 *
 * @example
 * ```ts
 * // Simple relation
 * s.manyToOne(() => user)
 *
 * // With FK configuration
 * s.manyToOne(() => user)
 *   .fields("authorId")
 *   .references("id")
 *   .onDelete("cascade")
 *
 * // Optional relation
 * s.oneToOne(() => profile).optional()
 * ```
 */
declare class ToOneRelation<State extends ToOneRelationState> {
  private readonly _state;
  private _schemas;
  constructor(state: State);
  /**
   * Specify the foreign key field(s) on this model
   */
  fields(...fields: string[]): ToOneRelation<State & {
    fields: string[];
  }>;
  /**
   * Specify the referenced field(s) on the target model
   */
  references(...refs: string[]): ToOneRelation<State & {
    references: string[];
  }>;
  /**
   * Mark this relation as optional (FK can be null)
   */
  optional(): ToOneRelation<State & {
    optional: true;
  }>;
  /**
   * Specify the referential action when the referenced record is deleted
   */
  onDelete(action: ReferentialAction): ToOneRelation<State & {
    onDelete: ReferentialAction;
  }>;
  /**
   * Specify the referential action when the referenced record's key is updated
   */
  onUpdate(action: ReferentialAction): ToOneRelation<State & {
    onUpdate: ReferentialAction;
  }>;
  /**
   * Set a custom name for this relation
   */
  name(name: string): ToOneRelation<State & {
    name: string;
  }>;
  /**
   * Internal accessor for state and schemas
   */
  get "~"(): {
    state: State;
    schemas: InferRelationSchemas<State>;
  };
}
//#endregion
//#region src/schema/relation/index.d.ts
/** Union type of all relation classes */
type AnyRelation = ToOneRelation<ToOneRelationState> | ToManyRelation<ToManyRelationState> | ManyToManyRelation<ManyToManyRelationState>;
//#endregion
//#region src/schema/model/helper.d.ts
/**
 * Record of model fields - the canonical type for field definitions.
 * Supports both scalar Field types and relation types.
 */
type FieldRecord = Record<string, Field | AnyRelation>;
type NameFromKeys<TFields extends string[], TName extends string = ""> = TFields extends readonly [infer F extends string, ...infer R extends string[]] ? R extends [] ? `${TName}_${F}` : NameFromKeys<R, TName extends "" ? F : `${TName}_${F}`> : never;
type ToString<T> = T extends string | number | bigint | boolean | null | undefined ? `${T}` : never;
type StringKeyOf<T extends Record<string, any>> = { [K in keyof T]: K extends string ? K : never }[keyof T];
type ScalarFieldKeys<T extends FieldRecord> = { [K in keyof T]: T[K] extends Field ? ToString<K> : never }[keyof T];
/** Extract relation keys from ModelState */
type RelationKeys<T extends FieldRecord> = { [K in keyof T]: T[K] extends AnyRelation ? ToString<K> : never }[keyof T];
type RequiredFieldKeys<T extends FieldRecord> = { [K in keyof T]: T[K] extends Field ? T[K]["~"]["state"]["optional"] extends true ? never : ToString<K> : never }[keyof T];
type UniqueFieldKeys<T extends FieldRecord> = { [K in keyof T]: T[K] extends Field ? T[K]["~"]["state"]["isId"] extends true ? ToString<K> : T[K]["~"]["state"]["isUnique"] extends true ? ToString<K> : never : never }[keyof T];
type ScalarFields<T extends FieldRecord> = { [K in ScalarFieldKeys<T>]: T[K] extends Field ? T[K] : never };
type RelationFields<T extends FieldRecord> = { [K in RelationKeys<T>]: T[K] extends AnyRelation ? T[K] : never };
type UniqueFields<T extends FieldRecord> = { [K in UniqueFieldKeys<T>]: T[K] extends Field ? T[K] : never };
//#endregion
export { Dialect as A, DateTimeField as C, FieldState as D, NativeType as E, LogFunction as M, QueryResult as N, Driver as O, TransactionOptions as P, DecimalField as S, BlobField as T, StringField as _, AnyRelation as a, FloatField as b, ManyToManyRelation as c, ModelState as d, UpdateState as f, VectorField as g, BigIntField as h, UniqueFields as i, IsolationLevel as j, isDriver as k, AnyModel as l, Field as m, RelationFields as n, ToOneRelation as o, Getter as p, ScalarFields as r, ToManyRelation as s, FieldRecord as t, Model as u, JsonField as v, BooleanField as w, EnumField as x, IntField as y };
//# sourceMappingURL=helper-ssyhqKyM.d.mts.map