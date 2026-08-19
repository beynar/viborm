/**
 * Manual Migration Artifact
 *
 * Parses and validates `GenerateOptions.manualMigration` — the caller-owned
 * artifact that puts a whole migration in manual mode.
 *
 * Every refusal in the manual-artifact family lives here, and every one of them
 * validates the BYTES that will be written, not the supplied array: the arrays
 * are joined with `addStatementBreakpoints` and read back with
 * `parseStatements`, the same pair `apply()` and `down()` use. A
 * whitespace- or comment-only artifact therefore parses to `[]` and is empty,
 * which is the plan's definition of empty and the only one in the codebase.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import type { Dialect, GenerateOptions, MigrationRollback } from "../types";
import { addStatementBreakpoints, parseStatements } from "./file-writer";

type ManualMigrationInput = NonNullable<GenerateOptions["manualMigration"]>;

export interface ManualArtifact {
  /** Parsed up statements, in supplied order. Never empty. */
  readonly sql: string[];
  /** Parsed down statements; empty exactly when the rollback is irreversible. */
  readonly downSql: string[];
  /** The policy persisted on the journal entry (input `sql` stripped). */
  readonly rollback: MigrationRollback;
  /** Explicit migration name, required in manual mode. */
  readonly name: string;
}

function refuseArtifact(description: string): never {
  throw new MigrationError(
    `Manual migration artifact is incomplete: ${description}. GenerateOptions.manualMigration owns the whole migration, so VibORM neither completes it nor falls back to generated SQL.`,
    VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
  );
}

/**
 * Parse the supplied statements exactly as the written artifact will be read
 * back, so "non-empty" means the same thing at generation time and at apply or
 * rollback time.
 */
function parseArtifactStatements(
  statements: readonly string[],
  dialect: Dialect
): string[] {
  return parseStatements(addStatementBreakpoints([...statements], dialect));
}

/**
 * Validate the caller's artifact and project it onto what generation writes.
 *
 * @param manualMigration - The caller-supplied artifact
 * @param name - `GenerateOptions.name`, required in manual mode
 * @param dialect - Dialect used to join statements into artifact content
 */
export function resolveManualArtifact(
  manualMigration: ManualMigrationInput,
  name: string | undefined,
  dialect: Dialect
): ManualArtifact {
  if (!name || name.trim().length === 0) {
    refuseArtifact(
      "no migration name was supplied. A manual migration can carry zero structural operations, so the generated name would be the meaningless `empty` — pass GenerateOptions.name"
    );
  }

  const sql = parseArtifactStatements(manualMigration.up, dialect);
  if (sql.length === 0) {
    refuseArtifact(
      "its `up` artifact parses to no statements (it is empty, whitespace, or comments only), so applying the migration would advance history without executing anything"
    );
  }

  if (manualMigration.rollback.kind === "irreversible") {
    const reason = manualMigration.rollback.reason;
    if (reason.trim().length === 0) {
      refuseArtifact(
        "it declares the migration irreversible but states no reason, and a refusal to roll back has to say why"
      );
    }
    return {
      sql,
      downSql: [],
      rollback: { kind: "irreversible", reason },
      name,
    };
  }

  const downSql = parseArtifactStatements(
    manualMigration.rollback.sql,
    dialect
  );
  if (downSql.length === 0) {
    refuseArtifact(
      'it declares a manual rollback but its rollback `sql` parses to no statements (it is empty, whitespace, or comments only). Declare `{ kind: "irreversible", reason }` instead of shipping an empty down artifact'
    );
  }

  return { sql, downSql, rollback: { kind: "manual" }, name };
}
