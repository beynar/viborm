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
  extractForwardReferenceForeignKeys,
  generateMigrationName,
  normalizeDialect,
  resolveEnumValueRemovals,
} from "../utils";
import { formatDownMigrationContent, invertOperations } from "./down";
import { formatMigrationContent } from "./file-writer";
import { resolvePolymorphicMemberHistory } from "./polymorphic-history";

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
    polymorphicMemberResolver,
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
  // No canonicalization hook: `generate` compares two stored snapshots, both
  // written by the serializer, so there is no deparsed catalog spelling to
  // reconcile and no live connection to reconcile it through.
  const diffResult = await diff(previousSnapshot, currentSnapshot);

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

  // Structural renames establish the physical identity used by polymorphic
  // member history. The history check never emits SQL; it only refuses unsafe
  // metadata advancement unless the caller attests that separate DML ran.
  const polymorphicMetadataChanged =
    await resolvePolymorphicMemberHistory(
      previousSnapshot,
      currentSnapshot,
      finalOperations,
      polymorphicMemberResolver
    );

  // 5b. Lift forward-reference FKs out of CREATE TABLE so the generated
  // migration file orders every referenced table before its constraint
  // (Postgres/MySQL). No-op on SQLite/LibSQL (inline FKs, lazy resolution).
  finalOperations = extractForwardReferenceForeignKeys(
    finalOperations,
    migrationDriver
  );

  // 6. Check if there are any changes
  if (finalOperations.length === 0) {
    if (polymorphicMetadataChanged && !dryRun) {
      await storage.writeSnapshot(currentSnapshot);
    }

    return {
      entry: null,
      sql: [],
      content: "",
      operations: [],
      downSql: [],
      downWarnings: [],
      written: polymorphicMetadataChanged && !dryRun,
      message: polymorphicMetadataChanged
        ? dryRun
          ? "Would update polymorphic migration metadata snapshot."
          : "Updated polymorphic migration metadata snapshot."
        : "No schema changes detected.",
    };
  }

  // 7. Get or create journal
  const journal = await storage.getOrCreateJournal(dialect);

  // 8. Generate DDL statements. The snapshot describes the database before the
  // migration; the operations already written have moved it on, and SQLite's
  // table recreation needs both (see `DDLContext.precedingOperations`).
  const sql: string[] = [];

  for (const [position, op] of finalOperations.entries()) {
    const ddl = migrationDriver.generateDDL(op, {
      currentSchema: previousSnapshot,
      precedingOperations: finalOperations.slice(0, position),
    });
    // Split multi-statement DDL
    const statements = ddl.split(";\n").filter((s) => s.trim());
    for (const stmt of statements) {
      // Ensure statement ends with semicolon
      const trimmed = stmt.trim();
      sql.push(trimmed.endsWith(";") ? trimmed : `${trimmed};`);
    }
  }

  // 8b. Generate down (rollback) DDL from inverted operations.
  // Down statements run against the post-migration schema.
  const inverted = invertOperations(finalOperations, previousSnapshot);
  const downSql: string[] = [];

  for (const [position, op] of inverted.operations.entries()) {
    const ddl = migrationDriver.generateDDL(op, {
      currentSchema: currentSnapshot,
      precedingOperations: inverted.operations.slice(0, position),
    });
    const statements = ddl.split(";\n").filter((s) => s.trim());
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      downSql.push(trimmed.endsWith(";") ? trimmed : `${trimmed};`);
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

  const downContent = formatDownMigrationContent(
    migrationName,
    downSql,
    inverted.warnings
  );

  // 10. Write files (unless dry run)
  if (!dryRun) {
    // Write migration file
    await storage.writeMigration(entry, finalContent);

    // Write down migration file (meta/_down/)
    await storage.writeDownMigration(entry, downContent);

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
    downSql,
    downWarnings: inverted.warnings,
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
