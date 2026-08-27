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
      // Push renders for immediate execution, so every persistent name is
      // qualified with the live namespace.
      destination: "live",
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

  // The commit model, chosen BEFORE the owner that would open a transaction.
  // MySQL commits DDL as each statement runs, so a transaction here does not
  // provide atomicity — it manufactures the appearance of it, and `mysql2`
  // reports `supportsTransactions: true`, so the generic dispatch below opened
  // one for ordinary push and for the force-reset rebuild alike. Sequential
  // execution on the producer is the honest form. The boundary this loop
  // reaches is recorded by the producer (`runSequentialProgram`, opened by the
  // command that owns the whole program), so nothing is bookkept here.
  if (migrationDriver.dialect === "mysql") {
    for (const statement of statementGroups.transactionalStatements) {
      await driver._executeRaw(`${statement};`);
    }
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
