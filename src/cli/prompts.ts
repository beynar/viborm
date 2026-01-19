/**
 * CLI Interactive Prompts
 *
 * Interactive prompts for resolving changes using @clack/prompts.
 */

import * as p from "@clack/prompts";
import type {
  AmbiguousChange,
  ChangeResolution,
  DiffOperation,
  ResolveCallback,
  ResolveChange,
  ResolveResult,
  Resolver,
} from "../migrations/types";

// =============================================================================
// INTERACTIVE RESOLVE CALLBACK
// =============================================================================

/**
 * Interactive resolve callback using CLI prompts.
 * Asks the user to resolve each destructive/ambiguous/enum change.
 */
export const interactiveResolve: ResolveCallback = async (
  change: ResolveChange
): Promise<ResolveResult> => {
  if (change.type === "destructive") {
    // Show destructive change and ask for confirmation
    p.note(change.description, "Destructive change");

    const answer = await p.confirm({
      message: "Do you want to proceed with this change?",
      initialValue: false,
    });

    if (p.isCancel(answer)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    return answer ? change.proceed() : change.reject();
  }

  if (change.type === "enumValueRemoval") {
    // Enum value removal - ask for replacement mappings per column
    const nullableNote = change.isNullable
      ? " (nullable - can safely set to NULL)"
      : " (non-nullable)";

    p.note(
      `Column: ${change.tableName}.${change.columnName}${nullableNote}\n` +
        `Removing values: ${change.removedValues.join(", ")}\n` +
        `Available values: ${change.availableValues.join(", ")}${change.isNullable ? " or NULL" : ""}`,
      `Enum "${change.enumName}" value removal`
    );

    // For nullable columns, offer a quick option to set all to NULL
    if (change.isNullable) {
      const useNull = await p.confirm({
        message: "Set all removed values to NULL?",
        initialValue: true,
      });

      if (p.isCancel(useNull)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }

      if (useNull) {
        return change.useNull();
      }
    }

    const mappings: Record<string, string | null> = {};

    for (const removedValue of change.removedValues) {
      const options = [
        ...(change.isNullable
          ? [{ value: "__NULL__", label: "NULL", hint: "Set to null" }]
          : []),
        ...change.availableValues.map((v) => ({
          value: v,
          label: v,
          hint: `Replace with "${v}"`,
        })),
      ];

      const answer = await p.select<{ value: string; label: string }[], string>({
        message: `Map "${removedValue}" to:`,
        options,
      });

      if (p.isCancel(answer)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
      }

      mappings[removedValue] = answer === "__NULL__" ? null : (answer as string);
    }

    return change.mapValues(mappings);
  }

  // Ambiguous change - ask rename vs add+drop
  const options =
    change.operation === "renameTable"
      ? [
          {
            value: "rename" as const,
            label: `Rename: ${change.oldName} → ${change.newName}`,
            hint: "Data will be preserved",
          },
          {
            value: "addAndDrop" as const,
            label: "Add + Drop: Create new table, delete old one",
            hint: "ALL DATA in old table will be LOST",
          },
        ]
      : [
          {
            value: "rename" as const,
            label: `Rename: ${change.oldName} → ${change.newName}`,
            hint: "Data will be preserved",
          },
          {
            value: "addAndDrop" as const,
            label: "Add + Drop: Create new column, delete old one",
            hint: "Data in old column will be LOST",
          },
        ];

  const answer = await p.select({
    message: change.description,
    options,
  });

  if (p.isCancel(answer)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  return answer === "rename" ? change.rename() : change.addAndDrop();
};

// =============================================================================
// LEGACY RESOLVER (for generate command)
// =============================================================================

/**
 * Interactive resolver for ambiguous changes (legacy Resolver type).
 * Used by the generate command for resolving ambiguous changes.
 */
export const interactiveResolver: Resolver = async (
  changes: AmbiguousChange[]
): Promise<Map<AmbiguousChange, ChangeResolution>> => {
  const resolutions = new Map<AmbiguousChange, ChangeResolution>();

  for (const change of changes) {
    const isTable = change.type === "ambiguousTable";
    const oldName = isTable
      ? change.droppedTable
      : change.droppedColumn.name;
    const newName = isTable
      ? change.addedTable
      : change.addedColumn.name;
    const tableName = isTable ? "" : ` in table "${change.tableName}"`;

    const options = [
      {
        value: "rename" as const,
        label: `Rename: ${oldName} → ${newName}`,
        hint: "Data will be preserved",
      },
      {
        value: "addAndDrop" as const,
        label: isTable
          ? "Add + Drop: Create new table, delete old one"
          : "Add + Drop: Create new column, delete old one",
        hint: isTable
          ? "ALL DATA in old table will be LOST"
          : "Data in old column will be LOST",
      },
    ];

    const answer = await p.select({
      message: `${isTable ? "Table" : "Column"} "${oldName}" → "${newName}"${tableName} (rename or add+drop?)`,
      options,
    });

    if (p.isCancel(answer)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }

    resolutions.set(change, { type: answer as "rename" | "addAndDrop" });
  }

  return resolutions;
};

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
