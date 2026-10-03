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
      issues.push(fk001(modelName, relationName, foreignField));
      continue;
    }
    if (isDecimalList(local)) {
      legal = false;
      issues.push(fk010(modelName, relationName, foreignField));
      continue;
    }
    if (local["~"].state.type === "point") {
      // Only the local member belongs here. A referenced GeoPoint cannot be an
      // addressable key, which is already owned by I005 and FK005.
      legal = false;
      issues.push(fk011(modelName, relationName, foreignField));
    }
    if (local["~"].state.nullable) nullableForeignFields.push(foreignField);
    const referencedField = references[position]!;
    const remote = targetScalars[referencedField];
    if (!remote) {
      legal = false;
      issues.push(fk002(modelName, relationName, targetName, referencedField));
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
      issues.push(
        fk003({
          modelName,
          relationName,
          targetName,
          foreignField,
          referencedField,
          localState,
          remoteState,
          localDateTimeForm,
          remoteDateTimeForm,
          arrayShapeMismatch,
          decimalDomainMismatch,
          dateTimeDomainMismatch,
        })
      );
    }
  }

  const targetKey = findReferenceableKey(target, references);
  if (!targetKey) {
    legal = false;
    issues.push(fk005(modelName, relationName, targetName, references));
  }

  if (onDelete === "setNull" || onUpdate === "setNull") {
    for (const foreignField of fields) {
      const local = localScalars[foreignField];
      if (local && !local["~"].state.nullable) {
        legal = false;
        issues.push(ra004(modelName, relationName, foreignField));
      }
    }
  }

  if (onDelete === "cascade" && nullableForeignFields.length === 0) {
    issues.push(ra003(modelName, relationName));
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

// The issues below are built only for an invalid declaration; keeping them out
// of `checkStoredReference` means a valid schema never compiles them.

type Issue = SchemaValidationIssue;
type ScalarState = Model<any>["~"]["state"]["scalars"][string]["~"]["state"];

function fk001(model: string, relation: string, field: string): Issue {
  return {
    code: "FK001",
    message: `FK '${field}' in '${relation}' not in '${model}'`,
    severity: "error",
    model,
    relation,
    field,
    repair: `Declare a scalar '${field}' on '${model}' or name an existing one in .fields(...)`,
  };
}

function fk010(model: string, relation: string, field: string): Issue {
  return {
    code: "FK010",
    message: `FK '${field}' in '${relation}' is a fixed-decimal list, which cannot be a foreign-key member`,
    severity: "error",
    model,
    relation,
    field,
    repair: `Store the reference in a scalar decimal (or another scalar type) on '${model}'`,
  };
}

function fk011(model: string, relation: string, field: string): Issue {
  return {
    code: "FK011",
    message: `FK '${field}' in '${relation}' is a GeoPoint, which cannot be a foreign-key member`,
    severity: "error",
    model,
    relation,
    field,
    repair: `Store relation identity in a portable scalar key on '${model}'`,
  };
}

function fk002(
  model: string,
  relation: string,
  targetName: string,
  field: string
): Issue {
  return {
    code: "FK002",
    message: `Reference '${field}' not in '${targetName}'`,
    severity: "error",
    model,
    relation,
    field,
    repair: `Reference a scalar declared on '${targetName}'`,
  };
}

function describeMember(
  state: ScalarState,
  dateTimeForm: string | undefined
): string {
  if (state.array === true) return `${state.type}[]`;
  if (state.type === "decimal" && state.decimal)
    return `decimal(${state.decimal.precision},${state.decimal.scale})`;
  return dateTimeForm ? `datetime(${dateTimeForm})` : state.type;
}

function fk003(mismatch: {
  modelName: string;
  relationName: string;
  targetName: string;
  foreignField: string;
  referencedField: string;
  localState: ScalarState;
  remoteState: ScalarState;
  localDateTimeForm: string | undefined;
  remoteDateTimeForm: string | undefined;
  arrayShapeMismatch: boolean;
  decimalDomainMismatch: boolean;
  dateTimeDomainMismatch: boolean;
}): Issue {
  const { foreignField, referencedField, targetName } = mismatch;
  const local = describeMember(mismatch.localState, mismatch.localDateTimeForm);
  const remote = describeMember(
    mismatch.remoteState,
    mismatch.remoteDateTimeForm
  );
  const same = mismatch.decimalDomainMismatch
    ? "decimal precision and scale"
    : mismatch.arrayShapeMismatch
      ? "scalar/list shape"
      : mismatch.dateTimeDomainMismatch
        ? "SQLite DateTime physical form"
        : "scalar type";
  return {
    code: "FK003",
    message: `Type mismatch: '${foreignField}' (${local}) → '${referencedField}' (${remote}) in ${targetName}`,
    severity: "error",
    model: mismatch.modelName,
    relation: mismatch.relationName,
    repair: `Give '${foreignField}' the same ${same} as '${targetName}.${referencedField}'`,
  };
}

function fk005(
  model: string,
  relation: string,
  targetName: string,
  references: readonly string[]
): Issue {
  return {
    code: "FK005",
    message: `[${references.join(", ")}] in '${targetName}' should be unique/ID`,
    severity: "error",
    model,
    relation,
    repair: `Declare the referenced tuple on '${targetName}' with .id(), .unique(), or a compound key`,
  };
}

function ra004(model: string, relation: string, field: string): Issue {
  return {
    code: "RA004",
    message: `SET NULL on '${relation}' but '${field}' not nullable`,
    severity: "error",
    model,
    relation,
    repair: `Make '${field}' .nullable() or choose another referential action`,
  };
}

function ra003(model: string, relation: string): Issue {
  return {
    code: "RA003",
    message: `CASCADE on required '${relation}' may cause data loss`,
    severity: "warning",
    model,
    relation,
  };
}
