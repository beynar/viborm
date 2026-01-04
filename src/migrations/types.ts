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
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = "MigrationError";
  }
}
