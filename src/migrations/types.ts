// =============================================================================
// SCHEMA SNAPSHOT (database-agnostic representation)
// =============================================================================

export interface SchemaSnapshot {
  tables: TableDef[];
  enums?: EnumDef[] | undefined;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  primaryKey?: PrimaryKeyDef | undefined;
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  uniqueConstraints: UniqueConstraintDef[];
}

export interface ColumnDef {
  name: string;
  type: string; // Normalized type (e.g., "varchar(255)", "integer", "boolean")
  nullable: boolean;
  default?: string | undefined; // SQL expression for default value
  autoIncrement?: boolean | undefined;
}

export interface PrimaryKeyDef {
  columns: string[];
  name?: string | undefined;
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  type?: "btree" | "hash" | "gin" | "gist" | undefined;
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
  | { type: "dropIndex"; indexName: string }
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
  | { type: "dropEnum"; enumName: string }
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
       * Replacement values for removed enum values.
       * Maps old value -> new value for data migration.
       * If a removed value has no replacement (and no defaultReplacement),
       * the migration will fail at runtime.
       *
       * Example: { "pending": "inactive" } - rows with "pending" become "inactive"
       * Use null to set rows to NULL: { "pending": null }
       */
      valueReplacements?: Record<string, string | null> | undefined;
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
// MIGRATION ERROR
// =============================================================================

export class MigrationError extends Error {
  readonly code?: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code ?? undefined;
  }
}
