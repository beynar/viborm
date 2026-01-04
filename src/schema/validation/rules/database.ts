// Database-Specific & Value Validation Rules

import type { Field } from "../../fields/base";
import type { Model } from "../../model";
import type { Schema, ValidationError } from "../types";

/** Helper to get typed scalar field entries */
function getScalars(model: Model<any>): [string, Field][] {
  return Object.entries(model["~"].state.scalars) as [string, Field][];
}

export type DatabaseType = "mysql" | "postgres" | "sqlite";

// =============================================================================
// DATABASE-SPECIFIC RULES (DB001-DB003)
// =============================================================================

/**
 * DB001: MySQL doesn't support native array column types
 *
 * Workaround: Array fields on MySQL will be stored as JSON columns.
 * The ORM will automatically serialize/deserialize arrays to JSON.
 *
 * Example:
 *   tags: s.string().array()  →  JSON column with ["a", "b", "c"]
 *
 * Trade-offs:
 * - No native array operators (use JSON_CONTAINS, JSON_EXTRACT)
 * - Slightly larger storage overhead
 * - Index support via JSON virtual columns
 */
export function mysqlNoArrayFields(
  _s: Schema,
  name: string,
  model: Model<any>,
  db?: DatabaseType
): ValidationError[] {
  if (db !== "mysql") return [];
  const errors: ValidationError[] = [];
  for (const [fname, field] of getScalars(model)) {
    if (field["~"].state.array) {
      errors.push({
        code: "DB001",
        message: `MySQL: '${fname}' in '${name}' will use JSON (no native arrays)`,
        severity: "warning",
        model: name,
        field: fname,
      });
    }
  }
  return errors;
}

/**
 * DB002: SQLite doesn't support native ENUM type
 *
 * Workaround: Enum fields on SQLite will use TEXT with CHECK constraint.
 * The ORM will generate: CHECK(column IN ('value1', 'value2', ...))
 *
 * Example:
 *   status: s.enum("draft", "published")
 *   →  TEXT CHECK(status IN ('draft', 'published'))
 *
 * Trade-offs:
 * - Validation happens at DB level (same as native ENUM)
 * - Slightly more verbose DDL
 * - Full type safety preserved at ORM level
 */
export function sqliteNoEnum(
  _s: Schema,
  name: string,
  model: Model<any>,
  db?: DatabaseType
): ValidationError[] {
  if (db !== "sqlite") return [];
  const errors: ValidationError[] = [];
  for (const [fname, field] of getScalars(model)) {
    if (field["~"].state.type === "enum") {
      errors.push({
        code: "DB002",
        message: `SQLite: '${fname}' in '${name}' will use CHECK constraint (no native ENUM)`,
        severity: "warning",
        model: name,
        field: fname,
      });
    }
  }
  return errors;
}

// =============================================================================
// VALUE VALIDATION RULES (V001-V003)
// =============================================================================

/** V001: Enum values must be valid identifiers */
export function enumValueValid(
  _s: Schema,
  _name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [_fname, field] of getScalars(model)) {
    const st = field["~"].state;
    if (st.type !== "enum") continue;
    // Note: enum values would need to be extracted from field definition
    // This is a placeholder for when enum field exposes values
  }
  return errors;
}

// =============================================================================
// FACTORY FOR DB-SPECIFIC RULES
// =============================================================================

export function createDatabaseRules(db: DatabaseType) {
  return [
    (s: Schema, n: string, m: Model<any>) => mysqlNoArrayFields(s, n, m, db),
    (s: Schema, n: string, m: Model<any>) => sqliteNoEnum(s, n, m, db),
  ];
}

export const databaseRules = [enumValueValid];
