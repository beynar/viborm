// The stored-reference subowner.
//
// It proves that a declared `.fields(...).references(...)` pair is physically
// legal — every member exists, aligns by position with its counterpart, matches
// scalar types, and references a key the target can be addressed by — and
// returns the one `ResolvedStoredReference` the trusted edge carries. The
// mandatory relation-definition gate is its only caller; no consumer repeats
// these checks and none receives the untrusted declaration.
//
// Arity is not checked here: `.references(...)` accepts only an equal-arity
// tuple, so an unequal pair cannot be constructed.

import { sameDecimalDescriptor } from "@validation/primitives/decimal-codec";
import { findReferenceableKey, type Model } from "../../model";
import type { ForeignKeyDeclaration } from "../../relation";
import { sqliteDateTimePhysicalForm } from "../../scalars/datetime/physical";
import type { ResolvedStoredReference } from "../relation-resolution";
import type { SchemaValidationIssue } from "../types";

export interface StoredReferenceInput {
  readonly modelName: string;
  readonly model: Model<any>;
  readonly relationName: string;
  readonly targetName: string;
  readonly target: Model<any>;
  readonly foreignKey: ForeignKeyDeclaration;
}

export interface StoredReferenceCheck {
  /** Present only when every structural fact above held. */
  readonly reference: ResolvedStoredReference | undefined;
  readonly issues: readonly SchemaValidationIssue[];
  /** Ordered local members whose scalar accepts NULL. */
  readonly nullableForeignFields: readonly string[];
}

export function checkStoredReference(
  input: StoredReferenceInput
): StoredReferenceCheck {
  const { modelName, model, relationName, targetName, target } = input;
  const { fields, references, onDelete, onUpdate } = input.foreignKey;
  const issues: SchemaValidationIssue[] = [];
  const localScalars = model["~"].state.scalars;
  const targetScalars = target["~"].state.scalars;
  const nullableForeignFields: string[] = [];
  let legal = true;

  for (const [position, foreignField] of fields.entries()) {
    const local = localScalars[foreignField];
    if (!local) {
      legal = false;
      issues.push({
        code: "FK001",
        message: `FK '${foreignField}' in '${relationName}' not in '${modelName}'`,
        severity: "error",
        model: modelName,
        relation: relationName,
        field: foreignField,
        repair: `Declare a scalar '${foreignField}' on '${modelName}' or name an existing one in .fields(...)`,
      });
      continue;
    }
    if (isDecimalList(local)) {
      legal = false;
      issues.push({
        code: "FK010",
        message: `FK '${foreignField}' in '${relationName}' is a fixed-decimal list, which cannot be a foreign-key member`,
        severity: "error",
        model: modelName,
        relation: relationName,
        field: foreignField,
        repair: `Store the reference in a scalar decimal (or another scalar type) on '${modelName}'`,
      });
      continue;
    }
    if (local["~"].state.type === "point") {
      // Only the local member belongs here. A referenced GeoPoint cannot be an
      // addressable key, which is already owned by I005 and FK005.
      legal = false;
      issues.push({
        code: "FK011",
        message: `FK '${foreignField}' in '${relationName}' is a GeoPoint, which cannot be a foreign-key member`,
        severity: "error",
        model: modelName,
        relation: relationName,
        field: foreignField,
        repair: `Store relation identity in a portable scalar key on '${modelName}'`,
      });
    }
    if (local["~"].state.nullable) nullableForeignFields.push(foreignField);
    const referencedField = references[position]!;
    const remote = targetScalars[referencedField];
    if (!remote) {
      legal = false;
      issues.push({
        code: "FK002",
        message: `Reference '${referencedField}' not in '${targetName}'`,
        severity: "error",
        model: modelName,
        relation: relationName,
        field: referencedField,
        repair: `Reference a scalar declared on '${targetName}'`,
      });
      continue;
    }
    const localState = local["~"].state;
    const remoteState = remote["~"].state;
    const localType = localState.type;
    const remoteType = remoteState.type;
    const localIsArray = localState.array === true;
    const remoteIsArray = remoteState.array === true;
    const localDecimal = localState.decimal;
    const remoteDecimal = remoteState.decimal;
    const arrayShapeMismatch =
      localType === remoteType && localIsArray !== remoteIsArray;
    const decimalDomainMismatch =
      localType === "decimal" &&
      remoteType === "decimal" &&
      !sameDecimalDescriptor(localDecimal, remoteDecimal);
    const localDateTimeForm =
      localType === "datetime" && !localIsArray
        ? sqliteDateTimePhysicalForm(local["~"].nativeType)
        : undefined;
    const remoteDateTimeForm =
      remoteType === "datetime" && !remoteIsArray
        ? sqliteDateTimePhysicalForm(remote["~"].nativeType)
        : undefined;
    const dateTimeDomainMismatch =
      localDateTimeForm !== undefined &&
      remoteDateTimeForm !== undefined &&
      localDateTimeForm !== remoteDateTimeForm;
    if (
      localType !== remoteType ||
      arrayShapeMismatch ||
      decimalDomainMismatch ||
      dateTimeDomainMismatch
    ) {
      legal = false;
      const localDescription = localIsArray
        ? `${localType}[]`
        : localType === "decimal" && localDecimal
          ? `decimal(${localDecimal.precision},${localDecimal.scale})`
          : localDateTimeForm
            ? `datetime(${localDateTimeForm})`
            : localType;
      const remoteDescription = remoteIsArray
        ? `${remoteType}[]`
        : remoteType === "decimal" && remoteDecimal
          ? `decimal(${remoteDecimal.precision},${remoteDecimal.scale})`
          : remoteDateTimeForm
            ? `datetime(${remoteDateTimeForm})`
            : remoteType;
      issues.push({
        code: "FK003",
        message: `Type mismatch: '${foreignField}' (${localDescription}) → '${referencedField}' (${remoteDescription}) in ${targetName}`,
        severity: "error",
        model: modelName,
        relation: relationName,
        repair: decimalDomainMismatch
          ? `Give '${foreignField}' the same decimal precision and scale as '${targetName}.${referencedField}'`
          : arrayShapeMismatch
            ? `Give '${foreignField}' the same scalar/list shape as '${targetName}.${referencedField}'`
            : dateTimeDomainMismatch
              ? `Give '${foreignField}' the same SQLite DateTime physical form as '${targetName}.${referencedField}'`
              : `Give '${foreignField}' the same scalar type as '${targetName}.${referencedField}'`,
      });
    }
  }

  const targetKey = findReferenceableKey(target, references);
  if (!targetKey) {
    legal = false;
    issues.push({
      code: "FK005",
      message: `[${references.join(", ")}] in '${targetName}' should be unique/ID`,
      severity: "error",
      model: modelName,
      relation: relationName,
      repair: `Declare the referenced tuple on '${targetName}' with .id(), .unique(), or a compound key`,
    });
  }

  if (onDelete === "setNull" || onUpdate === "setNull") {
    for (const foreignField of fields) {
      const local = localScalars[foreignField];
      if (local && !local["~"].state.nullable) {
        legal = false;
        issues.push({
          code: "RA004",
          message: `SET NULL on '${relationName}' but '${foreignField}' not nullable`,
          severity: "error",
          model: modelName,
          relation: relationName,
          repair: `Make '${foreignField}' .nullable() or choose another referential action`,
        });
      }
    }
  }

  if (onDelete === "cascade" && nullableForeignFields.length === 0) {
    issues.push({
      code: "RA003",
      message: `CASCADE on required '${relationName}' may cause data loss`,
      severity: "warning",
      model: modelName,
      relation: relationName,
    });
  }

  // Published in the MATCHED KEY's order, not the declaration's. Each pair
  // travels whole, so the pairing the author wrote is untouched and both DDL
  // sides permute together. `static-membership.ts` reads the DECLARATION, so
  // its compile-time foreign-key tuple can be ordered differently; every shape
  // either side publishes is name-keyed, so the two orders never meet.
  const members = fields.map((foreignField, position) => ({
    foreignField,
    referencedField: references[position]!,
  }));
  if (targetKey) {
    members.sort(
      (left, right) =>
        targetKey.indexOf(left.referencedField) -
        targetKey.indexOf(right.referencedField)
    );
  }
  const [head, ...rest] = members;
  return {
    reference:
      legal && head
        ? {
            members: [head, ...rest],
            ...(onDelete ? { onDelete } : {}),
            ...(onUpdate ? { onUpdate } : {}),
          }
        : undefined,
    issues,
    nullableForeignFields,
  };
}

/**
 * A fixed-decimal LIST, which plan 2.1 excludes from every key position.
 *
 * Only the LOCAL member is asked here, and that is the whole exclusion for a
 * stored reference: the REFERENCED tuple has to be a key the target can be
 * addressed by (FK005), and a decimal list can be no part of one — the scalar
 * builder refuses `.id()` and `.unique()` on it and I004 refuses it inside a
 * compound key or a unique index. So the referenced side is already closed, by
 * the owners of the positions it would have to occupy.
 */
function isDecimalList(
  scalar: Model<any>["~"]["state"]["scalars"][string]
): boolean {
  const state = scalar["~"].state;
  return state.type === "decimal" && state.array === true;
}
