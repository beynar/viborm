// Foreign Key & Referential Action Validation Rules

import type { Model } from "../../model";
import type { AnyRelation } from "../../relation";
import type { Scalar } from "../../scalars/base";
import type { Schema, ValidationContext, ValidationError } from "../types";
import { getCompoundIdFields, getCompoundUniques } from "./model";

/** Helper to get typed relation entries */
function getRelations(model: Model<any>): [string, AnyRelation][] {
  return Object.entries(model["~"].state.relations) as [string, AnyRelation][];
}

/** Helper to get a scalar field by name */
function getScalar(model: Model<any>, name: string): Scalar | undefined {
  return model["~"].state.scalars[name] as Scalar | undefined;
}

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
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const refs = rel["~"].state.references;
    if (!refs) continue;
    const target = rel["~"].state.getter();
    const targetName = findModel(schema, target, ctx);
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
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const fks = rel["~"].state.fields;
    const refs = rel["~"].state.references;
    if (!(fks && refs)) continue;

    const target = rel["~"].state.getter();
    const targetName = findModel(schema, target, ctx) ?? "?";

    const len = Math.min(fks.length, refs.length);
    for (let i = 0; i < len; i++) {
      const fkName = fks[i]!;
      const refName = refs[i]!;
      const local = getScalar(model, fkName);
      const remote = getScalar(target, refName);
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
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const type = rel["~"].state.type;
    if (type === "manyToOne" && !rel["~"].state.fields) {
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
  for (const [rname, rel] of getRelations(model)) {
    const refs = rel["~"].state.references;
    if (!refs) continue;

    const target = rel["~"].state.getter();
    const targetName = findModel(schema, target, ctx) ?? "?";

    for (const ref of refs) {
      const scalar = getScalar(target, ref);
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

/** FK006: FK field cannot be a relation field (must be scalar) */
export function fkFieldNotRelation(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const relNames = new Set(Object.keys(model["~"].state.relations));
  for (const [rname, rel] of getRelations(model)) {
    const fks = rel["~"].state.fields;
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
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const fks = rel["~"].state.fields;
    if (rel["~"].state.type !== "oneToOne" || !fks) continue;

    const fkSet = [...fks].sort().join(",");
    const singleFieldUnique =
      fks.length === 1 &&
      (() => {
        const st = getScalar(model, fks[0]!)?.["~"].state;
        return !!(st?.isId || st?.isUnique);
      })();
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

const VALID_ACTIONS = new Set(["cascade", "setNull", "restrict", "noAction"]);

/** RA001: onDelete must be valid action */
export function onDeleteValid(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const action = rel["~"].state.onDelete;
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
  for (const [rname, rel] of getRelations(model)) {
    const action = rel["~"].state.onUpdate;
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
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const action = rel["~"].state.onDelete;
    const fks = rel["~"].state.fields;
    if (action === "setNull" && fks) {
      for (const fk of fks) {
        const scalar = getScalar(model, fk);
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
  fkOneToOneUnique,
  onDeleteValid,
  onUpdateValid,
  cascadeOnRequiredWarning,
  setNullRequiresNullable,
];
