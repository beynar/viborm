// Model & Field Validation Rules

import type { Field } from "../../fields/base";
import type { Model } from "../../model";
import type { Schema, ValidationError } from "../types";

/** Helper to get typed scalar field entries */
function getScalars(model: Model<any>): [string, Field][] {
  return Object.entries(model["~"].state.scalars) as [string, Field][];
}

const RESERVED = new Set([
  "model",
  "field",
  "relation",
  "index",
  "unique",
  "table",
  "column",
  "key",
  "primary",
  "foreign",
  "constraint",
  "default",
  "null",
  "not",
  "and",
  "or",
  "select",
  "from",
  "where",
  "order",
  "group",
  "by",
  "having",
  "limit",
  "offset",
  "join",
  "inner",
  "left",
  "right",
  "outer",
  "on",
  "as",
  "distinct",
  "all",
  "any",
  "exists",
  "in",
  "between",
  "like",
  "is",
  "true",
  "false",
  "insert",
  "update",
  "delete",
  "create",
  "drop",
  "alter",
  "truncate",
]);

const VALID_ID = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// =============================================================================
// MODEL RULES (M001-M006)
// =============================================================================

/** M002: Model must have at least one scalar field */
export function modelHasFields(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  if (Object.keys(model["~"].state.scalars).length === 0) {
    return [
      {
        code: "M002",
        message: `'${name}' must have at least one field`,
        severity: "error",
        model: name,
      },
    ];
  }
  return [];
}

/** M003: Model names must be unique (checked at schema level) */
export function modelUniqueName(
  schema: Schema,
  name: string,
  _model: Model<any>
): ValidationError[] {
  let count = 0;
  for (const n of schema.keys()) {
    if (n === name) count++;
  }
  if (count > 1) {
    return [
      {
        code: "M003",
        message: `Model name '${name}' is duplicated`,
        severity: "error",
        model: name,
      },
    ];
  }
  return [];
}

/** M005: Model name must be valid identifier */
export function modelNameValid(
  _s: Schema,
  name: string,
  _m: Model<any>
): ValidationError[] {
  if (!VALID_ID.test(name)) {
    return [
      {
        code: "M005",
        message: `'${name}' is not a valid identifier`,
        severity: "error",
        model: name,
      },
    ];
  }
  return [];
}

/** M006: Model name cannot be reserved */
export function modelNameNotReserved(
  _s: Schema,
  name: string,
  _m: Model<any>
): ValidationError[] {
  if (RESERVED.has(name.toLowerCase())) {
    return [
      {
        code: "M006",
        message: `'${name}' is a reserved word`,
        severity: "error",
        model: name,
      },
    ];
  }
  return [];
}

// =============================================================================
// FIELD RULES (F001-F008) - SINGLE PASS
// =============================================================================

/** Helper: Get compound ID field names from state */
function getCompoundIdFields(model: Model<any>): string[] {
  const compoundId = model["~"].state.compoundId;
  if (!compoundId) return [];
  // compoundId is Record<string, ObjectSchema> - extract field names from first entry
  const firstKey = Object.keys(compoundId)[0];
  if (!firstKey) return [];
  const schema = compoundId[firstKey];
  const entries = (schema as any)["~"]?.state?.entries;
  return entries ? Object.keys(entries) : [];
}

/** Helper: Get compound unique constraints from state */
function getCompoundUniques(
  model: Model<any>
): Array<{ name: string; fields: string[] }> {
  const compoundUniques = model["~"].state.compoundUniques;
  if (!compoundUniques) return [];
  return Object.entries(compoundUniques).map(([name, schema]) => {
    const entries = (schema as any)["~"]?.state?.entries;
    return { name, fields: entries ? Object.keys(entries) : [] };
  });
}

/**
 * Single-pass field validation
 * Combines: F001, F002, F003, F004, F006, F007, F008
 * Iterates scalars once instead of 7 separate passes
 */
export function validateFieldsSinglePass(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Accumulators for cross-field checks
  let idCount = 0;
  const columnToFields = new Map<string, string[]>();

  for (const [fname, field] of getScalars(model)) {
    const st = field["~"].state;

    // F001: Field name valid
    if (!VALID_ID.test(fname)) {
      errors.push({
        code: "F001",
        message: `Field '${fname}' in '${name}' is invalid identifier`,
        severity: "error",
        model: name,
        field: fname,
      });
    }

    // F002: Count ID fields
    if (st.isId) idCount++;

    // F003: Track column names
    const col = st.columnName ?? fname;
    if (!columnToFields.has(col)) columnToFields.set(col, []);
    columnToFields.get(col)!.push(fname);

    // F004: Default type match
    if (
      st.hasDefault &&
      st.defaultValue !== undefined &&
      typeof st.defaultValue !== "function"
    ) {
      const schema = field["~"].schemas.base;
      const result = schema(st.defaultValue);
      if (result instanceof Error || (result as any)?.problems) {
        errors.push({
          code: "F004",
          message: `Default value for '${fname}' in '${name}' doesn't match type`,
          severity: "error",
          model: name,
          field: fname,
        });
      }
    }

    // F006: ID not nullable
    if (st.isId && st.nullable) {
      errors.push({
        code: "F006",
        message: `ID '${fname}' in '${name}' cannot be nullable`,
        severity: "error",
        model: name,
        field: fname,
      });
    }

    // F007: ID not array
    if (st.isId && st.array) {
      errors.push({
        code: "F007",
        message: `ID '${fname}' in '${name}' cannot be array`,
        severity: "error",
        model: name,
        field: fname,
      });
    }

    // F008: Auto only on ID
    if (st.autoGenerate && !st.isId) {
      errors.push({
        code: "F008",
        message: `Auto-generate on '${fname}' in '${name}' requires .id()`,
        severity: "warning",
        model: name,
        field: fname,
      });
    }
  }

  // Check for compound ID
  const compoundIdFields = getCompoundIdFields(model);
  const hasCompoundId = compoundIdFields.length > 0;

  // M001: No ID field (allow if compound ID exists)
  if (idCount === 0 && !hasCompoundId) {
    errors.push({
      code: "M001",
      message: `'${name}' must have an ID field (or use .id() for compound key)`,
      severity: "error",
      model: name,
    });
  }

  // F002: Multiple single-field IDs (not allowed if compound ID exists either)
  if (idCount > 1 || (idCount > 0 && hasCompoundId)) {
    errors.push({
      code: "F002",
      message: `'${name}' has conflicting ID definitions (use either single field .id() or model .id())`,
      severity: "error",
      model: name,
    });
  }

  // F003: Duplicate columns
  for (const [col, fields] of columnToFields) {
    if (fields.length > 1) {
      errors.push({
        code: "F003",
        message: `Column '${col}' used by multiple fields in '${name}': ${fields.join(
          ", "
        )}`,
        severity: "error",
        model: name,
      });
    }
  }

  return errors;
}

// =============================================================================
// INDEX RULES (I001-I005)
// =============================================================================

/** I001: Index fields must exist */
export function indexFieldsExist(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fields = new Set(Object.keys(model["~"].state.scalars));
  for (const idx of model["~"].state.indexes) {
    for (const f of idx.fields) {
      if (!fields.has(f)) {
        errors.push({
          code: "I001",
          message: `Index field '${f}' not in '${name}'`,
          severity: "error",
          model: name,
          field: f,
        });
      }
    }
  }
  return errors;
}

/** I002: Index names must be unique */
export function indexNameUnique(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const names = new Map<string, number>();
  for (const idx of model["~"].state.indexes) {
    if (idx.options.name) {
      names.set(idx.options.name, (names.get(idx.options.name) ?? 0) + 1);
    }
  }
  const errors: ValidationError[] = [];
  for (const [iname, count] of names) {
    if (count > 1) {
      errors.push({
        code: "I002",
        message: `Index name '${iname}' duplicated in '${name}'`,
        severity: "error",
        model: name,
      });
    }
  }
  return errors;
}

/** I003: Compound unique/id fields must exist */
export function compoundFieldsExist(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fields = new Set(Object.keys(model["~"].state.scalars));

  // Check compound ID fields
  const compoundIdFields = getCompoundIdFields(model);
  for (const f of compoundIdFields) {
    if (!fields.has(f)) {
      errors.push({
        code: "I003",
        message: `Compound ID field '${f}' not in '${name}'`,
        severity: "error",
        model: name,
        field: f,
      });
    }
  }

  // Check compound unique fields
  const compoundUniques = getCompoundUniques(model);
  for (const constraint of compoundUniques) {
    for (const f of constraint.fields) {
      if (!fields.has(f)) {
        errors.push({
          code: "I003",
          message: `Compound unique field '${f}' not in '${name}'`,
          severity: "error",
          model: name,
          field: f,
        });
      }
    }
  }

  return errors;
}

export const modelRules = [
  // Model-level checks (don't iterate fields)
  modelHasFields,
  modelUniqueName,
  modelNameValid,
  modelNameNotReserved,
  // Single-pass field validation (M001, F001-F008)
  validateFieldsSinglePass,
  // Index checks (iterate indexes, not fields)
  indexFieldsExist,
  indexNameUnique,
  // Compound key checks
  compoundFieldsExist,
];
