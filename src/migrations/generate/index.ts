/**
 * Migration Generate
 *
 * Generates SQL migration files by comparing schema with previous snapshot.
 * Similar to `drizzle-kit generate` or `prisma migrate dev`.
 */

import { diff } from "../differ";
import { getMigrationDriver } from "../drivers";
import type { MigrationClient } from "../push";
import { resolveAmbiguousChanges, strictResolver } from "../resolver";
import { serializeModels } from "../serializer";
import {
  addJournalEntry,
  createMigrationEntry,
  formatMigrationFilename,
  getNextMigrationIndex,
} from "../storage";
import type { GenerateOptions, GenerateResult } from "../types";
import {
  DEFAULT_MIGRATIONS_DIR,
  generateMigrationName,
  normalizeDialect,
  resolveEnumValueRemovals,
} from "../utils";
import { formatMigrationContent } from "./file-writer";

/**
 * Generates a new migration file by comparing the schema with the last snapshot.
 *
 * @param client - VibORM client with driver and schema
 * @param options - Generation options
 * @returns Generation result with entry, SQL, and operations
 */
export async function generate(
  client: MigrationClient,
  options: GenerateOptions = {}
): Promise<GenerateResult> {
  const {
    name,
    dir = DEFAULT_MIGRATIONS_DIR,
    storageDriver,
    resolver = strictResolver,
    enumValueResolver,
    dryRun = false,
  } = options;

  const driver = client.$driver;
  const models = client.$schema;
  const dialect = normalizeDialect(driver.dialect);

  // Storage driver is required (client.ts validates this)
  if (!storageDriver) {
    throw new Error(
      "Storage driver is required for generate(). " +
        "Use createMigrationClient() with a storageDriver option."
    );
  }
  const storage = storageDriver;

  // Get the migration driver
  const migrationDriver = getMigrationDriver(driver.driverName, driver.dialect);

  // 1. Read previous snapshot (or create empty for first migration)
  const previousSnapshot = await storage.getSnapshotOrEmpty();

  // 2. Serialize current models to SchemaSnapshot
  const currentSnapshot = serializeModels(models, { migrationDriver });

  // 3. Calculate diff between snapshots
  const diffResult = diff(previousSnapshot, currentSnapshot);

  // 4. Resolve ambiguous changes
  let finalOperations = await resolveAmbiguousChanges(
    diffResult,
    currentSnapshot,
    resolver
  );

  // 5. Resolve enum value removals
  finalOperations = await resolveEnumValueRemovals(
    finalOperations,
    enumValueResolver
  );

  // 6. Check if there are any changes
  if (finalOperations.length === 0) {
    return {
      entry: null,
      sql: [],
      content: "",
      operations: [],
      written: false,
      message: "No schema changes detected.",
    };
  }

  // 7. Get or create journal
  const journal = await storage.getOrCreateJournal(dialect);

  // 8. Generate DDL statements
  const ddlContext = { currentSchema: previousSnapshot };
  const sql: string[] = [];

  for (const op of finalOperations) {
    const ddl = migrationDriver.generateDDL(op, ddlContext);
    // Split multi-statement DDL
    const statements = ddl.split(";\n").filter((s) => s.trim());
    for (const stmt of statements) {
      // Ensure statement ends with semicolon
      const trimmed = stmt.trim();
      sql.push(trimmed.endsWith(";") ? trimmed : `${trimmed};`);
    }
  }

  // 9. Create migration entry
  const idx = getNextMigrationIndex(journal);
  const migrationName = name || generateMigrationName(finalOperations);
  const content = formatMigrationContent(
    { idx, version: "", name: migrationName, when: Date.now(), checksum: "" },
    sql,
    dialect
  );

  const entry = createMigrationEntry(idx, migrationName, content);

  // Re-format content with the actual entry (which has checksum)
  const finalContent = formatMigrationContent(entry, sql, dialect);

  // 10. Write files (unless dry run)
  if (!dryRun) {
    // Write migration file
    await storage.writeMigration(entry, finalContent);

    // Update journal
    const updatedJournal = addJournalEntry(journal, entry);
    await storage.writeJournal(updatedJournal);

    // Update snapshot
    await storage.writeSnapshot(currentSnapshot);
  }

  return {
    entry,
    sql,
    content: finalContent,
    operations: finalOperations,
    written: !dryRun,
    message: dryRun
      ? `Would generate migration: ${formatMigrationFilename(entry)}`
      : `Generated migration: ${formatMigrationFilename(entry)}`,
  };
}

/**
 * Preview what migration would be generated without writing files.
 */
export async function preview(
  client: MigrationClient,
  options: Omit<GenerateOptions, "dryRun"> = {}
): Promise<GenerateResult> {
  return generate(client, { ...options, dryRun: true });
}

// Re-export utilities for convenience
export { formatMigrationFilename, getNextMigrationIndex } from "../storage";
export { generateMigrationName } from "../utils";
export { getMigrationFilePath, parseStatements } from "./file-writer";
export { readJournal } from "./journal";
export { getSnapshotOrEmpty, readSnapshot } from "./snapshot";
