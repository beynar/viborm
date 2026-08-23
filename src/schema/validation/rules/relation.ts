// Advisory cross-model relation rules.
//
// Every structural relation invariant — pairing, ownership, uniqueness, modifier
// placement, physical junction naming — belongs to the mandatory
// relation-definition gate (`../relation-resolution`). What survives here is
// advice about how a schema is SPELLED, which the gate has no opinion about:
// scalars that look like foreign keys but are not, a required insert cycle, and
// the hand-rolled `*_type` + `*_id` pattern a variant carrier replaces.

import type { Model } from "../../model";
import type { Schema, SchemaValidationIssue } from "../types";
import { getCompoundIdFields, getCompoundUniques } from "./model";
import { getRelationValues, getScalars } from "./model-members";

/** CM001: FK fields should have corresponding relation (warning) */
export function noOrphanFkFields(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  const fkFields = new Set<string>();
  for (const rel of getRelationValues(model)) {
    for (const field of rel["~"].state.foreignKey?.fields ?? []) {
      fkFields.add(field);
    }
  }
  // Compound key members (e.g. orgId in .id(["orgId", "memberId"])) are
  // legitimate non-relation fields
  const compoundFields = new Set(getCompoundIdFields(model));
  for (const cu of getCompoundUniques(model)) {
    for (const f of cu.fields) compoundFields.add(f);
  }
  for (const [fname, scalar] of getScalars(model)) {
    // Heuristic: scalar key ending in "Id" might be FK
    if (
      fname.endsWith("Id") &&
      !fkFields.has(fname) &&
      !compoundFields.has(fname) &&
      !scalar["~"].state.isId
    ) {
      errors.push({
        code: "CM001",
        message: `'${fname}' in '${name}' looks like FK but no relation uses it`,
        severity: "warning",
        model: name,
        field: fname,
      });
    }
  }
  return errors;
}

/**
 * CM004: the hand-rolled polymorphic pattern.
 *
 * A `*_type` + `*_id` scalar pair with no relation using the id column is the
 * shape `s.toOne({ ... })` owns natively, with a real discriminator, exact
 * result types and validated targets.
 */
const POLYMORPHIC_TYPE_REGEX = /_type$|Type$/;
export function polymorphicRelationWarning(
  _s: Schema,
  name: string,
  model: Model<any>
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  const fieldNames = Object.keys(model["~"].state.scalars);

  for (const fname of fieldNames) {
    if (!(fname.endsWith("_type") || fname.endsWith("Type"))) continue;

    // Extract base name: "commentable_type" -> "commentable"
    const base = fname.replace(POLYMORPHIC_TYPE_REGEX, "");
    const idField = fieldNames.find(
      (f) => f === `${base}_id` || f === `${base}Id`
    );

    if (!idField) continue;
    const hasRelation = getRelationValues(model).some((relation) =>
      relation["~"].state.foreignKey?.fields.includes(idField)
    );
    if (hasRelation) continue;
    errors.push({
      code: "CM004",
      message: `'${fname}' + '${idField}' in '${name}' looks like polymorphic pattern (not type-safe)`,
      severity: "warning",
      model: name,
      field: fname,
    });
  }
  return errors;
}

export const relationRules = [noOrphanFkFields, polymorphicRelationWarning];
