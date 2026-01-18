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

  // Helper to format column type, escaping enum types that need quoting
  const formatColumnType = (type: string): string => {
    // Enum types (identified by _enum suffix) need to be quoted to preserve case
    // PostgreSQL lowercases unquoted identifiers, but CREATE TYPE uses quoted names
    if (type.endsWith("_enum")) {
      return escapeIdentifier(type);
    }
    // Array types: check if base type is an enum
    if (type.endsWith("[]")) {
      const baseType = type.slice(0, -2);
      if (baseType.endsWith("_enum")) {
        return `${escapeIdentifier(baseType)}[]`;
      }
    }
    return type;
  };

  // Handle serial types for auto-increment
  if (column.autoIncrement) {
    if (column.type === "integer" || column.type === "int4") {
      parts.push("SERIAL");
    } else if (column.type === "bigint" || column.type === "int8") {
      parts.push("BIGSERIAL");
    } else if (column.type === "smallint" || column.type === "int2") {
      parts.push("SMALLSERIAL");
    } else {
      parts.push(formatColumnType(column.type));
    }
  } else {
    parts.push(formatColumnType(column.type));
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
      const {
        enumName,
        addValues,
        removeValues,
        newValues,
        dependentColumns,
        valueReplacements,
      } = operation;
      const statements: string[] = [];

      // If we're only adding values, use the simple ALTER TYPE ... ADD VALUE
      if (addValues && (!removeValues || removeValues.length === 0)) {
        for (const value of addValues) {
          statements.push(
            `ALTER TYPE ${escapeIdentifier(enumName)} ADD VALUE ${escapeValue(value)}`
          );
        }
        return statements.join(";\n");
      }

      // When removing values, we need to recreate the entire enum type
      // This requires:
      // 1. Convert dependent columns to text
      // 2. Migrate data for removed values (if replacements provided)
      // 3. Drop the old enum
      // 4. Create the new enum with correct values
      // 5. Convert columns back to the enum type
      if (removeValues && removeValues.length > 0) {
        if (!newValues || newValues.length === 0) {
          throw new Error(
            `Cannot alter enum "${enumName}": newValues required when removing values`
          );
        }

        // Step 1: Convert all dependent columns to text temporarily
        if (dependentColumns && dependentColumns.length > 0) {
          for (const { tableName, columnName } of dependentColumns) {
            statements.push(
              `ALTER TABLE ${escapeIdentifier(tableName)} ALTER COLUMN ${escapeIdentifier(columnName)} TYPE text`
            );
          }
        }

        // Step 2: Migrate data for removed values
        // This must happen AFTER converting to text but BEFORE dropping the enum
        if (dependentColumns && dependentColumns.length > 0) {
          for (const removedValue of removeValues) {
            // Check for explicit replacement first, then fall back to default
            let replacement: string | null | undefined;
            if (valueReplacements && removedValue in valueReplacements) {
              replacement = valueReplacements[removedValue];
            } else if (operation.defaultReplacement !== undefined) {
              replacement = operation.defaultReplacement;
            }

            // Only generate UPDATE if we have a replacement
            if (replacement !== undefined) {
              for (const { tableName, columnName } of dependentColumns) {
                const newValue =
                  replacement === null ? "NULL" : escapeValue(replacement);
                statements.push(
                  `UPDATE ${escapeIdentifier(tableName)} SET ${escapeIdentifier(columnName)} = ${newValue} WHERE ${escapeIdentifier(columnName)} = ${escapeValue(removedValue)}`
                );
              }
            }
          }
        }

        // Step 3: Drop the old enum type
        statements.push(`DROP TYPE ${escapeIdentifier(enumName)}`);

        // Step 4: Create the new enum with correct values
        const values = newValues.map(escapeValue).join(", ");
        statements.push(
          `CREATE TYPE ${escapeIdentifier(enumName)} AS ENUM (${values})`
        );

        // Step 5: Convert columns back to the enum type
        // Check if any removed values don't have replacements - add a warning comment
        const unreplacedValues = removeValues.filter((v) => {
          const hasExplicit = valueReplacements && v in valueReplacements;
          const hasDefault = operation.defaultReplacement !== undefined;
          return !(hasExplicit || hasDefault);
        });

        if (unreplacedValues.length > 0 && dependentColumns?.length) {
          statements.push(
            `-- WARNING: The following removed values have no replacement: ${unreplacedValues.map((v) => `'${v}'`).join(", ")}\n` +
              "-- If rows exist with these values, the migration will fail.\n" +
              "-- Fix options:\n" +
              `--   1. Add valueReplacements: { "${unreplacedValues[0]}": "newValue" }\n` +
              `--   2. Set defaultReplacement to your field's default value\n` +
              "--   3. Manually UPDATE rows before running this migration"
          );
        }

        if (dependentColumns && dependentColumns.length > 0) {
          for (const { tableName, columnName } of dependentColumns) {
            statements.push(
              `ALTER TABLE ${escapeIdentifier(tableName)} ALTER COLUMN ${escapeIdentifier(columnName)} TYPE ${escapeIdentifier(enumName)} USING ${escapeIdentifier(columnName)}::${escapeIdentifier(enumName)}`
            );
          }
        }
      }

      return statements.join(";\n");
    }

    default:
      throw new Error(`Unknown operation type: ${(operation as any).type}`);
  }
}
