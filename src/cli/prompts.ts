/**
 * CLI Interactive Prompts
 *
 * Interactive prompts for resolving ambiguous changes using @clack/prompts.
 */

import * as p from "@clack/prompts";
import type {
  AmbiguousChange,
  ChangeResolution,
  DiffOperation,
  Resolver,
} from "../migrations/types";

// =============================================================================
// INTERACTIVE RESOLVER
// =============================================================================

/**
 * Interactive resolver using CLI prompts.
 * Asks the user to resolve each ambiguous change.
 */
export const interactiveResolver: Resolver = async (changes) => {
  const resolutions = new Map<AmbiguousChange, ChangeResolution>();

  for (const change of changes) {
    if (change.type === "ambiguousColumn") {
      const answer = await p.select({
        message: `Column "${change.droppedColumn.name}" was removed and "${change.addedColumn.name}" was added in table "${change.tableName}". Is this a rename?`,
        options: [
          {
            value: "rename",
            label: `Rename: ${change.droppedColumn.name} → ${change.addedColumn.name}`,
            hint: "Data will be preserved",
          },
          {
            value: "addAndDrop",
            label: "Add + Drop: Create new column, delete old one",
            hint: "Data in old column will be LOST",
          },
        ],
      });

      if (p.isCancel(answer)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }

      resolutions.set(change, { type: answer as "rename" | "addAndDrop" });
    }

    if (change.type === "ambiguousTable") {
      const answer = await p.select({
        message: `Table "${change.droppedTable}" was removed and "${change.addedTable}" was added. Is this a rename?`,
        options: [
          {
            value: "rename",
            label: `Rename: ${change.droppedTable} → ${change.addedTable}`,
            hint: "Data will be preserved",
          },
          {
            value: "addAndDrop",
            label: "Add + Drop: Create new table, delete old one",
            hint: "ALL DATA in old table will be LOST",
          },
        ],
      });

      if (p.isCancel(answer)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }

      resolutions.set(change, { type: answer as "rename" | "addAndDrop" });
    }
  }

  return resolutions;
};

// =============================================================================
// CONFIRMATION PROMPTS
// =============================================================================

/**
 * Prompts the user to confirm destructive operations.
 */
export async function confirmDestructiveChanges(
  descriptions: string[]
): Promise<boolean> {
  p.note(descriptions.join("\n"), "Destructive changes detected");

  const confirm = await p.confirm({
    message: "Do you want to proceed with these destructive changes?",
    initialValue: false,
  });

  if (p.isCancel(confirm)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  return confirm;
}

/**
 * Prompts the user to confirm applying changes.
 */
export async function confirmApplyChanges(): Promise<boolean> {
  const confirm = await p.confirm({
    message: "Apply these changes?",
    initialValue: true,
  });

  if (p.isCancel(confirm)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  return confirm;
}

// =============================================================================
// DISPLAY HELPERS
// =============================================================================

/**
 * Displays the list of operations that will be applied.
 */
export function displayOperations(operations: DiffOperation[]): void {
  if (operations.length === 0) {
    p.note("No changes detected. Your database is up to date.", "Status");
    return;
  }

  const lines: string[] = [];

  // Group operations by table
  const byTable = new Map<string, DiffOperation[]>();
  const tableOps: DiffOperation[] = [];
  const enumOps: DiffOperation[] = [];

  for (const op of operations) {
    if (
      op.type === "createTable" ||
      op.type === "dropTable" ||
      op.type === "renameTable"
    ) {
      tableOps.push(op);
    } else if (
      op.type === "createEnum" ||
      op.type === "dropEnum" ||
      op.type === "alterEnum"
    ) {
      enumOps.push(op);
    } else {
      const tableName = getTableName(op);
      if (tableName) {
        const ops = byTable.get(tableName) || [];
        ops.push(op);
        byTable.set(tableName, ops);
      }
    }
  }

  // Display enum operations
  if (enumOps.length > 0) {
    lines.push("Enums:");
    for (const op of enumOps) {
      lines.push(`  ${formatOp(op)}`);
    }
    lines.push("");
  }

  // Display table-level operations
  if (tableOps.length > 0) {
    lines.push("Tables:");
    for (const op of tableOps) {
      lines.push(`  ${formatOp(op)}`);
    }
    lines.push("");
  }

  // Display column-level operations by table
  for (const [tableName, ops] of byTable) {
    lines.push(`Table: ${tableName}`);
    for (const op of ops) {
      lines.push(`  ${formatOp(op)}`);
    }
    lines.push("");
  }

  p.note(lines.join("\n"), "Pending changes");
}

function getTableName(op: DiffOperation): string | null {
  switch (op.type) {
    case "addColumn":
    case "dropColumn":
    case "renameColumn":
    case "alterColumn":
    case "createIndex":
    case "addForeignKey":
    case "dropForeignKey":
    case "addUniqueConstraint":
    case "dropUniqueConstraint":
    case "addPrimaryKey":
    case "dropPrimaryKey":
      return op.tableName;
    default:
      return null;
  }
}

function formatOp(op: DiffOperation): string {
  switch (op.type) {
    case "createTable":
      return `✓ Create table "${op.table.name}"`;
    case "dropTable":
      return `✗ Drop table "${op.tableName}"`;
    case "renameTable":
      return `~ Rename table: ${op.from} → ${op.to}`;
    case "addColumn":
      return `+ Add column: ${op.column.name} (${op.column.type})`;
    case "dropColumn":
      return `- Drop column: ${op.columnName}`;
    case "renameColumn":
      return `~ Rename column: ${op.from} → ${op.to}`;
    case "alterColumn":
      return `~ Alter column: ${op.columnName}`;
    case "createIndex":
      return `+ Add index: ${op.index.name}`;
    case "dropIndex":
      return `- Drop index: ${op.indexName}`;
    case "addForeignKey":
      return `+ Add foreign key: ${op.fk.name}`;
    case "dropForeignKey":
      return `- Drop foreign key: ${op.fkName}`;
    case "addUniqueConstraint":
      return `+ Add unique constraint: ${op.constraint.name}`;
    case "dropUniqueConstraint":
      return `- Drop unique constraint: ${op.constraintName}`;
    case "addPrimaryKey":
      return "+ Add primary key";
    case "dropPrimaryKey":
      return `- Drop primary key: ${op.constraintName}`;
    case "createEnum":
      return `✓ Create enum "${op.enumDef.name}"`;
    case "dropEnum":
      return `✗ Drop enum "${op.enumName}"`;
    case "alterEnum": {
      const parts: string[] = [];
      if (op.addValues?.length) parts.push(`+${op.addValues.join(", ")}`);
      if (op.removeValues?.length) parts.push(`-${op.removeValues.join(", ")}`);
      return `~ Alter enum "${op.enumName}": ${parts.join(" ")}`;
    }
    default:
      return "Unknown operation";
  }
}

/**
 * Displays SQL statements that will be executed.
 */
export function displaySQL(sql: string[]): void {
  if (sql.length === 0) return;

  const formatted = sql.map((s) => `  ${s};`).join("\n\n");
  p.note(formatted, "SQL to execute");
}
