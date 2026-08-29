/**
 * Down Migration Generation
 *
 * Inverts diff operations so a generated migration can be rolled back.
 * The inverse ops are emitted in reverse order of the up ops.
 */

import { applyNativeRename } from "../native-rename";
import type { DiffOperation, SchemaSnapshot, TableDef } from "../types";

export interface InvertedOperations {
  /** Inverse operations, in rollback execution order */
  operations: DiffOperation[];
  /** Warnings about lossy or non-invertible operations */
  warnings: string[];
}

/**
 * Invert a list of diff operations against the snapshot they were diffed FROM
 * (the schema state before the up migration runs).
 *
 * Non-invertible ops (missing previous definition) produce a warning instead
 * of an inverse op. Lossy ops (dropTable/dropColumn/alterEnum value removal)
 * invert structurally but cannot restore data — a warning is emitted.
 */
export function invertOperations(
  operations: DiffOperation[],
  previousSnapshot: SchemaSnapshot
): InvertedOperations {
  const warnings: string[] = [];
  const inverted: DiffOperation[] = [];

  // At the inverse of operation i, every rename that preceded i in the up
  // program is still active and every rename that followed it has already been
  // inverted. Keep the previous definitions at each exact prefix so a restored
  // FK targets the identity that exists at that point — neither always-old nor
  // always-new is correct.
  let previousAtOperationIdentity = previousSnapshot;
  const previousIdentityBefore: SchemaSnapshot[] = [];
  for (const op of operations) {
    previousIdentityBefore.push(previousAtOperationIdentity);
    if (op.type === "renameTable" || op.type === "renameColumn") {
      previousAtOperationIdentity = applyNativeRename(
        previousAtOperationIdentity,
        op
      );
    }
  }

  for (let i = operations.length - 1; i >= 0; i--) {
    const op = operations[i]!;
    const previousAtIdentity = previousIdentityBefore[i] ?? previousSnapshot;
    const findPrevTable = (name: string): TableDef | undefined =>
      previousAtIdentity.tables.find((table) => table.name === name);
    const inverse = invertOperation(
      op,
      previousSnapshot,
      findPrevTable,
      warnings
    );
    if (inverse) {
      inverted.push(...inverse);
    }
  }

  return { operations: inverted, warnings };
}

function invertOperation(
  op: DiffOperation,
  previousSnapshot: SchemaSnapshot,
  findPrevTable: (name: string) => TableDef | undefined,
  warnings: string[]
): DiffOperation[] | null {
  switch (op.type) {
    case "createTable":
      // Structurally exact, and destructive in the ordinary way: the inverse
      // drops the table with every row written since the migration ran. Said
      // out loud so reversing an added polymorphic member makes no
      // data-preservation claim it cannot keep.
      warnings.push(
        `createTable "${op.table.name}" inverts to dropTable: rolling back drops the table and every row created after this migration. No data is preserved.`
      );
      return [{ type: "dropTable", tableName: op.table.name }];

    case "dropTable": {
      const table = findPrevTable(op.tableName);
      if (!table) {
        warnings.push(
          `Cannot invert dropTable "${op.tableName}": table not found in previous snapshot.`
        );
        return null;
      }
      warnings.push(
        `dropTable "${op.tableName}" was lossy: rolling back recreates the table structure but not its data.`
      );
      return [{ type: "createTable", table }];
    }

    case "renameTable":
      return [{ type: "renameTable", from: op.to, to: op.from }];

    case "addColumn":
      return [
        {
          type: "dropColumn",
          tableName: op.tableName,
          columnName: op.column.name,
        },
      ];

    case "dropColumn": {
      const table = findPrevTable(op.tableName);
      const column = table?.columns.find((c) => c.name === op.columnName);
      if (!column) {
        warnings.push(
          `Cannot invert dropColumn "${op.tableName}.${op.columnName}": column not found in previous snapshot.`
        );
        return null;
      }
      warnings.push(
        `dropColumn "${op.tableName}.${op.columnName}" was lossy: rolling back restores the column but not its data.`
      );
      return [{ type: "addColumn", tableName: op.tableName, column }];
    }

    case "renameColumn":
      return [
        {
          type: "renameColumn",
          tableName: op.tableName,
          from: op.to,
          to: op.from,
        },
      ];

    case "alterColumn":
      return [
        {
          type: "alterColumn",
          tableName: op.tableName,
          columnName: op.columnName,
          from: op.to,
          to: op.from,
        },
      ];

    case "createIndex":
      return [
        {
          type: "dropIndex",
          tableName: op.tableName,
          indexName: op.index.name,
        },
      ];

    case "dropIndex": {
      const table = findPrevTable(op.tableName);
      const index = table?.indexes.find((i) => i.name === op.indexName);
      if (!index) {
        warnings.push(
          `Cannot invert dropIndex "${op.indexName}" on "${op.tableName}": index not found in previous snapshot.`
        );
        return null;
      }
      return [{ type: "createIndex", tableName: op.tableName, index }];
    }

    case "addForeignKey":
      return [
        {
          type: "dropForeignKey",
          tableName: op.tableName,
          fkName: op.fk.name,
        },
      ];

    case "dropForeignKey": {
      const table = findPrevTable(op.tableName);
      const fk = table?.foreignKeys.find((f) => f.name === op.fkName);
      if (!fk) {
        warnings.push(
          `Cannot invert dropForeignKey "${op.fkName}" on "${op.tableName}": foreign key not found in previous snapshot.`
        );
        return null;
      }
      return [{ type: "addForeignKey", tableName: op.tableName, fk }];
    }

    case "addUniqueConstraint":
      return [
        {
          type: "dropUniqueConstraint",
          tableName: op.tableName,
          constraintName: op.constraint.name,
        },
      ];

    case "dropUniqueConstraint": {
      const table = findPrevTable(op.tableName);
      const constraint = table?.uniqueConstraints.find(
        (u) => u.name === op.constraintName
      );
      if (!constraint) {
        warnings.push(
          `Cannot invert dropUniqueConstraint "${op.constraintName}" on "${op.tableName}": constraint not found in previous snapshot.`
        );
        return null;
      }
      return [
        { type: "addUniqueConstraint", tableName: op.tableName, constraint },
      ];
    }

    case "addPrimaryKey":
      return [
        {
          type: "dropPrimaryKey",
          tableName: op.tableName,
          constraintName: op.primaryKey.name ?? `${op.tableName}_pkey`,
        },
      ];

    case "dropPrimaryKey": {
      const table = findPrevTable(op.tableName);
      if (!table?.primaryKey) {
        warnings.push(
          `Cannot invert dropPrimaryKey on "${op.tableName}": primary key not found in previous snapshot.`
        );
        return null;
      }
      return [
        {
          type: "addPrimaryKey",
          tableName: op.tableName,
          primaryKey: table.primaryKey,
        },
      ];
    }

    case "createEnum":
      return [{ type: "dropEnum", enumName: op.enumDef.name }];

    case "dropEnum": {
      const enumDef = previousSnapshot.enums?.find(
        (e) => e.name === op.enumName
      );
      if (!enumDef) {
        warnings.push(
          `Cannot invert dropEnum "${op.enumName}": enum not found in previous snapshot.`
        );
        return null;
      }
      return [{ type: "createEnum", enumDef }];
    }

    case "alterEnum": {
      const prevEnum = previousSnapshot.enums?.find(
        (e) => e.name === op.enumName
      );
      if (!prevEnum) {
        warnings.push(
          `Cannot invert alterEnum "${op.enumName}": enum not found in previous snapshot.`
        );
        return null;
      }
      if (op.removeValues?.length) {
        warnings.push(
          `alterEnum "${op.enumName}" removed values [${op.removeValues.join(", ")}]: rolling back restores the values but not replaced row data.`
        );
      }
      if (op.addValues?.length) {
        warnings.push(
          `alterEnum "${op.enumName}" rollback removes values [${op.addValues.join(", ")}]: rows using them will fail unless remapped manually.`
        );
      }
      return [
        {
          type: "alterEnum",
          enumName: op.enumName,
          addValues: op.removeValues,
          removeValues: op.addValues,
          newValues: prevEnum.values,
          dependentColumns: op.dependentColumns,
        },
      ];
    }

    default:
      warnings.push(
        `Cannot invert unknown operation type "${(op as { type: string }).type}".`
      );
      return null;
  }
}

/**
 * Format the down artifact of an irreversible migration: a comment-only record
 * of WHY it cannot be rolled back.
 *
 * This artifact is never executed and cannot be mistaken for a rollback:
 * `down()` dispatches on the entry's persisted rollback policy strictly before
 * it reads any artifact, so an irreversible entry refuses before this file is
 * opened — while a comment-only artifact under an automatic or manual policy is
 * fatal. Writing it keeps the four generated artifacts uniform and leaves a
 * readable record on disk.
 */
export function formatIrreversibleDownContent(
  migrationName: string,
  reason: string
): string {
  return `-- Down migration for: ${migrationName}\n-- IRREVERSIBLE: ${reason}\n`;
}

/**
 * Format the content of a down migration file: warning header + statements.
 */
export function formatDownMigrationContent(
  migrationName: string,
  statements: string[],
  warnings: string[]
): string {
  const lines = [`-- Down migration for: ${migrationName}`];
  for (const warning of warnings) {
    lines.push(`-- WARNING: ${warning}`);
  }
  lines.push("");
  lines.push(statements.join("\n--> statement-breakpoint\n"));
  return `${lines.join("\n")}\n`;
}
