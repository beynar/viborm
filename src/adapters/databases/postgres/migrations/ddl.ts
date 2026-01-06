/**
 * PostgreSQL DDL Generation
 *
 * Converts database-agnostic diff operations into PostgreSQL-specific
 * DDL (Data Definition Language) statements.
 */

import type {
  ColumnDef,
  DiffOperation,
  ReferentialAction,
} from "../../../../migrations/types";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatReferentialAction(action: ReferentialAction): string {
  switch (action) {
    case "cascade":
      return "CASCADE";
    case "setNull":
      return "SET NULL";
    case "restrict":
      return "RESTRICT";
    case "setDefault":
      return "SET DEFAULT";
    default:
      return "NO ACTION";
  }
}

function generateColumnDef(column: ColumnDef): string {
  const parts: string[] = [escapeIdentifier(column.name)];

  // Handle serial types for auto-increment
  if (column.autoIncrement) {
    if (column.type === "integer" || column.type === "int4") {
      parts.push("SERIAL");
    } else if (column.type === "bigint" || column.type === "int8") {
      parts.push("BIGSERIAL");
    } else if (column.type === "smallint" || column.type === "int2") {
      parts.push("SMALLSERIAL");
    } else {
      parts.push(column.type);
    }
  } else {
    parts.push(column.type);
  }

  if (!column.nullable) {
    parts.push("NOT NULL");
  }

  if (column.default !== undefined && !column.autoIncrement) {
    parts.push(`DEFAULT ${column.default}`);
  }

  return parts.join(" ");
}

// =============================================================================
// DDL GENERATION
// =============================================================================

export function generateDDL(operation: DiffOperation): string {
  switch (operation.type) {
    case "createTable": {
      const { table } = operation;
      const columnDefs = table.columns.map(generateColumnDef);

      // Add primary key constraint
      if (table.primaryKey) {
        const pkCols = table.primaryKey.columns
          .map(escapeIdentifier)
          .join(", ");
        const pkName = table.primaryKey.name
          ? `CONSTRAINT ${escapeIdentifier(table.primaryKey.name)} `
          : "";
        columnDefs.push(`${pkName}PRIMARY KEY (${pkCols})`);
      }

      // Add unique constraints
      for (const uq of table.uniqueConstraints) {
        const uqCols = uq.columns.map(escapeIdentifier).join(", ");
        columnDefs.push(
          `CONSTRAINT ${escapeIdentifier(uq.name)} UNIQUE (${uqCols})`
        );
      }

      const sql = `CREATE TABLE ${escapeIdentifier(table.name)} (\n  ${columnDefs.join(",\n  ")}\n)`;

      // Add indexes and foreign keys as separate statements
      const statements = [sql];

      for (const idx of table.indexes) {
        statements.push(
          generateDDL({
            type: "createIndex",
            tableName: table.name,
            index: idx,
          })
        );
      }

      for (const fk of table.foreignKeys) {
        statements.push(
          generateDDL({ type: "addForeignKey", tableName: table.name, fk })
        );
      }

      return statements.join(";\n");
    }

    case "dropTable":
      return `DROP TABLE ${escapeIdentifier(operation.tableName)} CASCADE`;

    case "renameTable":
      return `ALTER TABLE ${escapeIdentifier(operation.from)} RENAME TO ${escapeIdentifier(operation.to)}`;

    case "addColumn": {
      const colDef = generateColumnDef(operation.column);
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} ADD COLUMN ${colDef}`;
    }

    case "dropColumn":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} DROP COLUMN ${escapeIdentifier(operation.columnName)}`;

    case "renameColumn":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} RENAME COLUMN ${escapeIdentifier(operation.from)} TO ${escapeIdentifier(operation.to)}`;

    case "alterColumn": {
      const { tableName, columnName, from, to } = operation;
      const statements: string[] = [];
      const table = escapeIdentifier(tableName);
      const col = escapeIdentifier(columnName);

      // Type change
      if (from.type !== to.type) {
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${to.type} USING ${col}::${to.type}`
        );
      }

      // Nullable change
      if (from.nullable !== to.nullable) {
        if (to.nullable) {
          statements.push(
            `ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`
          );
        } else {
          statements.push(
            `ALTER TABLE ${table} ALTER COLUMN ${col} SET NOT NULL`
          );
        }
      }

      // Default change
      if (from.default !== to.default) {
        if (to.default === undefined) {
          statements.push(
            `ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT`
          );
        } else {
          statements.push(
            `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${to.default}`
          );
        }
      }

      return statements.join(";\n");
    }

    case "createIndex": {
      const { tableName, index } = operation;
      const unique = index.unique ? "UNIQUE " : "";
      const indexType = index.type ? `USING ${index.type} ` : "";
      const cols = index.columns.map(escapeIdentifier).join(", ");
      const where = index.where ? ` WHERE ${index.where}` : "";
      return `CREATE ${unique}INDEX ${escapeIdentifier(index.name)} ON ${escapeIdentifier(tableName)} ${indexType}(${cols})${where}`;
    }

    case "dropIndex":
      return `DROP INDEX ${escapeIdentifier(operation.indexName)}`;

    case "addForeignKey": {
      const { tableName, fk } = operation;
      const cols = fk.columns.map(escapeIdentifier).join(", ");
      const refCols = fk.referencedColumns.map(escapeIdentifier).join(", ");
      const onDelete = fk.onDelete
        ? ` ON DELETE ${formatReferentialAction(fk.onDelete)}`
        : "";
      const onUpdate = fk.onUpdate
        ? ` ON UPDATE ${formatReferentialAction(fk.onUpdate)}`
        : "";
      return `ALTER TABLE ${escapeIdentifier(tableName)} ADD CONSTRAINT ${escapeIdentifier(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${escapeIdentifier(fk.referencedTable)} (${refCols})${onDelete}${onUpdate}`;
    }

    case "dropForeignKey":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} DROP CONSTRAINT ${escapeIdentifier(operation.fkName)}`;

    case "addUniqueConstraint": {
      const { tableName, constraint } = operation;
      const cols = constraint.columns.map(escapeIdentifier).join(", ");
      return `ALTER TABLE ${escapeIdentifier(tableName)} ADD CONSTRAINT ${escapeIdentifier(constraint.name)} UNIQUE (${cols})`;
    }

    case "dropUniqueConstraint":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} DROP CONSTRAINT ${escapeIdentifier(operation.constraintName)}`;

    case "addPrimaryKey": {
      const { tableName, primaryKey } = operation;
      const cols = primaryKey.columns.map(escapeIdentifier).join(", ");
      const name = primaryKey.name
        ? escapeIdentifier(primaryKey.name)
        : escapeIdentifier(`${tableName}_pkey`);
      return `ALTER TABLE ${escapeIdentifier(tableName)} ADD CONSTRAINT ${name} PRIMARY KEY (${cols})`;
    }

    case "dropPrimaryKey":
      return `ALTER TABLE ${escapeIdentifier(operation.tableName)} DROP CONSTRAINT ${escapeIdentifier(operation.constraintName)}`;

    case "createEnum": {
      const { enumDef } = operation;
      const values = enumDef.values.map(escapeValue).join(", ");
      return `CREATE TYPE ${escapeIdentifier(enumDef.name)} AS ENUM (${values})`;
    }

    case "dropEnum":
      return `DROP TYPE ${escapeIdentifier(operation.enumName)}`;

    case "alterEnum": {
      const { enumName, addValues, removeValues } = operation;
      const statements: string[] = [];

      // PostgreSQL can add values but not remove them easily
      if (addValues) {
        for (const value of addValues) {
          statements.push(
            `ALTER TYPE ${escapeIdentifier(enumName)} ADD VALUE ${escapeValue(value)}`
          );
        }
      }

      // Note: Removing enum values in PostgreSQL requires recreating the type
      if (removeValues && removeValues.length > 0) {
        statements.push(
          `-- WARNING: Removing enum values requires recreating the type. Values to remove: ${removeValues.join(", ")}`
        );
      }

      return statements.join(";\n");
    }

    default:
      throw new Error(`Unknown operation type: ${(operation as any).type}`);
  }
}
