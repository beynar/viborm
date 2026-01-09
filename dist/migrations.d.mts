import { C as SchemaSnapshot, S as Resolver, T as UniqueConstraintDef, _ as IndexDef, b as PushResult, c as AmbiguousChange, d as ChangeResolution, f as ColumnDef, g as ForeignKeyDef, h as EnumDef, l as AmbiguousColumnChange, m as DiffResult, p as DiffOperation, u as AmbiguousTableChange, v as MigrationError, w as TableDef, x as ReferentialAction, y as PrimaryKeyDef } from "./database-adapter-C-t7bvr_.mjs";
import { A as Dialect, D as FieldState, O as Driver, l as AnyModel, m as Field } from "./helper-ssyhqKyM.mjs";

//#region src/migrations/differ.d.ts

/**
 * Compares two schema snapshots and returns the operations needed to
 * transform the current schema into the desired schema.
 */
declare function diff(current: SchemaSnapshot, desired: SchemaSnapshot): DiffResult;
/**
 * Checks if any operations are destructive (could cause data loss)
 */
declare function hasDestructiveOperations(operations: DiffOperation[]): boolean;
/**
 * Gets a human-readable description of destructive operations
 */
declare function getDestructiveOperationDescriptions(operations: DiffOperation[]): string[];
//#endregion
//#region src/migrations/push.d.ts
interface PushOptions {
  /** Skip confirmations for destructive changes */
  force?: boolean;
  /** Preview SQL without executing */
  dryRun?: boolean;
  /** Custom resolver for ambiguous changes (defaults to strictResolver) */
  resolver?: Resolver;
  /** Called when destructive operations are detected (for CLI confirmation) */
  onDestructive?: (descriptions: string[]) => Promise<boolean>;
}
/**
 * Pushes schema changes directly to the database.
 *
 * @param driver - Database driver for executing queries
 * @param models - Record of model name to model definition
 * @param options - Push options
 * @returns Push result with operations and SQL statements
 */
declare function push(driver: Driver, models: Record<string, AnyModel>, options?: PushOptions): Promise<PushResult>;
/**
 * Introspects the current database schema without making any changes.
 * Useful for debugging or displaying current state.
 */
declare function introspect(driver: Driver): Promise<SchemaSnapshot>;
/**
 * Generates DDL statements for transforming current schema to desired schema
 * without executing them. Useful for generating migration files.
 */
declare function generateDDL(driver: Driver, models: Record<string, AnyModel>, options?: {
  resolver?: Resolver;
}): Promise<{
  operations: DiffOperation[];
  sql: string[];
}>;
/**
 * Formats an operation for human-readable display
 */
declare function formatOperation(op: DiffOperation): string;
/**
 * Formats all operations for human-readable display
 */
declare function formatOperations(operations: DiffOperation[]): string;
//#endregion
//#region src/migrations/resolver.d.ts
/**
 * Converts resolved ambiguous changes into concrete diff operations
 */
declare function applyResolutions(changes: AmbiguousChange[], resolutions: Map<AmbiguousChange, ChangeResolution>): DiffOperation[];
/**
 * Resolver that always chooses "rename" for all ambiguous changes.
 * Useful for preserving data when the intent is clear.
 */
declare const alwaysRenameResolver: Resolver;
/**
 * Resolver that always chooses "addAndDrop" for all ambiguous changes.
 * Useful for clean slate scenarios where data loss is acceptable.
 */
declare const alwaysAddDropResolver: Resolver;
/**
 * Resolver that throws an error if any ambiguous changes are detected.
 * Useful for CI/CD pipelines where human intervention is not possible.
 */
declare const strictResolver: Resolver;
/**
 * Creates a resolver from a simple decision function
 */
declare function createResolver(decide: (change: AmbiguousChange) => "rename" | "addAndDrop" | Promise<"rename" | "addAndDrop">): Resolver;
/**
 * Creates a resolver that uses predefined resolutions
 */
declare function createPredefinedResolver(predefined: Array<{
  type: "column" | "table";
  from: string;
  to: string;
  tableName?: string;
  resolution: "rename" | "addAndDrop";
}>): Resolver;
/**
 * Formats ambiguous changes for display
 */
declare function formatAmbiguousChange(change: AmbiguousChange): string;
/**
 * Formats all ambiguous changes for display
 */
declare function formatAmbiguousChanges(changes: AmbiguousChange[]): string;
//#endregion
//#region src/migrations/serializer.d.ts
/**
 * Maps VibORM field type to SQL type based on dialect
 */
declare function mapFieldType(field: Field, fieldState: FieldState, dialect: Dialect): string;
interface SerializeOptions {
  dialect: Dialect;
}
/**
 * Serializes a collection of VibORM models into a SchemaSnapshot
 */
declare function serializeModels(models: Record<string, AnyModel>, options: SerializeOptions): SchemaSnapshot;
/**
 * Gets the SQL column name for a field using the model's nameRegistry.
 * This supports field reuse across multiple models.
 *
 * @param model - The model containing the field
 * @param fieldName - The field key in the schema
 * @returns The SQL column name
 */
declare function getColumnName(model: AnyModel, fieldName: string): string;
/**
 * Gets the SQL table name for a model
 */
declare function getTableName(model: AnyModel, modelName: string): string;
//#endregion
export { type AmbiguousChange, type AmbiguousColumnChange, type AmbiguousTableChange, type ChangeResolution, type ColumnDef, type DiffOperation, type DiffResult, type EnumDef, type ForeignKeyDef, type IndexDef, MigrationError, type PrimaryKeyDef, type PushOptions, type PushResult, type ReferentialAction, type Resolver, type SchemaSnapshot, type TableDef, type UniqueConstraintDef, alwaysAddDropResolver, alwaysRenameResolver, applyResolutions, createPredefinedResolver, createResolver, diff, formatAmbiguousChange, formatAmbiguousChanges, formatOperation, formatOperations, generateDDL, getColumnName, getDestructiveOperationDescriptions, getTableName, hasDestructiveOperations, introspect, mapFieldType, push, serializeModels, strictResolver };
//# sourceMappingURL=migrations.d.mts.map