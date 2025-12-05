// Foreign Key & Referential Action Validation Rules

import type { Model } from "../../model";
import type { ValidationError, Schema, ValidationContext } from "../types";

// =============================================================================
// FK RULES (FK001-FK007)
// =============================================================================

/** FK001: .fields() must reference existing scalar fields */
export function fkFieldExists(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fields = new Set(model["~"].fieldMap.keys());
  for (const [rname, rel] of model["~"].relations) {
    const fks = rel["~"].fields;
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
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const refs = rel["~"].references;
    if (!refs) continue;
    const target = rel["~"].getter();
    const targetName = findModel(schema, target, ctx);
    if (!targetName) continue;
    const targetFields = new Set(target["~"].fieldMap.keys());
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

/** FK003: FK type must match referenced field type */
export function fkTypeMatch(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const fks = rel["~"].fields;
    const refs = rel["~"].references;
    if (!fks || !refs) continue;

    const target = rel["~"].getter();
    const targetName = findModel(schema, target, ctx) ?? "?";

    const len = Math.min(fks.length, refs.length);
    for (let i = 0; i < len; i++) {
      const fkName = fks[i]!;
      const refName = refs[i]!;
      const local = model["~"].fieldMap.get(fkName);
      const remote = target["~"].fieldMap.get(refName);
      if (!local || !remote) continue;

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
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const type = rel["~"].relationType;
    if (type === "manyToOne" && !rel["~"].fields) {
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
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const refs = rel["~"].references;
    if (!refs) continue;

    const target = rel["~"].getter();
    const targetName = findModel(schema, target, ctx) ?? "?";

    for (const ref of refs) {
      const field = target["~"].fieldMap.get(ref);
      if (!field) continue;
      const st = field["~"].state;
      if (!st.isId && !st.isUnique) {
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

/** FK006: FK field cannot be a relation field (must be scalar) */
export function fkFieldNotRelation(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const relNames = new Set(model["~"].relations.keys());
  for (const [rname, rel] of model["~"].relations) {
    const fks = rel["~"].fields;
    if (!fks) continue;
    for (const fk of fks) {
      if (relNames.has(fk)) {
        errors.push({
          code: "FK006",
          message: `FK '${fk}' in '${rname}' cannot reference relation`,
          severity: "error",
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
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const fks = rel["~"].fields;
    const refs = rel["~"].references;

    // Only check if both are defined
    if (!fks || !refs) continue;

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

// =============================================================================
// REFERENTIAL ACTION RULES (RA001-RA004)
// =============================================================================

const VALID_ACTIONS = new Set(["cascade", "setNull", "restrict", "noAction"]);

/** RA001: onDelete must be valid action */
export function onDeleteValid(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const action = rel["~"].onDelete;
    if (action && !VALID_ACTIONS.has(action)) {
      errors.push({
        code: "RA001",
        message: `Invalid onDelete '${action}' in '${rname}'`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** RA002: onUpdate must be valid action */
export function onUpdateValid(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const action = rel["~"].onUpdate;
    if (action && !VALID_ACTIONS.has(action)) {
      errors.push({
        code: "RA002",
        message: `Invalid onUpdate '${action}' in '${rname}'`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** RA003: CASCADE on required relation warning */
export function cascadeOnRequiredWarning(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    if (rel["~"].onDelete === "cascade" && !rel["~"].isOptional) {
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
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const action = rel["~"].onDelete;
    const fks = rel["~"].fields;
    if (action === "setNull" && fks) {
      for (const fk of fks) {
        const field = model["~"].fieldMap.get(fk);
        if (field && !field["~"].state.nullable) {
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

// =============================================================================
// HELPERS
// =============================================================================

/** O(1) lookup when ctx provided, O(n) fallback otherwise */
function findModel(
  schema: Schema,
  model: Model<any>,
  ctx?: ValidationContext
): string | undefined {
  if (ctx) return ctx.modelToName.get(model);
  for (const [n, m] of schema) {
    if (m === model) return n;
  }
  return undefined;
}

export const fkRules = [
  fkFieldExists,
  fkReferenceExists,
  fkTypeMatch,
  fkRequiredForOwning,
  fkReferencesUnique,
  fkFieldNotRelation,
  fkCardinalityMatch,
  onDeleteValid,
  onUpdateValid,
  cascadeOnRequiredWarning,
  setNullRequiresNullable,
];
