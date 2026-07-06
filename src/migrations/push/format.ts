import type { AmbiguousChange, DiffOperation } from "../types";

/**
 * Formats an operation for human-readable display.
 */
export function formatOperation(op: DiffOperation): string {
  switch (op.type) {
    case "createTable":
      return `+ Create table "${op.table.name}" with ${op.table.columns.length} columns`;
    case "dropTable":
      return `- Drop table "${op.tableName}"`;
    case "renameTable":
      return `~ Rename table "${op.from}" → "${op.to}"`;
    case "addColumn":
      return `+ Add column "${op.column.name}" (${op.column.type}) to "${op.tableName}"`;
    case "dropColumn":
      return `- Drop column "${op.columnName}" from "${op.tableName}"`;
    case "renameColumn":
      return `~ Rename column "${op.from}" → "${op.to}" in "${op.tableName}"`;
    case "alterColumn":
      return `~ Alter column "${op.columnName}" in "${op.tableName}"`;
    case "createIndex":
      return `+ Create index "${op.index.name}" on "${op.tableName}"`;
    case "dropIndex":
      return `- Drop index "${op.indexName}"`;
    case "addForeignKey":
      return `+ Add foreign key "${op.fk.name}" to "${op.tableName}"`;
    case "dropForeignKey":
      return `- Drop foreign key "${op.fkName}" from "${op.tableName}"`;
    case "addUniqueConstraint":
      return `+ Add unique constraint "${op.constraint.name}" to "${op.tableName}"`;
    case "dropUniqueConstraint":
      return `- Drop unique constraint "${op.constraintName}" from "${op.tableName}"`;
    case "addPrimaryKey":
      return `+ Add primary key to "${op.tableName}"`;
    case "dropPrimaryKey":
      return `- Drop primary key "${op.constraintName}" from "${op.tableName}"`;
    case "createEnum":
      return `+ Create enum "${op.enumDef.name}" with values [${op.enumDef.values.join(", ")}]`;
    case "dropEnum":
      return `- Drop enum "${op.enumName}"`;
    case "alterEnum": {
      const parts: string[] = [];
      if (op.addValues?.length) parts.push(`add: ${op.addValues.join(", ")}`);
      if (op.removeValues?.length) {
        parts.push(`remove: ${op.removeValues.join(", ")}`);
      }
      return `~ Alter enum "${op.enumName}" (${parts.join("; ")})`;
    }
    default:
      return `Unknown operation: ${getOperationType(op)}`;
  }
}

/**
 * Formats all operations for human-readable display.
 */
export function formatOperations(operations: DiffOperation[]): string {
  if (operations.length === 0) {
    return "No changes detected.";
  }

  return operations.map(formatOperation).join("\n");
}

export function formatDestructiveOperation(op: DiffOperation): string {
  switch (op.type) {
    case "dropTable":
      return `[destructive] Drop table "${op.tableName}"`;
    case "dropColumn":
      return `[destructive] Drop column "${op.columnName}" from "${op.tableName}"`;
    case "alterColumn":
      return `[destructive] Alter column "${op.columnName}" in "${op.tableName}"`;
    default:
      return `[destructive] ${getOperationType(op)}`;
  }
}

export function formatAmbiguousChangeDescription(
  change: AmbiguousChange
): string {
  if (change.type === "ambiguousColumn") {
    return `[ambiguous] Column "${change.droppedColumn.name}" → "${change.addedColumn.name}" in "${change.tableName}"`;
  }
  return `[ambiguous] Table "${change.droppedTable}" → "${change.addedTable}"`;
}

function getOperationType(operation: { type: string }): string {
  return operation.type;
}
