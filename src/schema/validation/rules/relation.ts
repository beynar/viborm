// Relation Validation Rules

import { isValidSchemaIdentifier } from "../../identifier";
import type { Model } from "../../model";
import type { RelationType } from "../../relation";
import {
  generateJunctionFieldName,
  generateJunctionTableName,
} from "../../relation/helpers";
import type {
  Schema,
  SchemaValidationIssue,
  ValidationContext,
} from "../types";
import { getCompoundIdFields, getCompoundUniques } from "./model";
import {
  findModelName,
  getRelations,
  getRelationValues,
  getScalars,
} from "./model-members";

const INVERSE: Record<RelationType, RelationType> = {
  oneToOne: "oneToOne",
  oneToMany: "manyToOne",
  manyToOne: "oneToMany",
  manyToMany: "manyToMany",
};

const MISSING_INVERSE_CODE: Readonly<Record<RelationType, string>> = {
  oneToOne: "R002",
  oneToMany: "R003",
  manyToOne: "R004",
  manyToMany: "R005",
};

/**
 * Schema-level rules iterate the whole schema themselves; the validator calls
 * every rule once per model, so gate them to the first model to avoid
 * duplicate findings.
 */
function isFirstModel(schema: Schema, name: string): boolean {
  return schema.keys().next().value === name;
}

// =============================================================================
// RELATION RULES (R002-R007)
// =============================================================================

/** R006: Relation target must exist in schema */
export function relationTargetExists(
  _schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const target = rel["~"].state.getter();
    if (!findModelName(ctx, target)) {
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
  _schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const type = rel["~"].state.type;
    const target = rel["~"].state.getter();
    const targetName = findModelName(ctx, target);
    if (!targetName) continue;

    const expected = INVERSE[type];
    if (!hasInverse(target, name, expected, ctx)) {
      errors.push({
        code: MISSING_INVERSE_CODE[type],
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
  _schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  // Group by target + relation name: distinct .name()s are already disambiguated
  const pairs = new Map<string, string[]>();
  for (const [rname, rel] of getRelations(model)) {
    const target = findModelName(ctx, rel["~"].state.getter());
    if (!target) continue;
    const key = `${target}::${rel["~"].state.name ?? ""}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key)!.push(rname);
  }
  const errors: SchemaValidationIssue[] = [];
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
// JUNCTION TABLE RULES (JT001-JT004)
// =============================================================================

/** JT001: Junction table names must be unique */
export function junctionTableUnique(
  schema: Schema,
  _name: string,
  _model: Model<any>
): SchemaValidationIssue[] {
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
  const errors: SchemaValidationIssue[] = [];
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
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    const a = rel["~"].state.A;
    const b = rel["~"].state.B;
    if (a && !isValidSchemaIdentifier(a)) {
      errors.push({
        code: "JT002",
        message: `Junction field A '${a}' in '${rname}' invalid`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
    if (b && !isValidSchemaIdentifier(b)) {
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
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
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
  ctx: ValidationContext
): SchemaValidationIssue[] {
  if (!isFirstModel(schema, name)) return [];

  type Side = {
    model: string;
    rname: string;
    target: string;
    through: string | undefined;
    a: string | undefined;
    b: string | undefined;
  };
  const pairs = new Map<string, Side[]>();
  const errors: SchemaValidationIssue[] = [];
  for (const [mname, m] of schema) {
    for (const [rname, rel] of getRelations(m)) {
      const st = rel["~"].state;
      if (st.type !== "manyToMany") continue;
      const target = findModelName(ctx, st.getter());
      if (!target) continue;
      const models = [mname, target].sort().join("::");
      const key = `${models}::${st.name ?? ""}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key)!.push({
        model: mname,
        rname,
        target,
        through: st.through,
        a: st.A,
        b: st.B,
      });
    }
  }

  for (const sides of pairs.values()) {
    if (sides.length !== 2) continue;
    const s1 = sides[0]!;
    const s2 = sides[1]!;
    const table =
      s1.through ??
      s2.through ??
      generateJunctionTableName(s1.model, s1.target);
    const sourceColumn = s1.a ?? s2.b ?? generateJunctionFieldName(s1.model);
    const targetColumn = s1.b ?? s2.a ?? generateJunctionFieldName(s1.target);
    const tablesConflict =
      s1.through !== undefined &&
      s2.through !== undefined &&
      s1.through !== s2.through;
    const columnsConflict =
      (s1.a !== undefined && s2.b !== undefined && s1.a !== s2.b) ||
      (s1.b !== undefined && s2.a !== undefined && s1.b !== s2.a);
    const selfColumnsMissing =
      s1.model === s1.target && (!(s1.a ?? s2.b) || !(s1.b ?? s2.a));
    const columnsCollide = sourceColumn === targetColumn;

    if (
      tablesConflict ||
      columnsConflict ||
      selfColumnsMissing ||
      columnsCollide
    ) {
      errors.push({
        code: "JT004",
        message: `Junction '${table}' has inconsistent configuration between '${s1.model}.${s1.rname}' and '${s2.model}.${s2.rname}'`,
        severity: "error",
        model: s1.model,
        relation: s1.rname,
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
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
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
  _schema: Schema,
  name: string,
  model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  for (const [rname, rel] of getRelations(model)) {
    if (rel["~"].state.type !== "oneToOne") continue;
    if (!rel["~"].state.fields) continue;

    const target = rel["~"].state.getter();
    const targetName = findModelName(ctx, target);
    if (!targetName) continue;
    if (name > targetName) continue;

    // Check if target also has FK to us
    for (const targetRel of getRelationValues(target)) {
      if (targetRel["~"].state.type !== "oneToOne") continue;
      const targetTarget = findModelName(ctx, targetRel["~"].state.getter());
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
): SchemaValidationIssue[] {
  const errors: SchemaValidationIssue[] = [];
  const fieldNames = Object.keys(model["~"].state.scalars);

  // Find *_type fields and check for matching *_id
  for (const fname of fieldNames) {
    if (!(fname.endsWith("_type") || fname.endsWith("Type"))) continue;

    // Extract base name: "commentable_type" -> "commentable"
    const base = fname.replace(POLYMORPHIC_TYPE_REGEX, "");
    const idField = fieldNames.find(
      (f) => f === `${base}_id` || f === `${base}Id`
    );

    if (!idField) continue;
    const hasRelation = getRelationValues(model).some((relation) =>
      relation["~"].state.fields?.includes(idField)
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

/** CM002: No circular chain of required relations */
export function noCircularRequiredChain(
  schema: Schema,
  _name: string,
  _model: Model<any>,
  ctx: ValidationContext
): SchemaValidationIssue[] {
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
        const target = findModelName(ctx, st.getter());
        if (target) edges.push(target);
      }
    }
    graph.set(mname, edges);
  }

  // DFS to detect cycles
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]): void {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const neighbor of graph.get(node)!) {
      dfs(neighbor, path);
    }

    stack.delete(node);
    path.pop();
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  // Report unique cycles
  const seen = new Set<string>();
  const errors: SchemaValidationIssue[] = [];
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

function hasInverse(
  target: Model<any>,
  sourceName: string,
  expectedType: RelationType,
  ctx: ValidationContext
): boolean {
  for (const rel of getRelationValues(target)) {
    const t = findModelName(ctx, rel["~"].state.getter());
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
  noOrphanFkFields,
  relationPairFkSingleSide,
  polymorphicRelationWarning,
  noCircularRequiredChain,
];
