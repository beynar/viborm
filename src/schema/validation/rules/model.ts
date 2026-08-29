// Model & Scalar Validation Rules

import { validateSchema } from "../../../validation/primitives/helpers";
import { isValidSchemaIdentifier } from "../../identifier";
import type { Model, ModelState } from "../../model";
import type { Schema, SchemaValidationIssue } from "../types";
import { getScalars } from "./model-members";

function validateFieldNames(
  modelName: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const fieldName of Object.keys(model["~"].state.shape)) {
    if (isValidSchemaIdentifier(fieldName)) continue;
    errors.push({
      code: "F001",
      message: `Field '${fieldName}' in '${modelName}' is invalid identifier`,
      severity: "error",
      model: modelName,
      field: fieldName,
    });
  }
  return errors;
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

// =============================================================================
// MODEL RULES (M001-M006)
// =============================================================================

/** M002: Model must have at least one scalar field */
export function modelHasFields(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
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

/** M005: Model name must be valid identifier */
export function modelNameValid(
  _s: Schema,
  name: string,
  _m: Model<any>
): SchemaValidationIssue[] {
  if (!isValidSchemaIdentifier(name)) {
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

/** M007: Mapped table name (.map()) must be a valid identifier */
export function modelMappedNameValid(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const tableName = model["~"].state.tableName;
  if (tableName !== undefined && !isValidSchemaIdentifier(tableName)) {
    return [
      {
        code: "M007",
        message: `Mapped table name '${String(tableName)}' on '${name}' is not a valid identifier`,
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
): SchemaValidationIssue[] {
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
export function getCompoundIdFields(model: Model<any>): string[] {
  const compoundId = model["~"].state.compoundId;
  if (!compoundId) return [];
  const constraints: NonNullable<ModelState["compoundId"]> = compoundId;
  return Object.keys(Object.values(constraints)[0]!.entries);
}

/** Helper: Get compound unique constraints from state */
export function getCompoundUniques(
  model: Model<any>
): Array<{ name: string; fields: string[] }> {
  const compoundUniques: ModelState["compoundUniques"] =
    model["~"].state.compoundUniques;
  if (!compoundUniques) return [];
  return Object.entries(compoundUniques).map(([name, schema]) => ({
    name,
    fields: Object.keys(schema.entries),
  }));
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
): SchemaValidationIssue[] {
  const errors = validateFieldNames(name, model);

  // Accumulators for cross-scalar checks
  let idCount = 0;
  const columnToFields = new Map<string, string[]>();

  for (const [fname, scalar] of getScalars(model)) {
    const st = scalar["~"].state;

    // F009: Mapped column name (.map()) valid
    if (
      st.columnName !== undefined &&
      !isValidSchemaIdentifier(st.columnName)
    ) {
      errors.push({
        code: "F009",
        message: `Mapped column name '${String(st.columnName)}' for '${fname}' in '${name}' is not a valid identifier`,
        severity: "error",
        model: name,
        field: fname,
      });
    }

    // F002: Count ID scalars
    if (st.isId) idCount++;

    // F003: Track column names
    const col = st.columnName ?? fname;
    if (!columnToFields.has(col)) columnToFields.set(col, []);
    columnToFields.get(col)!.push(fname);

    // F004: Default type match. A decimal literal crossed its complete field
    // codec when `.default()` retained it, so this downstream boundary trusts
    // that canonical output instead of applying a custom schema twice.
    if (
      st.hasDefault &&
      st.default !== undefined &&
      typeof st.default !== "function" &&
      st.type !== "decimal"
    ) {
      const result = validateSchema(scalar["~"].state.base, st.default);
      if (result.issues) {
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
  const compoundIdCount = Object.keys(model["~"].state.compoundId ?? {}).length;
  const hasCompoundId = compoundIdCount > 0;

  // M001: No ID field (allow if compound ID exists)
  if (idCount === 0 && !hasCompoundId) {
    errors.push({
      code: "M001",
      message: `'${name}' must have an ID field (or use .id() for compound key)`,
      severity: "error",
      model: name,
    });
  }

  // F002: Multiple single-field IDs, single + compound, or multiple .id() calls
  if (idCount > 1 || (idCount > 0 && hasCompoundId) || compoundIdCount > 1) {
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
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
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
): SchemaValidationIssue[] {
  const names = new Map<string, number>();
  for (const idx of model["~"].state.indexes) {
    if (idx.options.name) {
      names.set(idx.options.name, (names.get(idx.options.name) ?? 0) + 1);
    }
  }
  const errors: SchemaValidationIssue[] = [];
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

/** I003: Compound unique/id constraints must contain at least one field. */
export function compoundConstraintsNonEmpty(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];

  const compoundIdFields = getCompoundIdFields(model);
  if (model["~"].state.compoundId && compoundIdFields.length === 0) {
    errors.push({
      code: "I003",
      message: `Compound ID in '${name}' must contain at least one field`,
      severity: "error",
      model: name,
    });
  }
  const compoundUniques = getCompoundUniques(model);
  for (const constraint of compoundUniques) {
    if (constraint.fields.length === 0) {
      errors.push({
        code: "I003",
        message: `Compound unique '${constraint.name}' in '${name}' must contain at least one field`,
        severity: "error",
        model: name,
      });
    }
  }

  return errors;
}

/**
 * I004: a fixed-decimal LIST is not a member of a key or an index (plan 2.1).
 *
 * The MODEL-level half of the exclusion. `.id()` and `.unique()` are refused on
 * the declaration itself, where the chain writes them, but a compound key, a
 * compound unique and an index name their members by string from the model, so
 * the declaration never sees them and this is the only place they exist.
 *
 * Why a decimal list in particular: on two of three providers the column holds
 * ONE JSON container, so an index or a key over it addresses a document by its
 * spelling rather than by its members — and `["1.2"]` and `["1.20"]` are the
 * same list. Other array scalars are not refused: PostgreSQL indexes native
 * arrays meaningfully, and this program speaks only for the fixed decimal.
 */
export function decimalListsAreNotKeyMembers(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const scalars = model["~"].state.scalars;
  const isDecimalList = (field: string): boolean => {
    const state = scalars[field]?.["~"].state;
    return state?.type === "decimal" && state.array === true;
  };

  const positions: Array<{ field: string; position: string }> = [];
  for (const index of model["~"].state.indexes) {
    for (const field of index.fields) {
      positions.push({ field, position: "an index" });
    }
  }
  for (const field of getCompoundIdFields(model)) {
    positions.push({ field, position: "a compound ID" });
  }
  for (const constraint of getCompoundUniques(model)) {
    for (const field of constraint.fields) {
      positions.push({ field, position: `unique '${constraint.name}'` });
    }
  }

  const errors: SchemaValidationIssue[] = [];
  for (const { field, position } of positions) {
    if (!isDecimalList(field)) continue;
    errors.push({
      code: "I004",
      message: `'${field}' in '${name}' is a fixed-decimal list, which cannot be a member of ${position}`,
      severity: "error",
      model: name,
      field,
    });
  }
  return errors;
}

/**
 * I005: GeoPoint has one portable physical index role and no key role.
 *
 * The scalar class has no `.id()`/`.unique()` methods and the typed model
 * surface excludes compound keys and ordinary indexes. This definition gate
 * owns hostile JavaScript and decoded schema values that bypass those types.
 */
export function geoPointRolesArePortable(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const state = model["~"].state;
  const isPoint = (field: string): boolean =>
    state.scalars[field]?.["~"].state.type === "point";
  const issues: SchemaValidationIssue[] = [];

  for (const [field, scalar] of getScalars(model)) {
    const scalarState = scalar["~"].state;
    if (
      scalarState.type === "point" &&
      (scalarState.isId || scalarState.isUnique)
    ) {
      issues.push({
        code: "I005",
        message: `GeoPoint '${field}' in '${name}' cannot be an ID or unique field`,
        severity: "error",
        model: name,
        field,
      });
    }
  }

  for (const field of getCompoundIdFields(model)) {
    if (!isPoint(field)) continue;
    issues.push({
      code: "I005",
      message: `GeoPoint '${field}' in '${name}' cannot be a compound ID member`,
      severity: "error",
      model: name,
      field,
    });
  }
  for (const constraint of getCompoundUniques(model)) {
    for (const field of constraint.fields) {
      if (!isPoint(field)) continue;
      issues.push({
        code: "I005",
        message: `GeoPoint '${field}' in '${name}' cannot be a member of unique '${constraint.name}'`,
        severity: "error",
        model: name,
        field,
      });
    }
  }

  for (const index of state.indexes) {
    const pointFields = index.fields.filter(isPoint);
    const point =
      pointFields.length === 1
        ? state.scalars[pointFields[0]!]?.["~"].state
        : undefined;
    const valid =
      index.fields.length === 1 &&
      pointFields.length === 1 &&
      point?.nullable === false &&
      index.options.type === "spatial" &&
      index.options.unique === undefined &&
      index.options.where === undefined;
    if (valid) continue;
    if (pointFields.length === 0 && index.options.type !== "spatial") continue;
    const field = pointFields[0] ?? index.fields[0];
    issues.push({
      code: "I005",
      message: `A spatial index in '${name}' must contain exactly one non-null GeoPoint and cannot be unique or partial`,
      severity: "error",
      model: name,
      ...(field ? { field } : {}),
    });
  }

  return issues;
}

export const modelRules = [
  // Model-level checks (don't iterate fields)
  modelHasFields,
  modelNameValid,
  modelNameNotReserved,
  modelMappedNameValid,
  // Single-pass field validation (M001, F001-F008)
  validateFieldsSinglePass,
  // Index checks (iterate indexes, not fields)
  indexFieldsExist,
  indexNameUnique,
  // Compound key checks
  compoundConstraintsNonEmpty,
  decimalListsAreNotKeyMembers,
  geoPointRolesArePortable,
];
