// Relation Validation Rules

import type { Model } from "../../model";
import type { AnyRelation, RelationType } from "../../relation";
import {
  getJunctionFieldNames,
  getJunctionTableName,
} from "../../relation/helpers";
import type { Scalar } from "../../scalars/base";
import type { Schema, ValidationContext, ValidationError } from "../types";
import { getCompoundIdFields, getCompoundUniques } from "./model";

// ValidationContext is used for O(1) model lookups

const INVERSE: Record<RelationType, RelationType> = {
  oneToOne: "oneToOne",
  oneToMany: "manyToOne",
  manyToOne: "oneToMany",
  manyToMany: "manyToMany",
};

const VALID_ID = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Helper to get typed relation entries */
function getRelations(model: Model<any>): [string, AnyRelation][] {
  return Object.entries(model["~"].state.relations) as [string, AnyRelation][];
}

/** Helper to get typed relation values */
function getRelationValues(model: Model<any>): AnyRelation[] {
  return Object.values(model["~"].state.relations) as AnyRelation[];
}

/** Helper to get typed scalar field entries */
function getScalars(model: Model<any>): [string, Scalar][] {
  return Object.entries(model["~"].state.scalars) as [string, Scalar][];
}

/**
 * Schema-level rules iterate the whole schema themselves; the validator calls
 * every rule once per model, so gate them to the first model to avoid
 * duplicate findings.
 */
function isFirstModel(schema: Schema, name: string): boolean {
  return schema.keys().next().value === name;
}

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
  for (const [rname, rel] of getRelations(model)) {
    const target = rel["~"].state.getter();
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
  for (const [rname, rel] of getRelations(model)) {
    const type = rel["~"].state.type;
    const target = rel["~"].state.getter();
    const targetName = findModel(schema, target, ctx);
    if (!targetName) continue;

    const expected = INVERSE[type];
    if (!hasInverse(target, name, schema, expected, ctx)) {
      let code: string;
      switch (type) {
        case "oneToOne":
          code = "R002";
          break;
        case "oneToMany":
          code = "R003";
          break;
        case "manyToOne":
          code = "R004";
          break;
        case "manyToMany":
          code = "R005";
          break;
        default:
          code = "R002";
          break;
      }

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

/** R007: Multiple relations between same models must be disambiguated with .name() */
export function relationNameUnique(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  // Group by target + relation name: distinct .name()s are already disambiguated
  const pairs = new Map<string, string[]>();
  for (const [rname, rel] of getRelations(model)) {
    const target = findModel(schema, rel["~"].state.getter(), ctx);
    if (!target) continue;
    const key = `${target}::${rel["~"].state.name ?? ""}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key)!.push(rname);
  }
  const errors: ValidationError[] = [];
  for (const [key, rels] of pairs) {
    const target = key.slice(0, key.indexOf("::"));
    // A self-ref relationship keeps forward AND inverse on this model, so two
    // same-named relations to self are the expected pair, not ambiguity.
    const allowed = target === name ? 2 : 1;
    if (rels.length > allowed) {
      errors.push({
        code: "R007",
        message: `Multiple relations ${rels.join(
          ", "
        )} from '${name}' to '${target}' - disambiguate with .name()`,
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
  if (!isFirstModel(schema, _name)) return [];
  const tables = new Map<string, string[]>();
  for (const [mname, m] of schema) {
    for (const [rname, rel] of getRelations(m)) {
      const through = rel["~"].state.through;
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
  for (const [rname, rel] of getRelations(model)) {
    const a = rel["~"].state.A;
    const b = rel["~"].state.B;
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
  for (const [rname, rel] of getRelations(model)) {
    const a = rel["~"].state.A;
    const b = rel["~"].state.B;
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

/**
 * JT004: Relations sharing a junction table must agree on its columns.
 *
 * The two sides of an M:N relationship each resolve [A, B] as
 * [own column, target column], so a consistent junction requires the sides to
 * be mirrored: side1.A === side2.B and side1.B === side2.A. (The inverse side
 * of a self-ref M:N therefore legitimately has A > B - no alphabetical
 * heuristics here.) Also catches self-ref M:N without explicit .A()/.B(),
 * where both columns would generate the same name.
 */
export function junctionConfigConsistent(
  schema: Schema,
  name: string,
  _model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  if (!isFirstModel(schema, name)) return [];

  type Side = {
    model: string;
    rname: string;
    a: string;
    b: string;
    explicit: boolean;
  };
  const junctions = new Map<string, Side[]>();
  const errors: ValidationError[] = [];
  for (const [mname, m] of schema) {
    for (const [rname, rel] of getRelations(m)) {
      const st = rel["~"].state;
      if (st.type !== "manyToMany") continue;
      const target = findModel(schema, st.getter(), ctx);
      if (!target) continue;
      // Junction resolution consults both sides of a hydrated pair and throws
      // on genuinely conflicting config (disagreeing .through()/.A()/.B(),
      // self-ref pair without explicit columns) — report, don't crash.
      let table: string;
      let a: string;
      let b: string;
      try {
        table = getJunctionTableName(rel, mname, target);
        [a, b] = getJunctionFieldNames(rel, mname, target);
      } catch (error) {
        errors.push({
          code: "JT004",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          model: mname,
          relation: rname,
        });
        continue;
      }
      if (!junctions.has(table)) junctions.set(table, []);
      junctions
        .get(table)!
        .push({ model: mname, rname, a, b, explicit: !!(st.A && st.B) });
    }
  }

  for (const [table, sides] of junctions) {
    let collided = false;
    for (const side of sides) {
      if (side.a !== side.b) continue;
      collided = true;
      // Explicit A === B is already reported by JT003
      if (!side.explicit) {
        errors.push({
          code: "JT004",
          message: `Junction '${table}': both columns resolve to '${side.a}' for '${side.rname}' in '${side.model}' - set .A()/.B() explicitly`,
          severity: "error",
          model: side.model,
          relation: side.rname,
        });
      }
    }
    // >2 sides is JT001's finding; 1 side has nothing to compare
    if (collided || sides.length !== 2) continue;
    const [s1, s2] = sides as [Side, Side];
    if (s1.a !== s2.b || s1.b !== s2.a) {
      errors.push({
        code: "JT004",
        message: `Junction '${table}': '${s1.rname}' in '${s1.model}' uses columns (${s1.a}, ${s1.b}) but '${s2.rname}' in '${s2.model}' uses (${s2.a}, ${s2.b}) - sides must mirror each other`,
        severity: "error",
        model: s1.model,
        relation: s1.rname,
      });
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
  for (const [rname, rel] of getRelations(model)) {
    if (rel["~"].state.through && rel["~"].state.type !== "manyToMany") {
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
  for (const [rname, rel] of getRelations(model)) {
    const target = rel["~"].state.getter();
    const targetName = findModel(schema, target, ctx);
    if (targetName !== name) continue; // not self-ref

    const type = rel["~"].state.type;
    const expected = INVERSE[type];
    let found = false;
    for (const [otherName, otherRel] of getRelations(model)) {
      if (otherName !== rname && otherRel["~"].state.type === expected) {
        const otherTarget = findModel(
          schema,
          otherRel["~"].state.getter(),
          ctx
        );
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
  for (const rel of getRelationValues(model)) {
    const fields = rel["~"].state.fields;
    if (fields) {
      for (const f of fields) fkFields.add(f);
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

/** CM003: In 1:1, FK should be on one side only */
export function relationPairFkSingleSide(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [rname, rel] of getRelations(model)) {
    if (rel["~"].state.type !== "oneToOne") continue;
    if (!rel["~"].state.fields) continue;

    const target = rel["~"].state.getter();
    const targetName = findModel(schema, target, ctx);
    if (!targetName) continue;

    // Check if target also has FK to us
    for (const targetRel of getRelationValues(target)) {
      if (targetRel["~"].state.type !== "oneToOne") continue;
      const targetTarget = findModel(
        schema,
        targetRel["~"].state.getter(),
        ctx
      );
      if (targetTarget === name && targetRel["~"].state.fields) {
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
const POLYMORPHIC_TYPE_REGEX = /_type$|Type$/;
export function polymorphicRelationWarning(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fieldNames = Object.keys(model["~"].state.scalars);

  // Find *_type fields and check for matching *_id
  for (const fname of fieldNames) {
    if (!(fname.endsWith("_type") || fname.endsWith("Type"))) continue;

    // Extract base name: "commentable_type" -> "commentable"
    const base = fname.replace(POLYMORPHIC_TYPE_REGEX, "");
    const idField = fieldNames.find(
      (f) => f === `${base}_id` || f === `${base}Id`
    );

    if (idField) {
      // Check if there's a relation using this field
      let hasRelation = false;
      for (const rel of getRelationValues(model)) {
        const fks = rel["~"].state.fields;
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
  if (!isFirstModel(schema, _name)) return [];
  // Build adjacency list of required relations
  const graph = new Map<string, string[]>();
  for (const [mname, m] of schema) {
    const edges: string[] = [];
    for (const rel of getRelationValues(m)) {
      const st = rel["~"].state;
      // Only required FK-owning to-one relations create insert dependencies.
      // A oneToOne without .fields() is the inverse side and owns no FK.
      const ownsFk =
        st.type === "manyToOne" || (st.type === "oneToOne" && st.fields);
      if (ownsFk && !st.optional) {
        const target = findModel(schema, st.getter(), ctx);
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
  for (const rel of getRelationValues(target)) {
    const t = findModel(schema, rel["~"].state.getter(), ctx);
    if (t === sourceName && rel["~"].state.type === expectedType) return true;
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
  junctionConfigConsistent,
  throughOnlyManyToMany,
  selfRefValidInverse,
  noOrphanFkFields,
  relationPairFkSingleSide,
  polymorphicRelationWarning,
  noCircularRequiredChain,
];
