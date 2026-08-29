/**
 * Display-only live statement listing. Execution belongs to execute-dispatch.
 */

import type { DDLContext, MigrationDriver } from "../drivers";
import type { DiffOperation, SchemaSnapshot } from "../types";

export function generateDDLStatements(
  operations: DiffOperation[],
  migrationDriver: MigrationDriver,
  currentSchema: SchemaSnapshot
): string[] {
  const statements: string[] = [];

  for (const [position, operation] of operations.entries()) {
    const ddlContext: DDLContext = {
      destination: "live",
      currentSchema,
      precedingOperations: operations.slice(0, position),
    };
    statements.push(
      ...migrationDriver.compileStatements(operation, ddlContext)
    );
  }

  return statements;
}
