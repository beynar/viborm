// Foreign Key & Referential Action Validation Rules

import type { Model } from "../../model";
import { getCompatiblePolymorphicInverseBinding } from "../../relation";
import type {
  Schema,
  SchemaValidationIssue,
  ValidationContext,
} from "../types";
import { getCompoundIdFields, getCompoundUniques } from "./model";
import { findModelName, getRelations } from "./model-members";

// =============================================================================
// FK RULES (FK001-FK007)
// =============================================================================

/** FK001: .fields() must reference existing scalar fields */
export function fkFieldExists(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  const fields = new Set(Object.keys(model["~"].state.scalars));
  for (const [rname, rel] of getRelations(model)) {
    const fks = rel["~"].state.fields;
    if (!fks) continue;
    for (const fk of fks) {
      if (!fields.has(fk)) {
        errors.push({
          code: "FK001",
          message: `FK '${fk}' in '${rname}' not in '${name}'`,
          severity: "error",
          model: name,
          relation: rname,
          field: fk,
        });
      }
    }
  }
  return errors;
}

/** FK002: .references() must reference existing fields in target */
export function fkReferenceExists(
  _schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const refs = rel["~"].state.references;
    if (!refs) continue;
    const target = rel["~"].state.getter();
    const targetName = findModelName(ctx, target);
    if (!targetName) continue;
    const targetFields = new Set(Object.keys(target["~"].state.scalars));
    for (const ref of refs) {
      if (!targetFields.has(ref)) {
        errors.push({
          code: "FK002",
          message: `Reference '${ref}' not in '${targetName}'`,
          severity: "error",
          model: name,
          relation: rname,
          field: ref,
        });
      }
    }
  }
  return errors;
}

/** FK003: FK type must match referenced scalar type */
export function fkTypeMatch(
  _schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const fks = rel["~"].state.fields;
    const refs = rel["~"].state.references;
    if (!(fks && refs)) continue;

    const target = rel["~"].state.getter();
    const targetName = findModelName(ctx, target);
    if (!targetName) continue;

    const len = Math.min(fks.length, refs.length);
    for (let i = 0; i < len; i++) {
      const fkName = fks[i]!;
      const refName = refs[i]!;
      const local = model["~"].state.scalars[fkName];
      const remote = target["~"].state.scalars[refName];
      if (!(local && remote)) continue;

      const localType = local["~"].state.type;
      const remoteType = remote["~"].state.type;
      if (localType !== remoteType) {
        errors.push({
          code: "FK003",
          message: `Type mismatch: '${fkName}' (${localType}) → '${refName}' (${remoteType}) in ${targetName}`,
          severity: "error",
          model: name,
          relation: rname,
        });
      }
    }
  }
  return errors;
}

/** FK004: manyToOne/owning oneToOne should have FK defined */
export function fkRequiredForOwning(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const state = rel["~"].state;
    if (state.type === "manyToOne" && !state.fields) {
      // A fields-less manyToOne whose compatible polymorphic binding resolves
      // (a toMany group) stores its membership in a member junction — there is
      // no foreign key to advise. The unresolved form keeps today's warning.
      if (getCompatiblePolymorphicInverseBinding(state, model)) continue;
      errors.push({
        code: "FK004",
        message: `ManyToOne '${rname}' in '${name}' should define .fields()`,
        severity: "warning",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** FK005: Referenced field should be unique (ID or unique constraint) */
export function fkReferencesUnique(
  _schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const refs = rel["~"].state.references;
    if (!refs) continue;

    const target = rel["~"].state.getter();
    const targetName = findModelName(ctx, target);
    if (!targetName) continue;

    for (const ref of refs) {
      const scalar = target["~"].state.scalars[ref];
      if (!scalar) continue;
      const st = scalar["~"].state;
      if (!(st.isId || st.isUnique)) {
        errors.push({
          code: "FK005",
          message: `'${ref}' in '${targetName}' should be unique/ID`,
          severity: "warning",
          model: name,
          relation: rname,
        });
      }
    }
  }
  return errors;
}

/** FK007: fields() and references() must have same cardinality */
export function fkCardinalityMatch(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const fks = rel["~"].state.fields;
    const refs = rel["~"].state.references;

    // Only check if both are defined
    if (!(fks && refs)) continue;

    if (fks.length !== refs.length) {
      errors.push({
        code: "FK007",
        message: `'${rname}': fields(${fks.length}) != references(${refs.length})`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** FK008: Owning oneToOne FK must be unique, or the relation is effectively many-to-one */
export function fkOneToOneUnique(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const fks = rel["~"].state.fields;
    if (rel["~"].state.type !== "oneToOne" || !fks) continue;

    const fkSet = [...fks].sort().join(",");
    const singleFieldState = model["~"].state.scalars[fks[0]!]?.["~"].state;
    const singleFieldUnique =
      fks.length === 1 &&
      !!(singleFieldState?.isId || singleFieldState?.isUnique);
    const coveredByCompound =
      getCompoundIdFields(model).sort().join(",") === fkSet ||
      getCompoundUniques(model).some(
        (cu) => [...cu.fields].sort().join(",") === fkSet
      );
    const coveredByIndex = model["~"].state.indexes.some(
      (idx) => idx.options.unique && [...idx.fields].sort().join(",") === fkSet
    );

    if (!(singleFieldUnique || coveredByCompound || coveredByIndex)) {
      errors.push({
        code: "FK008",
        message: `1:1 '${rname}' in '${name}': FK [${fks.join(", ")}] must be unique - add .unique() or a compound unique constraint`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

// =============================================================================
// REFERENTIAL ACTION RULES (RA001-RA004)
// =============================================================================

/** RA003: CASCADE on required relation warning */
export function cascadeOnRequiredWarning(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    if (rel["~"].state.onDelete === "cascade" && !rel["~"].state.optional) {
      errors.push({
        code: "RA003",
        message: `CASCADE on required '${rname}' may cause data loss`,
        severity: "warning",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** RA004: SET NULL requires nullable FK field */
export function setNullRequiresNullable(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const action = rel["~"].state.onDelete;
    const fks = rel["~"].state.fields;
    if (action === "setNull" && fks) {
      for (const fk of fks) {
        const scalar = model["~"].state.scalars[fk];
        if (scalar && !scalar["~"].state.nullable) {
          errors.push({
            code: "RA004",
            message: `SET NULL on '${rname}' but '${fk}' not nullable`,
            severity: "error",
            model: name,
            relation: rname,
          });
        }
      }
    }
  }
  return errors;
}

export const fkRules = [
  fkFieldExists,
  fkReferenceExists,
  fkTypeMatch,
  fkRequiredForOwning,
  fkReferencesUnique,
  fkCardinalityMatch,
  fkOneToOneUnique,
  cascadeOnRequiredWarning,
  setNullRequiresNullable,
];
