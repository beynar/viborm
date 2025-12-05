// Relation Validation Rules

import type { Model } from "../../model";
import type { RelationType } from "../../relation";
import type { ValidationError, Schema, ValidationContext } from "../types";
// ValidationContext is used for O(1) model lookups

const INVERSE: Record<RelationType, RelationType> = {
  oneToOne: "oneToOne",
  oneToMany: "manyToOne",
  manyToOne: "oneToMany",
  manyToMany: "manyToMany",
};

const VALID_ID = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// =============================================================================
// RELATION RULES (R001-R007)
// =============================================================================

/** R006: Relation target must exist in schema */
export function relationTargetExists(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const target = rel["~"].getter();
    if (!findModel(schema, target, ctx)) {
      errors.push({
        code: "R006",
        message: `'${rname}' in '${name}' targets unregistered model`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** R001-R005: Relation must have matching inverse */
export function relationHasInverse(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const type = rel["~"].relationType;
    const target = rel["~"].getter();
    const targetName = findModel(schema, target, ctx);
    if (!targetName) continue;

    const expected = INVERSE[type];
    if (!hasInverse(target, name, schema, expected, ctx)) {
      const code =
        type === "oneToOne"
          ? "R002"
          : type === "oneToMany"
          ? "R003"
          : type === "manyToOne"
          ? "R004"
          : "R005";
      errors.push({
        code,
        message: `'${rname}' (${type}) in '${name}' missing inverse ${expected} in '${targetName}'`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** R007: Multiple relations between same models must be disambiguated */
export function relationNameUnique(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const pairs = new Map<string, string[]>();
  for (const [rname, rel] of model["~"].relations) {
    const target = findModel(schema, rel["~"].getter(), ctx);
    if (!target) continue;
    const key = `${name}->${target}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key)!.push(rname);
  }
  const errors: ValidationError[] = [];
  for (const [pair, rels] of pairs) {
    if (rels.length > 1) {
      errors.push({
        code: "R007",
        message: `Multiple relations ${rels.join(
          ", "
        )} for ${pair} - disambiguate with relation names`,
        severity: "warning",
        model: name,
      });
    }
  }
  return errors;
}

// =============================================================================
// JUNCTION TABLE RULES (JT001-JT005)
// =============================================================================

/** JT001: Junction table names must be unique */
export function junctionTableUnique(
  schema: Schema,
  _name: string,
  _model: Model<any>
): ValidationError[] {
  const tables = new Map<string, string[]>();
  for (const [mname, m] of schema) {
    for (const [rname, rel] of m["~"].relations) {
      const through = rel["~"].through;
      if (through) {
        const key = `${mname}.${rname}`;
        if (!tables.has(through)) tables.set(through, []);
        tables.get(through)!.push(key);
      }
    }
  }
  const errors: ValidationError[] = [];
  for (const [table, sources] of tables) {
    if (sources.length > 2) {
      errors.push({
        code: "JT001",
        message: `Junction '${table}' used by: ${sources.join(", ")}`,
        severity: "error",
      });
    }
  }
  return errors;
}

/** JT002: A/B field names must be valid SQL identifiers */
export function junctionFieldsValid(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const a = rel["~"].throughA;
    const b = rel["~"].throughB;
    if (a && !VALID_ID.test(a)) {
      errors.push({
        code: "JT002",
        message: `Junction field A '${a}' in '${rname}' invalid`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
    if (b && !VALID_ID.test(b)) {
      errors.push({
        code: "JT002",
        message: `Junction field B '${b}' in '${rname}' invalid`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** JT003: A and B must be different */
export function junctionFieldsDistinct(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const a = rel["~"].throughA;
    const b = rel["~"].throughB;
    if (a && b && a === b) {
      errors.push({
        code: "JT003",
        message: `A and B same ('${a}') in '${rname}'`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** JT004: Self-ref M:N should use consistent A/B naming */
export function selfRefJunctionOrder(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    if (rel["~"].relationType !== "manyToMany") continue;

    const target = rel["~"].getter();
    const targetName = findModel(schema, target, ctx);
    if (targetName !== name) continue; // Not self-ref

    const a = rel["~"].throughA;
    const b = rel["~"].throughB;

    // If both A and B are set, warn if they're not clearly ordered
    if (a && b) {
      // Heuristic: A should come before B alphabetically for consistency
      if (a.localeCompare(b) > 0) {
        errors.push({
          code: "JT004",
          message: `Self-ref M:N '${rname}': A('${a}') should be < B('${b}') alphabetically`,
          severity: "warning",
          model: name,
          relation: rname,
        });
      }
    }
  }
  return errors;
}

/** JT005: .through() only valid on manyToMany */
export function throughOnlyManyToMany(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    if (rel["~"].through && rel["~"].relationType !== "manyToMany") {
      errors.push({
        code: "JT005",
        message: `.through() on '${rname}' requires manyToMany`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

// =============================================================================
// SELF-REFERENTIAL RULES (SR001-SR003)
// =============================================================================

/** SR001: Self-ref relations must have inverse */
export function selfRefValidInverse(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const target = rel["~"].getter();
    const targetName = findModel(schema, target, ctx);
    if (targetName !== name) continue; // not self-ref

    const type = rel["~"].relationType;
    const expected = INVERSE[type];
    let found = false;
    for (const [otherName, otherRel] of model["~"].relations) {
      if (otherName !== rname && otherRel["~"].relationType === expected) {
        const otherTarget = findModel(schema, otherRel["~"].getter(), ctx);
        if (otherTarget === name) {
          found = true;
          break;
        }
      }
    }
    if (!found && type !== "manyToMany") {
      errors.push({
        code: "SR001",
        message: `Self-ref '${rname}' needs inverse ${expected} in same model`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/** SR002: Self-ref relation names must be distinct */
export function selfRefDistinctNames(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const selfRels: string[] = [];
  for (const [rname, rel] of model["~"].relations) {
    const target = findModel(schema, rel["~"].getter(), ctx);
    if (target === name) selfRels.push(rname);
  }
  if (selfRels.length > 1) {
    const unique = new Set(selfRels);
    if (unique.size !== selfRels.length) {
      return [
        {
          code: "SR002",
          message: `Self-ref relations in '${name}' have duplicate names`,
          severity: "error",
          model: name,
        },
      ];
    }
  }
  return [];
}

// =============================================================================
// CROSS-MODEL RULES (CM001-CM004)
// =============================================================================

/** CM001: FK fields should have corresponding relation (warning) */
export function noOrphanFkFields(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fkFields = new Set<string>();
  for (const rel of model["~"].relations.values()) {
    if (rel["~"].fields) {
      for (const f of rel["~"].fields) fkFields.add(f);
    }
  }
  for (const [fname, field] of model["~"].fieldMap) {
    // Heuristic: field ending in "Id" might be FK
    if (
      fname.endsWith("Id") &&
      !fkFields.has(fname) &&
      !field["~"].state.isId
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

/** CM003: In 1:1, FK should be on one side only */
export function relationPairFkSingleSide(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of model["~"].relations) {
    if (rel["~"].relationType !== "oneToOne") continue;
    if (!rel["~"].fields) continue;

    const target = rel["~"].getter();
    const targetName = findModel(schema, target, ctx);
    if (!targetName) continue;

    // Check if target also has FK to us
    for (const [, targetRel] of target["~"].relations) {
      if (targetRel["~"].relationType !== "oneToOne") continue;
      const targetTarget = findModel(schema, targetRel["~"].getter(), ctx);
      if (targetTarget === name && targetRel["~"].fields) {
        errors.push({
          code: "CM003",
          message: `1:1 between '${name}' and '${targetName}' has FK on both sides`,
          severity: "warning",
          model: name,
          relation: rname,
        });
        break;
      }
    }
  }
  return errors;
}

/**
 * CM004: Polymorphic relation pattern warning
 *
 * Polymorphic relations allow a single table to reference multiple other tables
 * using a `*_type` + `*_id` field pair. Example:
 *
 *   comment.commentable_type = "Post" | "Photo"
 *   comment.commentable_id   = <id of the target row>
 *
 * Problems with this pattern:
 * - No FK constraint enforcement (DB can't validate references)
 * - No type safety (ORM can't infer target model)
 * - Complex JOIN logic (depends on _type value)
 * - No cascade delete/update
 *
 * Preferred alternatives:
 * - Separate relation tables: post_comments, photo_comments
 * - Use explicit relations with discriminated unions at app level
 */
export function polymorphicRelationWarning(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fieldNames = Array.from(model["~"].fieldMap.keys());

  // Find *_type fields and check for matching *_id
  for (const fname of fieldNames) {
    if (!fname.endsWith("_type") && !fname.endsWith("Type")) continue;

    // Extract base name: "commentable_type" -> "commentable"
    const base = fname.replace(/_type$|Type$/, "");
    const idField = fieldNames.find(
      (f) => f === `${base}_id` || f === `${base}Id`
    );

    if (idField) {
      // Check if there's a relation using this field
      let hasRelation = false;
      for (const rel of model["~"].relations.values()) {
        const fks = rel["~"].fields;
        if (fks?.includes(idField)) {
          hasRelation = true;
          break;
        }
      }

      if (!hasRelation) {
        errors.push({
          code: "CM004",
          message: `'${fname}' + '${idField}' in '${name}' looks like polymorphic pattern (not type-safe)`,
          severity: "warning",
          model: name,
          field: fname,
        });
      }
    }
  }
  return errors;
}

/** CM002: No circular chain of required relations */
export function noCircularRequiredChain(
  schema: Schema,
  _name: string,
  _model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  // Build adjacency list of required relations
  const graph = new Map<string, string[]>();
  for (const [mname, m] of schema) {
    const edges: string[] = [];
    for (const rel of m["~"].relations.values()) {
      // Only required to-one relations create insert dependencies
      if (rel["~"].isToOne && !rel["~"].isOptional) {
        const target = findModel(schema, rel["~"].getter(), ctx);
        if (target) edges.push(target);
      }
    }
    graph.set(mname, edges);
  }

  // DFS to detect cycles
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]): boolean {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return true;
    }
    if (visited.has(node)) return false;

    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const neighbor of graph.get(node) ?? []) {
      dfs(neighbor, path);
    }

    stack.delete(node);
    path.pop();
    return false;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  // Report unique cycles
  const seen = new Set<string>();
  const errors: ValidationError[] = [];
  for (const cycle of cycles) {
    const key = [...cycle].sort().join("->");
    if (!seen.has(key)) {
      seen.add(key);
      errors.push({
        code: "CM002",
        message: `Circular required relations: ${cycle.join(" → ")}`,
        severity: "error",
      });
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

function hasInverse(
  target: Model<any>,
  sourceName: string,
  schema: Schema,
  expectedType: RelationType,
  ctx?: ValidationContext
): boolean {
  for (const rel of target["~"].relations.values()) {
    const t = findModel(schema, rel["~"].getter(), ctx);
    if (t === sourceName && rel["~"].relationType === expectedType) return true;
  }
  return false;
}

export const relationRules = [
  relationTargetExists,
  relationHasInverse,
  relationNameUnique,
  junctionTableUnique,
  junctionFieldsValid,
  junctionFieldsDistinct,
  selfRefJunctionOrder,
  throughOnlyManyToMany,
  selfRefValidInverse,
  selfRefDistinctNames,
  noOrphanFkFields,
  relationPairFkSingleSide,
  polymorphicRelationWarning,
  noCircularRequiredChain,
];
