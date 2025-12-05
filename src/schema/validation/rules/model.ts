// Model & Field Validation Rules

import type { Model } from "../../model";
import type { ValidationError, Schema } from "../types";

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
  if (model["~"].fieldMap.size === 0) {
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

/**
 * Single-pass field validation
 * Combines: F001, F002, F003, F004, F006, F007, F008
 * Iterates fieldMap once instead of 7 separate passes
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

  for (const [fname, field] of model["~"].fieldMap) {
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
    if (st.hasDefault && st.defaultValue !== undefined) {
      if (typeof st.defaultValue !== "function") {
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

  // M001: No ID field
  if (idCount === 0) {
    errors.push({
      code: "M001",
      message: `'${name}' must have an ID field`,
      severity: "error",
      model: name,
    });
  }

  // F002: Multiple IDs
  if (idCount > 1) {
    errors.push({
      code: "F002",
      message: `'${name}' has ${idCount} ID fields (max 1)`,
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
  const fields = new Set(model["~"].fieldMap.keys());
  for (const idx of model["~"].indexes) {
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
  for (const idx of model["~"].indexes) {
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

/** I003: Unique constraint fields must exist (via .unique() on field) */
export function uniqueFieldsExist(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  // Fields with .unique() are already validated to exist (they're in fieldMap)
  // This rule checks that unique constraints reference valid fields
  // Since we use field-level .unique(), this is always satisfied
  return [];
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
  uniqueFieldsExist,
];
