/**
 * Migration Generate
 *
 * Generates SQL migration files by comparing schema with previous snapshot.
 * Similar to `drizzle-kit generate` or `prisma migrate dev`.
 */

import { hydrateSchemaNames } from "../../schema/hydration";
import { resolveSchemaOrThrow } from "../../schema/validation";
import { MigrationContext } from "../context";
import { diff } from "../differ";
import type { MigrationClient } from "../push";
import { resolveAmbiguousChanges, strictResolver } from "../resolver";
import { serializeResolvedModels } from "../serializer";
import {
  addJournalEntry,
  createEmptyJournal,
  createEmptySnapshot,
  createMigrationEntry,
  formatMigrationFilename,
  getNextMigrationIndex,
} from "../storage";
import type {
  GenerateOptions,
  GenerateResult,
  MigrationMode,
  MigrationRollback,
} from "../types";
import {
  extractForwardReferenceForeignKeys,
  generateMigrationName,
  materializeDroppedTableForeignKeys,
  resolveEnumValueRemovals,
} from "../utils";
import {
  formatDownMigrationContent,
  formatIrreversibleDownContent,
  invertOperations,
} from "./down";
import { formatMigrationContent } from "./file-writer";
import { resolveManualArtifact } from "./manual-artifact";
import {
  pairPolymorphicMemberRenames,
  resolvePolymorphicMemberHistory,
} from "./polymorphic-history";

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
    storageDriver,
    resolver = strictResolver,
    enumValueResolver,
    dryRun = false,
    manualMigration,
  } = options;

  const models = client.$schema;
  // Plan §7.3: migration generation is an effect-capable boundary, so both
  // phases of the definition pipeline run here too — the identity preflight
  // (idempotent for an already-bound key) and then the structural gate. A
  // migration file is a durable artifact: writing one from an unproven topology
  // is the one failure mode a later validation pass cannot undo.
  hydrateSchemaNames(models);
  // ONE resolution for this composition root, handed to the serializer by
  // identity — the gate's index IS the serializer's topology input (§10E.6).
  const relations = resolveSchemaOrThrow(models);

  // Storage driver is required (client.ts validates this)
  if (!storageDriver) {
    throw new Error(
      "Storage driver is required for generate(). " +
        "Use createMigrationClient() with a storageDriver option."
    );
  }
  const storage = storageDriver;

  // The context owns the estate: one resolved target, one bound migration
  // driver, one gate. Generation is offline — it never admits live capability
  // and never connects.
  const ctx = new MigrationContext(client, { storageDriver: storage });
  const { target } = ctx;
  const dialect = target.dialect;
  const migrationDriver = ctx.migrationDriver;

  // 0. Validate the caller-owned artifact BEFORE any snapshot read: supplying
  // it elects manual mode for the whole migration (whether or not a
  // data-bearing transition exists), so an incomplete artifact must not reach
  // the diff, let alone a write.
  const manualArtifact = manualMigration
    ? resolveManualArtifact(manualMigration, name, dialect)
    : null;

  // 1. Read and validate the estate BEFORE the snapshot is deserialized, and
  // before the no-op return below: a `beta` client must not consume, diff
  // against, or extend an `alpha` estate even when it would emit nothing.
  const baseline = await ctx.readEstateBaseline();
  // A fresh estate, and a target-bound estate with no migrations yet, hold no
  // snapshot document. The empty baseline is a DIFF INPUT synthesized here, at
  // the one place that needs one — the gate reports what storage actually
  // holds, so an accessor cannot report a document that does not exist.
  const previousSnapshot = baseline.snapshot ?? createEmptySnapshot();

  // 2. Serialize current models to SchemaSnapshot
  const currentSnapshot = serializeResolvedModels(
    models,
    migrationDriver,
    relations
  );

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

  // 5c. Deterministic member-junction rename pairing: a renamed public
  // variant moves its default-named member junction table AND its
  // variant-derived target columns, a shape the Jaccard rename heuristic can
  // never offer. The stable stored value proves the member's identity, so the
  // drop+create pair is rewritten into renameTable+renameColumn here — before
  // member history classifies it. Push deliberately keeps add/drop.
  finalOperations = pairPolymorphicMemberRenames(
    previousSnapshot,
    currentSnapshot,
    finalOperations
  );

  // Structural renames establish the physical identity used by polymorphic
  // member history. The history check never emits SQL; it refuses every
  // data-bearing polymorphic transition outright — before the journal read,
  // SQL generation and every storage write below, dry-run included — unless the
  // caller supplied the complete artifact, which makes them its author.
  const polymorphicMetadataChanged = resolvePolymorphicMemberHistory(
    previousSnapshot,
    currentSnapshot,
    finalOperations,
    { manualArtifactSupplied: manualArtifact !== null }
  );

  // 5b. Lift forward-reference FKs out of CREATE TABLE so the generated
  // migration file orders every referenced table before its constraint
  // (Postgres/MySQL). No-op on SQLite/LibSQL (inline FKs, lazy resolution).
  finalOperations = extractForwardReferenceForeignKeys(
    finalOperations,
    migrationDriver
  );

  // 5c. Materialize the foreign-key drops a dropped-table graph needs. The
  // differ omits a drop when BOTH endpoint tables disappear, and §6.1 removed
  // the `CASCADE` that used to hide it — so the generated up artifact has to
  // carry the drops explicitly, exactly as push does.
  finalOperations = materializeDroppedTableForeignKeys(
    finalOperations,
    previousSnapshot,
    migrationDriver
  );

  // 6. Check if there are any changes.
  // A manual migration is never zero-op: its statements ARE the migration, and
  // the flagship case — a toOne stored-value rewrite — produces no structural
  // operations at all. Returning early here would silently discard the
  // caller's artifact and write only the snapshot.
  if (finalOperations.length === 0 && !manualArtifact) {
    if (polymorphicMetadataChanged && !dryRun) {
      // A metadata-only snapshot is still an estate document, so it gets its
      // journal: a snapshot with no journal has no target proof and the next
      // read of this estate would refuse it. A fresh no-op writes neither.
      await storage.writeJournal(
        baseline.journal ?? createEmptyJournal(target)
      );
      await storage.writeSnapshot(currentSnapshot);
    }

    return {
      entry: null,
      sql: [],
      content: "",
      operations: [],
      downSql: [],
      downWarnings: [],
      mode: "generated",
      rollback: { kind: "automatic" },
      written: polymorphicMetadataChanged && !dryRun,
      message: polymorphicMetadataChanged
        ? dryRun
          ? "Would update polymorphic migration metadata snapshot."
          : "Updated polymorphic migration metadata snapshot."
        : "No schema changes detected.",
    };
  }

  // 7. The journal for this estate — the one the gate already validated, or a
  // new empty one bound to this exact target.
  const journal = baseline.journal ?? createEmptyJournal(target);

  // 8. Emit the migration's SQL.
  //
  // Manual mode substitutes wholesale: the caller's statements ARE the
  // migration, so neither the up DDL loop nor the inversion below runs and
  // nothing generated is ever appended around them. `downWarnings` is empty
  // because no inversion ran — an irreversible `reason` is policy, not a
  // warning, and it rides on the entry.
  const sql: string[] = [];
  const downSql: string[] = [];
  const downWarnings: string[] = [];
  const mode: MigrationMode = manualArtifact ? "manual" : "generated";
  const rollback: MigrationRollback = manualArtifact
    ? manualArtifact.rollback
    : { kind: "automatic" };

  if (manualArtifact) {
    sql.push(...manualArtifact.sql);
    downSql.push(...manualArtifact.downSql);
  } else {
    // 8a. Generate DDL statements. The snapshot describes the database before
    // the migration; the operations already written have moved it on, and
    // SQLite's table recreation needs both (see
    // `DDLContext.precedingOperations`).
    for (const [position, op] of finalOperations.entries()) {
      const ddl = migrationDriver.generateDDL(op, {
        // Durable artifact: MySQL stays database-relative here, PostgreSQL
        // still contains its schema because its estate is bound to one.
        destination: "artifact",
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
    // The inverted program runs against the POST-migration schema, so its
    // dropped-table graph is read from `currentSnapshot`. Same stage, same
    // owner: a rollback that drops two mutually-referencing tables needs the
    // same explicit key drops the forward program does.
    inverted.operations = materializeDroppedTableForeignKeys(
      inverted.operations,
      currentSnapshot,
      migrationDriver
    );

    for (const [position, op] of inverted.operations.entries()) {
      const ddl = migrationDriver.generateDDL(op, {
        destination: "artifact",
        currentSchema: currentSnapshot,
        precedingOperations: inverted.operations.slice(0, position),
      });
      const statements = ddl.split(";\n").filter((s) => s.trim());
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        downSql.push(trimmed.endsWith(";") ? trimmed : `${trimmed};`);
      }
    }
    downWarnings.push(...inverted.warnings);
  }

  // 9. Create migration entry
  const idx = getNextMigrationIndex(journal);
  const migrationName = manualArtifact
    ? manualArtifact.name
    : name || generateMigrationName(finalOperations);
  const content = formatMigrationContent(
    {
      idx,
      version: "",
      name: migrationName,
      when: Date.now(),
      checksum: "",
      mode,
      rollback,
    },
    sql,
    dialect
  );

  const entry = createMigrationEntry(idx, migrationName, content, {
    mode,
    rollback,
  });

  // Re-format content with the actual entry (which has checksum)
  const finalContent = formatMigrationContent(entry, sql, dialect);

  const downContent =
    rollback.kind === "irreversible"
      ? formatIrreversibleDownContent(migrationName, rollback.reason)
      : formatDownMigrationContent(migrationName, downSql, downWarnings);

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

  const kindLabel = manualArtifact ? "manual migration" : "migration";
  return {
    entry,
    sql,
    content: finalContent,
    operations: finalOperations,
    downSql,
    downWarnings,
    mode,
    rollback,
    written: !dryRun,
    message: dryRun
      ? `Would generate ${kindLabel}: ${formatMigrationFilename(entry)}`
      : `Generated ${kindLabel}: ${formatMigrationFilename(entry)}`,
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
// This barrel deliberately re-exports NO snapshot reader. It once carried an
// fs-backed twin of the storage driver's snapshot API — its own `existsSync`
// and its own unvalidated `JSON.parse` — with no caller left in `src/`, exactly
// the second-reader shape §3.2 removed for journals. There is one snapshot
// funnel: `MigrationStorageDriver.readSnapshot()`, reached through the estate
// gate (`MigrationContext.readEstateBaseline`).
