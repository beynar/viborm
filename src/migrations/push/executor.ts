import type { AnyDriver } from "../../drivers/driver";
import type { DDLContext, MigrationDriver } from "../drivers";
import type { DiffOperation, SchemaSnapshot } from "../types";

const MATCH_ALTER_TYPE_ADD_VALUE = /^ALTER\s+TYPE\s+.*\s+ADD\s+VALUE\s+/i;

export function generateDDLStatements(
  operations: DiffOperation[],
  migrationDriver: MigrationDriver,
  currentSchema: SchemaSnapshot
): string[] {
  const ddlContext: DDLContext = { currentSchema };
  const statements: string[] = [];

  for (const operation of operations) {
    const ddl = migrationDriver.generateDDL(operation, ddlContext);
    statements.push(
      ...ddl.split(";\n").filter((statement) => statement.trim())
    );
  }

  return statements;
}

export async function executeDDLStatements(
  driver: AnyDriver,
  migrationDriver: MigrationDriver,
  statements: string[]
): Promise<void> {
  if (statements.length === 0) {
    return;
  }

  const statementGroups = splitTransactionStatements(
    statements,
    migrationDriver
  );

  for (const statement of statementGroups.addEnumValueStatements) {
    await driver._executeRaw(`${statement};`);
  }

  if (statementGroups.transactionalStatements.length > 0) {
    if (!driver.supportsTransactions && driver.supportsBatch) {
      await driver._executeBatch(
        statementGroups.transactionalStatements.map((statement) => ({
          sql: `${statement};`,
          params: [],
        }))
      );
      return;
    }

    await driver.withTransaction(async (txDriver) => {
      for (const statement of statementGroups.transactionalStatements) {
        await txDriver._executeRaw(`${statement};`);
      }
    });
  }
}

function splitTransactionStatements(
  statements: string[],
  migrationDriver: MigrationDriver
): {
  addEnumValueStatements: string[];
  transactionalStatements: string[];
} {
  const canAddValueInTransaction =
    migrationDriver.capabilities.supportsAddEnumValueInTransaction;
  const addEnumValueStatements: string[] = [];
  const transactionalStatements: string[] = [];

  for (const statement of statements) {
    if (
      !canAddValueInTransaction &&
      statement.trim().match(MATCH_ALTER_TYPE_ADD_VALUE)
    ) {
      addEnumValueStatements.push(statement);
    } else {
      transactionalStatements.push(statement);
    }
  }

  return {
    addEnumValueStatements,
    transactionalStatements,
  };
}
