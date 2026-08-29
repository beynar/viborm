import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";

// =============================================================================
// SCHEMA SNAPSHOT (database-agnostic representation)
// =============================================================================

export interface SchemaSnapshot {
  tables: TableDef[];
  enums?: EnumDef[] | undefined;
  /**
   * Generated-file history for polymorphic discriminator members.
   * This is descriptive metadata only; the structural differ ignores it.
   */
  polymorphicStorage?: readonly PolymorphicSnapshotStorage[] | undefined;
}

export interface PolymorphicToOneSnapshotMember {
  readonly publicType: string;
  readonly storedType: string;
  readonly targetTable: string;
}

/**
 * Logical-only history for a to-one polymorphic relation. The physical
 * facts (columns, index) live in the owner's {@link TableDef} where the
 * structural differ owns them; `storageRef` is the join key into the owner
 * table's `relationStorage` registry — the physical type-column name at
 * serialization time, opaque to every reader and normalized through accepted
 * rename operations before history joins.
 */
export interface PolymorphicToOneSnapshot {
  readonly ownerTable: string;
  readonly relation: string;
  readonly kind: "toOne";
  readonly storageRef: string;
  readonly members: readonly PolymorphicToOneSnapshotMember[];
}

export interface PolymorphicToManySnapshotMember {
  readonly publicType: string;
  readonly storedType: string;
  readonly targetTable: string;
  readonly memberJunctionTable: string;
  readonly inverseCardinality: "one" | "many";
}

/**
 * Logical-only history for a collection polymorphic relation: nothing
 * physical (no side columns, constraint names, or referential actions) — each
 * member names its junction table and the structural differ owns that table's
 * shape entirely.
 */
export interface PolymorphicToManySnapshot {
  readonly ownerTable: string;
  readonly relation: string;
  readonly kind: "toMany";
  readonly members: readonly PolymorphicToManySnapshotMember[];
}

export type PolymorphicSnapshotStorage =
  | PolymorphicToOneSnapshot
  | PolymorphicToManySnapshot;

/**
 * One relation-owned physical storage annotation on the table that carries it,
 * keyed in {@link TableDef.relationStorage} by the storage ref (the physical
 * type-column name at serialization time).
 */
export interface PolymorphicToOneStorageRegistryEntry {
  readonly kind: "polymorphicToOne";
  readonly typeColumn: string;
  readonly idColumn: string;
  readonly index: string;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  primaryKey?: PrimaryKeyDef | undefined;
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  uniqueConstraints: UniqueConstraintDef[];
  /**
   * Relation-owned storage registry, annotation ONLY: the structural differ
   * ignores it, drivers pass it through `finalizeTable` untouched, no DDL
   * reads it, and introspected snapshots never carry it. Its sole reader is
   * polymorphic member history, which joins
   * {@link PolymorphicToOneSnapshot.storageRef} into it.
   */
  relationStorage?:
    | Readonly<Record<string, PolymorphicToOneStorageRegistryEntry>>
    | undefined;
}

export interface ColumnDef {
  name: string;
  type: string; // Normalized type (e.g., "varchar(255)", "integer", "boolean")
  nullable: boolean;
  default?: string | undefined; // SQL expression for default value
  autoIncrement?: boolean | undefined;
  /**
   * The declared fixed-decimal domain this column stores, when it stores one.
   *
   * `type` is the ACTIVE PHYSICAL representation and this is the ONE logical
   * descriptor beside it — the pair every consumer reads (serializer, snapshot,
   * differ, DDL, introspection, defaults, table reconstruction). They are not
   * redundant: on PostgreSQL and MySQL the physical type spells the domain, but
   * on SQLite the class is `INTEGER` (scalar) or `TEXT` (list) whatever the
   * precision and scale are, so a descriptor change is invisible in `type`
   * alone and the differ would plan nothing for it.
   *
   * Every snapshot producer carries it — the serializer from
   * `ScalarState["decimal"]`, and each introspection from the fact its dialect
   * can prove (a PostgreSQL typmod, a MySQL `DECIMAL(p,s)` or column-comment
   * marker, a SQLite reserved CHECK constraint name) — because a side that
   * cannot recover it would read as a change on every push, forever.
   *
   * There is no parallel decimal metadata map on `Model`, adapter, or
   * migration driver (plan §7.2): this field is the migration layer's only
   * copy, and it is a copy of the frozen descriptor the resolved scalar owns.
   */
  decimal?: DecimalDescriptor | undefined;
}

export interface PrimaryKeyDef {
  columns: string[];
  name?: string | undefined;
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  type?: "btree" | "hash" | "gin" | "gist" | "fulltext" | "spatial" | undefined;
  where?: string | undefined; // For partial indexes
}

export interface ForeignKeyDef {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: ReferentialAction | undefined;
  onUpdate?: ReferentialAction | undefined;
}

export type ReferentialAction =
  | "cascade"
  | "setNull"
  | "restrict"
  | "noAction"
  | "setDefault";

export interface UniqueConstraintDef {
  name: string;
  columns: string[];
}

export interface EnumDef {
  name: string;
  values: string[];
}

// =============================================================================
// DIFF OPERATIONS (resolved, ready to execute)
// =============================================================================

export type DiffOperation =
  | { type: "createTable"; table: TableDef }
  | { type: "dropTable"; tableName: string }
  | { type: "renameTable"; from: string; to: string }
  | { type: "addColumn"; tableName: string; column: ColumnDef }
  | { type: "dropColumn"; tableName: string; columnName: string }
  | { type: "renameColumn"; tableName: string; from: string; to: string }
  | {
      type: "alterColumn";
      tableName: string;
      columnName: string;
      from: ColumnDef;
      to: ColumnDef;
    }
  | { type: "createIndex"; tableName: string; index: IndexDef }
  | { type: "dropIndex"; tableName: string; indexName: string }
  | { type: "addForeignKey"; tableName: string; fk: ForeignKeyDef }
  | { type: "dropForeignKey"; tableName: string; fkName: string }
  | {
      type: "addUniqueConstraint";
      tableName: string;
      constraint: UniqueConstraintDef;
    }
  | { type: "dropUniqueConstraint"; tableName: string; constraintName: string }
  | { type: "addPrimaryKey"; tableName: string; primaryKey: PrimaryKeyDef }
  | { type: "dropPrimaryKey"; tableName: string; constraintName: string }
  | { type: "createEnum"; enumDef: EnumDef }
  | {
      type: "dropEnum";
      enumName: string;
      /**
       * Columns that depend on this enum.
       * Required for SQLite to know which columns need CHECK constraint removal.
       */
      dependentColumns?: Array<{ tableName: string; columnName: string }>;
    }
  | {
      type: "alterEnum";
      enumName: string;
      addValues?: string[] | undefined;
      removeValues?: string[] | undefined;
      /**
       * Full list of desired enum values (required when removing values)
       * Used to recreate the enum type in PostgreSQL
       */
      newValues?: string[] | undefined;
      /**
       * Columns that depend on this enum (required when removing values)
       * Each entry is { tableName, columnName }
       */
      dependentColumns?:
        | Array<{ tableName: string; columnName: string }>
        | undefined;
      /**
       * Global replacement values for removed enum values.
       * Used as fallback when no column-specific mapping exists.
       * Maps old value -> new value for data migration.
       *
       * Example: { "pending": "inactive" } - rows with "pending" become "inactive"
       * Use null to set rows to NULL: { "pending": null }
       */
      valueReplacements?: Record<string, string | null> | undefined;
      /**
       * Per-column replacement values for removed enum values.
       * Allows different columns to have different mappings.
       * Key is "tableName.columnName", value is the replacement map.
       *
       * Example: { "users.status": { "pending": "inactive" }, "orders.status": { "pending": "cancelled" } }
       */
      columnValueReplacements?:
        | Record<string, Record<string, string | null>>
        | undefined;
      /**
       * Default replacement for any removed values without explicit mapping.
       * Useful when the enum field has a default value - use that here.
       * Use null to set rows to NULL.
       *
       * Example: If your field has `.default("active")`, set defaultReplacement: "active"
       */
      defaultReplacement?: string | null | undefined;
    };

// =============================================================================
// AMBIGUOUS CHANGES (require user input to resolve)
// =============================================================================

/** Detected when columns are added AND dropped in the same table */
export type AmbiguousColumnChange = {
  type: "ambiguousColumn";
  tableName: string;
  droppedColumn: ColumnDef;
  addedColumn: ColumnDef;
};

/** Detected when tables are added AND dropped */
export type AmbiguousTableChange = {
  type: "ambiguousTable";
  droppedTable: string;
  addedTable: string;
  droppedTableDef: TableDef;
  addedTableDef: TableDef;
};

export type AmbiguousChange = AmbiguousColumnChange | AmbiguousTableChange;

/** User's resolution for an ambiguous change */
export type ChangeResolution =
  | { type: "rename" } // Treat as rename (preserve data)
  | { type: "addAndDrop" }; // Treat as separate add + drop (data loss)

// =============================================================================
// DIFF RESULT (output of differ, before resolution)
// =============================================================================

export interface DiffResult {
  /** Operations that are unambiguous and ready to execute */
  operations: DiffOperation[];
  /** Changes that need user input to resolve */
  ambiguousChanges: AmbiguousChange[];
}

// =============================================================================
// RESOLVER (handles ambiguous changes)
// =============================================================================

/** Callback to resolve ambiguous changes (used by CLI or programmatic API) */
export type Resolver = (
  changes: AmbiguousChange[]
) => Promise<Map<AmbiguousChange, ChangeResolution>>;

// =============================================================================
// UNIFIED RESOLVE CALLBACK
// =============================================================================

/**
 * Valid resolution results.
 * - "proceed": Accept the change (for destructive)
 * - "reject": Reject the change and abort
 * - "rename": Treat as a rename (for ambiguous)
 * - "addAndDrop": Treat as separate add + drop (for ambiguous)
 * - "enumMapped": Enum values have been mapped (for enumValueRemoval)
 */
export type ResolveResult =
  | "proceed"
  | "reject"
  | "rename"
  | "addAndDrop"
  | "enumMapped";

/**
 * Base properties shared by destructive and ambiguous changes.
 */
interface BaseResolveChange {
  /** The specific operation type */
  operation:
    | "dropTable"
    | "dropColumn"
    | "alterColumn"
    | "renameTable"
    | "renameColumn";

  /** The table involved */
  table: string;

  /** The column involved (if applicable) */
  column?: string;

  /** Human-readable description of the change */
  description: string;

  /** Reject this change and abort the operation */
  reject(): "reject";
}

/**
 * A destructive change that will cause data loss.
 * Available methods: `proceed()`, `reject()`
 */
export interface DestructiveResolveChange extends BaseResolveChange {
  type: "destructive";

  /** Accept the destructive change (causes data loss) */
  proceed(): "proceed";
}

/**
 * An ambiguous change that could be a rename or add+drop.
 * Available methods: `rename()`, `addAndDrop()`, `reject()`
 */
export interface AmbiguousResolveChange extends BaseResolveChange {
  type: "ambiguous";

  /** The old name (for renames) */
  oldName?: string;

  /** The new name (for renames) */
  newName?: string;

  /** The old type (for alterColumn) */
  oldType?: string;

  /** The new type (for alterColumn) */
  newType?: string;

  /** Treat as a rename (preserves data) */
  rename(): "rename";

  /** Treat as separate add + drop (causes data loss) */
  addAndDrop(): "addAndDrop";
}

/**
 * An enum value removal that needs replacement mappings for a specific column.
 * Called once per column that uses the enum, allowing different mappings per column.
 * Available methods: `mapValues()`, `useNull()`, `reject()`
 */
export interface EnumValueRemovalChange {
  type: "enumValueRemoval";

  /** The enum name */
  enumName: string;

  /** The table containing the column */
  tableName: string;

  /** The column using this enum */
  columnName: string;

  /** Whether this column is nullable (if true, useNull() is safe) */
  isNullable: boolean;

  /** Values being removed */
  removedValues: string[];

  /** Available values to map to */
  availableValues: string[];

  /** Human-readable description */
  description: string;

  /**
   * Map removed values to replacement values.
   * @param replacements - Map of old value → new value (or null for NULL)
   */
  mapValues(replacements: Record<string, string | null>): "enumMapped";

  /**
   * Set all removed values to NULL.
   * This is a shorthand for mapValues where all values map to null.
   * Note: Only safe if the column is nullable.
   */
  useNull(): "enumMapped";

  /** Reject this change and abort the operation */
  reject(): "reject";

  /** Internal: stores the mapping result */
  _mappings?: Record<string, string | null>;

  /** Internal: flag indicating to use null as default */
  _useNullDefault?: boolean;
}

/**
 * A change that requires user resolution.
 * Use the type discriminant to determine which methods are available:
 * - `destructive`: `proceed()`, `reject()`
 * - `ambiguous`: `rename()`, `addAndDrop()`, `reject()`
 * - `enumValueRemoval`: `mapValues()`, `reject()`
 */
export type ResolveChange =
  | DestructiveResolveChange
  | AmbiguousResolveChange
  | EnumValueRemovalChange;

export type EnumResolutionDecision =
  | {
      readonly kind: "mapValues";
      readonly mappings: Record<string, string | null>;
    }
  | { readonly kind: "useNull" }
  | { readonly kind: "mixed" };

const enumResolutionDecisions = new WeakMap<
  ResolveChange,
  EnumResolutionDecision
>();

/** Internal authoritative decision made through an enum change's own methods. */
export function readEnumResolutionDecision(
  change: ResolveChange
): EnumResolutionDecision | undefined {
  return enumResolutionDecisions.get(change);
}

function recordEnumResolutionDecision(
  change: EnumValueRemovalChange,
  decision: Exclude<EnumResolutionDecision, { readonly kind: "mixed" }>
): void {
  const previous = enumResolutionDecisions.get(change);
  enumResolutionDecisions.set(
    change,
    previous !== undefined && previous.kind !== decision.kind
      ? { kind: "mixed" }
      : decision
  );
}

/**
 * Unified callback for resolving changes that need user input.
 * Called once per change, allowing granular control over each decision.
 *
 * @param change - The change requiring resolution
 * @returns The resolution decision (call a method on change to get this)
 *
 * @example
 * ```ts
 * resolve: async (change) => {
 *   console.log(change.description);
 *
 *   if (change.type === "destructive") {
 *     return confirm("Accept data loss?") ? change.proceed() : change.reject();
 *   }
 *
 *   if (change.type === "ambiguous") {
 *     return change.rename();
 *   }
 *
 *   if (change.type === "enumValueRemoval") {
 *     // Map removed enum values to new values
 *     return change.mapValues({
 *       'PENDING': 'INACTIVE',
 *       'OLD_VALUE': null,  // Set to NULL
 *     });
 *   }
 * }
 * ```
 */
export type ResolveCallback = (
  change: ResolveChange
) =>
  | Promise<ResolveResult | undefined | void>
  | ResolveResult
  | undefined
  | void;

/**
 * Create a destructive change object with resolution methods.
 */
export function createDestructiveChange(props: {
  operation: "dropTable" | "dropColumn" | "alterColumn";
  table: string;
  column?: string;
  description: string;
}): DestructiveResolveChange {
  return {
    type: "destructive",
    ...props,
    proceed: () => "proceed",
    reject: () => "reject",
  };
}

/**
 * Create an ambiguous change object with resolution methods.
 */
export function createAmbiguousChange(props: {
  operation: "renameTable" | "renameColumn";
  table: string;
  column?: string;
  oldName?: string;
  newName?: string;
  oldType?: string;
  newType?: string;
  description: string;
}): AmbiguousResolveChange {
  return {
    type: "ambiguous",
    ...props,
    rename: () => "rename",
    addAndDrop: () => "addAndDrop",
    reject: () => "reject",
  };
}

/**
 * Create an enum value removal change object with resolution methods.
 */
export function createEnumValueRemovalChange(props: {
  enumName: string;
  tableName: string;
  columnName: string;
  isNullable: boolean;
  removedValues: string[];
  availableValues: string[];
  description: string;
}): EnumValueRemovalChange {
  const change: EnumValueRemovalChange = {
    type: "enumValueRemoval",
    ...props,
    mapValues: (replacements: Record<string, string | null>) => {
      const mappings: Record<string, string | null> = {};
      for (const [value, replacement] of Object.entries(replacements)) {
        mappings[value] = replacement;
      }
      Object.freeze(mappings);
      recordEnumResolutionDecision(change, { kind: "mapValues", mappings });
      change._mappings = mappings;
      return "enumMapped";
    },
    useNull: () => {
      recordEnumResolutionDecision(change, { kind: "useNull" });
      change._useNullDefault = true;
      return "enumMapped";
    },
    reject: () => "reject",
  };
  return change;
}

/** Information about an enum value removal that needs resolution */
export interface EnumValueRemoval {
  enumName: string;
  removedValues: string[];
  newValues: string[];
  dependentColumns: Array<{ tableName: string; columnName: string }>;
}

/** User's resolution for enum value removal */
export interface EnumValueResolution {
  /** Map specific old values to new values */
  valueReplacements?: Record<string, string | null>;
  /** Default replacement for any values not in valueReplacements */
  defaultReplacement?: string | null;
}

/** Callback to resolve enum value removals (used by CLI or programmatic API) */
export type EnumValueResolver = (
  removals: EnumValueRemoval[]
) => Promise<Map<string, EnumValueResolution>>; // Map<enumName, resolution>

// =============================================================================
// UNIFIED RESOLVER (handles all resolution types)
// =============================================================================

/**
 * Resolution request types for the unified resolver.
 */
export type ResolutionRequestType = "ambiguous_change" | "enum_value_removal";

/**
 * Base interface for resolution requests.
 */
export interface ResolutionRequestBase<T extends ResolutionRequestType> {
  /** Unique identifier for this request */
  id: string;
  /** The type of resolution needed */
  type: T;
}

/**
 * Request to resolve an ambiguous schema change (rename vs add+drop).
 */
export interface AmbiguousChangeRequest
  extends ResolutionRequestBase<"ambiguous_change"> {
  /** The ambiguous change details */
  change: AmbiguousChange;
}

/**
 * Request to resolve enum value removals.
 */
export interface EnumValueRemovalRequest
  extends ResolutionRequestBase<"enum_value_removal"> {
  /** The enum value removal details */
  removal: EnumValueRemoval;
}

/**
 * Union type of all resolution request types.
 */
export type ResolutionRequest =
  | AmbiguousChangeRequest
  | EnumValueRemovalRequest;

/**
 * Resolution result for an ambiguous change.
 */
export interface AmbiguousChangeResolution {
  type: "ambiguous_change";
  resolution: ChangeResolution;
}

/**
 * Resolution result for an enum value removal.
 */
export interface EnumValueRemovalResolution {
  type: "enum_value_removal";
  resolution: EnumValueResolution;
}

/**
 * Union type of all resolution result types.
 */
export type ResolutionResult =
  | AmbiguousChangeResolution
  | EnumValueRemovalResolution;

/**
 * Unified resolver callback that handles all types of resolutions.
 *
 * This allows a single resolver to handle both ambiguous changes and
 * enum value removals in one callback, simplifying the API.
 *
 * @param requests - Array of resolution requests
 * @returns Map of request ID to resolution result
 */
export type UnifiedResolver = (
  requests: ResolutionRequest[]
) => Promise<Map<string, ResolutionResult>>;

/**
 * Helper to create an AmbiguousChangeRequest.
 */
export function createAmbiguousChangeRequest(
  id: string,
  change: AmbiguousChange
): AmbiguousChangeRequest {
  return { id, type: "ambiguous_change", change };
}

/**
 * Helper to create an EnumValueRemovalRequest.
 */
export function createEnumValueRemovalRequest(
  id: string,
  removal: EnumValueRemoval
): EnumValueRemovalRequest {
  return { id, type: "enum_value_removal", removal };
}

// =============================================================================
// PUSH RESULT
// =============================================================================

export interface PushResult {
  /** All operations that were applied (or would be applied in dry-run) */
  operations: DiffOperation[];
  /** Whether the operations were actually applied to the database */
  applied: boolean;
  /** Generated SQL statements */
  sql: string[];
}

// =============================================================================
// MIGRATION JOURNAL (tracks generated migrations)
// =============================================================================

export type Dialect = "postgresql" | "sqlite" | "mysql";

/**
 * The durable estate target a migration history is generated for.
 *
 * PostgreSQL carries its schema because generated artifacts are
 * schema-qualified: a history generated for `billing` cannot be replayed as a
 * `public` estate. MySQL and SQLite arms carry ONLY their dialect — MySQL
 * artifacts are database-relative on purpose, so one estate deploys to
 * `app_dev`, `app_test` and `app_prod`, and SQLite has no namespace concept.
 *
 * This is the DURABLE compatibility claim, not the live execution destination.
 * The live destination is the adapter's namespace, which MySQL reads at its
 * live boundary and never persists here.
 */
export type MigrationTarget =
  | { readonly dialect: "postgresql"; readonly namespace: string }
  | { readonly dialect: "mysql" }
  | { readonly dialect: "sqlite" };

/**
 * Version-3 journal. The independent top-level `dialect` field is gone: the
 * estate target replaces it, and a journal carrying both representations is
 * refused rather than reconciled.
 */
export interface MigrationJournal {
  /** Journal format version. Exactly `"3"`; there is no legacy reader. */
  readonly version: "3";
  /** The estate this history was generated for. */
  readonly target: MigrationTarget;
  /** List of migration entries */
  readonly entries: readonly MigrationEntry[];
}

/** How a migration's up artifact was produced. */
export type MigrationMode = "generated" | "manual";

/**
 * The rollback policy a migration entry commits to, persisted in the journal.
 *
 * `manual` carries no `sql`: manual rollback SQL is written to the ordinary
 * down artifact, never duplicated in the journal. `irreversible` keeps its
 * `reason` because no artifact holds it and `down()` quotes it when refusing.
 */
export type MigrationRollback =
  | { kind: "automatic" }
  | { kind: "manual" }
  | { kind: "irreversible"; reason: string };

export interface MigrationEntry {
  /** Sequential index (0, 1, 2...) */
  idx: number;
  /** Timestamp version (e.g., "20240118143052") */
  version: string;
  /** Migration name (e.g., "add_users_table") */
  name: string;
  /** Unix timestamp when generated */
  when: number;
  /** SHA256 hash of SQL content for integrity verification */
  checksum: string;
  /** How the up artifact was produced. */
  mode: MigrationMode;
  /** Rollback policy this entry commits to. */
  rollback: MigrationRollback;
  /** Optional tag for grouping migrations */
  tag?: string;
}

// =============================================================================
// GENERATE OPTIONS & RESULT
// =============================================================================

export interface GenerateOptions {
  /** Custom migration name (will be kebab-cased) */
  name?: string;
  /** Output directory for migrations (default: ./migrations). Ignored if storageDriver is provided. */
  dir?: string;
  /** Custom storage driver. If not provided, uses filesystem driver with `dir`. */
  storageDriver?: import("./storage/driver").MigrationStorageDriver;
  /** Resolver for ambiguous changes */
  resolver?: Resolver;
  /** Resolver for enum value removals */
  enumValueResolver?: EnumValueResolver;
  /** Don't write files, just return what would be generated */
  dryRun?: boolean;
  /**
   * Complete caller-owned migration artifact. Supplying this puts the WHOLE
   * migration in manual mode: generation emits only these statements and never
   * appends generated structural SQL around them.
   *
   * There is deliberately no `automatic` rollback arm here: `automatic` means
   * "generation inverted the operations it emitted", and manual mode emits no
   * generated operations. A caller who wants automatic inversion must not pass
   * `manualMigration`.
   */
  manualMigration?: {
    /** Complete ordered up artifact: structural DDL and data DML. */
    readonly up: readonly string[];
    readonly rollback:
      | { kind: "manual"; sql: readonly string[] }
      | { kind: "irreversible"; reason: string };
  };
}

export interface GenerateResult {
  /** Generated migration entry (null if no changes) */
  entry: MigrationEntry | null;
  /** Generated SQL statements */
  sql: string[];
  /** Combined SQL content with statement breakpoints */
  content: string;
  /** Operations included in migration */
  operations: DiffOperation[];
  /** Generated down (rollback) SQL statements */
  downSql: string[];
  /** Warnings about lossy or non-invertible operations in the down migration */
  downWarnings: string[];
  /**
   * How this migration's up artifact was produced. Reported at the top level
   * because `entry` is null in the no-changes return, so callers cannot read
   * the policy off the entry uniformly.
   */
  mode: MigrationMode;
  /** Rollback policy the generated entry commits to. */
  rollback: MigrationRollback;
  /** Whether files were written */
  written: boolean;
  /** Message describing the result */
  message: string;
}

// =============================================================================
// APPLY OPTIONS & RESULT
// =============================================================================

export interface ApplyOptions {
  /** Apply up to this migration index (inclusive) */
  to?: number;
  /** Don't apply, just return what would be applied */
  dryRun?: boolean;
}

/**
 * Result of applying migrations.
 * Throws MigrationError on failure instead of returning error object.
 */
export interface ApplyResult {
  /** Migrations that were applied */
  applied: MigrationEntry[];
  /** Migrations that are still pending */
  pending: MigrationEntry[];
}

// =============================================================================
// MIGRATION STATUS
// =============================================================================

export interface MigrationStatus {
  /** Migration entry from journal */
  entry: MigrationEntry;
  /** Whether this migration has been applied */
  applied: boolean;
  /** When the migration was applied (if applied) */
  appliedAt?: Date;
}

// =============================================================================
// APPLIED MIGRATION (from database tracking table)
// =============================================================================

export interface AppliedMigration {
  /** Migration name (matches MigrationEntry.name) */
  name: string;
  /** Checksum at time of application */
  checksum: string;
  /** When the migration was applied */
  appliedAt: Date;
}
