import type { AnyDriver } from "../../drivers/driver";
import type { DDLContext, MigrationDriver } from "../drivers";
import {
  assertForeignKeysIntact,
  liftForeignKeyPragmas,
  withForeignKeysLifted,
} from "../foreign-keys";
import type { DiffOperation, SchemaSnapshot } from "../types";

const MATCH_ALTER_TYPE_ADD_VALUE = /^ALTER\s+TYPE\s+.*\s+ADD\s+VALUE\s+/i;

export function generateDDLStatements(
  operations: DiffOperation[],
  migrationDriver: MigrationDriver,
  currentSchema: SchemaSnapshot
): string[] {
  const statements: string[] = [];

  for (const [position, operation] of operations.entries()) {
    // `currentSchema` describes the database before the batch; the operations
    // already emitted have moved it on. SQLite's table recreation needs both.
    const ddlContext: DDLContext = {
      currentSchema,
      precedingOperations: operations.slice(0, position),
    };
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

  if (statementGroups.transactionalStatements.length === 0) {
    return;
  }

  if (!driver.supportsTransactions && driver.supportsBatch) {
    await driver._executeBatch(
      statementGroups.transactionalStatements.map((statement) => ({
        sql: `${statement};`,
        params: [],
      }))
    );
    return;
  }

  // SQLite's table recreation asks for foreign keys off, and a transaction
  // discards that request; the pragma has to bracket the transaction instead.
  // See `src/migrations/foreign-keys.ts`.
  const lifted = liftForeignKeyPragmas(
    driver,
    statementGroups.transactionalStatements
  );

  await withForeignKeysLifted(driver, lifted.bracket, () =>
    driver.withTransaction(async (txDriver) => {
      for (const statement of lifted.statements) {
        await txDriver._executeRaw(`${statement};`);
      }
      await assertForeignKeysIntact(txDriver, lifted.bracket);
    })
  );
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
