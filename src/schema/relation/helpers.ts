// Relation Helpers
// Junction table utility functions for many-to-many relations

import type { ManyToManyRelationState, RelationState } from "./types";

// =============================================================================
// JUNCTION TABLE HELPERS
// =============================================================================

/** Any object with ["~"].state matching RelationState */
type RelationLike = { "~": { state: RelationState } };

/**
 * Generate a junction table name from two model names
 * Names are sorted alphabetically and joined with underscore
 *
 * @example
 * generateJunctionTableName("post", "tag") // "post_tag"
 * generateJunctionTableName("user", "role") // "role_user"
 */
export function generateJunctionTableName(
  model1: string,
  model2: string
): string {
  const names = [model1.toLowerCase(), model2.toLowerCase()].sort();
  return `${names[0]}_${names[1]}`;
}

/**
 * Generate a junction column name from a model name
 *
 * @example
 * generateJunctionFieldName("post") // "postId"
 * generateJunctionFieldName("User") // "userId"
 */
export function generateJunctionFieldName(modelName: string): string {
  return `${modelName.toLowerCase()}Id`;
}

/**
 * Find the paired manyToMany relation on the target model that points back at
 * this relation's source model. Junction identity (.through()/.A()/.B()) may
 * be configured on either side of the pair; resolving through the pair keeps
 * both sides agreeing on the same table and columns.
 *
 * Requires the relation's source model to be bound (hydrateSchemaNames);
 * returns undefined otherwise, or when no unambiguous pair exists.
 */
export function findPairedManyToManyState(
  relation: RelationLike
): ManyToManyRelationState | undefined {
  const state = relation["~"].state;
  if (state.type !== "manyToMany" || !state.source) {
    return undefined;
  }
  const targetModel = state.getter?.();
  if (!targetModel?.["~"]) {
    return undefined;
  }

  const candidates: ManyToManyRelationState[] = [];
  for (const rel of Object.values(
    targetModel["~"].state.relations ?? {}
  ) as RelationLike[]) {
    const relState = rel["~"].state;
    if (relState === state) {
      continue;
    }
    if (relState.type !== "manyToMany") {
      continue;
    }
    if (relState.getter?.() !== state.source) {
      continue;
    }
    candidates.push(relState as ManyToManyRelationState);
  }

  if (candidates.length <= 1) {
    const paired = candidates[0];
    // Differently-named relations belong to different pairs, not each other.
    if (
      paired?.name !== undefined &&
      state.name !== undefined &&
      paired.name !== state.name
    ) {
      return undefined;
    }
    return paired;
  }
  // Multiple M2M pairs between the same models — match by .name() (both
  // unnamed counts as the single default pair).
  const matched = candidates.filter(
    (candidate) => candidate.name === state.name
  );
  if (matched.length === 1) {
    return matched[0];
  }
  const sourceName = state.source["~"]?.names.ts ?? "unknown";
  const targetName = targetModel["~"].names.ts ?? "unknown";
  throw new Error(
    `Multiple many-to-many relation pairs between '${sourceName}' and '${targetName}' are ambiguous — give each pair a distinct .name() on both sides.`
  );
}

/**
 * Get the junction table name for a many-to-many relation
 * Uses explicit .through() from either side of the relation pair if set,
 * otherwise generates from model names.
 */
export function getJunctionTableName(
  relation: RelationLike,
  sourceModelName: string,
  targetModelName: string
): string {
  const state = relation["~"].state;
  if (state.type !== "manyToMany") {
    return generateJunctionTableName(sourceModelName, targetModelName);
  }
  const paired = findPairedManyToManyState(relation);
  if (state.through && paired?.through && state.through !== paired.through) {
    throw new Error(
      `Many-to-many relations between '${sourceModelName}' and '${targetModelName}' disagree on .through(): '${state.through}' vs '${paired.through}'.`
    );
  }
  const explicit = state.through ?? paired?.through;
  if (explicit) {
    return explicit;
  }
  // Named pairs get their own junction (Prisma gives each named pair its own
  // _RelName table); the bare generated name stays for the default pair.
  const base = generateJunctionTableName(sourceModelName, targetModelName);
  const pairName = state.name ?? paired?.name;
  return pairName ? `${base}_${pairName}` : base;
}

/**
 * Get the junction column names for a many-to-many relation
 * Returns [sourceColumnName, targetColumnName]
 *
 * Explicit .A()/.B() from either side of the relation pair wins (the paired
 * relation's A/B are swapped relative to this side). Defaults derive from the
 * model names; a self-referential relation gets distinct A/B columns since
 * both would otherwise collapse to the same name.
 */
export function getJunctionFieldNames(
  relation: RelationLike,
  sourceModelName: string,
  targetModelName: string
): [string, string] {
  const state = relation["~"].state as ManyToManyRelationState;
  const paired =
    state.type === "manyToMany"
      ? findPairedManyToManyState(relation)
      : undefined;

  if (state.A && paired?.B && state.A !== paired.B) {
    throw new Error(
      `Many-to-many relations between '${sourceModelName}' and '${targetModelName}' disagree on junction columns: .A('${state.A}') vs paired .B('${paired.B}').`
    );
  }
  if (state.B && paired?.A && state.B !== paired.A) {
    throw new Error(
      `Many-to-many relations between '${sourceModelName}' and '${targetModelName}' disagree on junction columns: .B('${state.B}') vs paired .A('${paired.A}').`
    );
  }

  const sourceFieldName = state.A ?? paired?.B;
  const targetFieldName = state.B ?? paired?.A;

  if (sourceModelName === targetModelName) {
    if (paired && !(sourceFieldName && targetFieldName)) {
      // With two self-relations and no explicit columns, there is no stable
      // rule for which side traverses A→B vs B→A.
      throw new Error(
        `Self-referential many-to-many relations on '${sourceModelName}' require explicit junction columns: set .A() and .B() on one side of the pair.`
      );
    }
    // ponytail: single self-relation traverses A→B only; the reverse direction
    // needs a paired relation with explicit .A()/.B()
    const lower = sourceModelName.toLowerCase();
    return [sourceFieldName ?? `${lower}AId`, targetFieldName ?? `${lower}BId`];
  }

  return [
    sourceFieldName ?? generateJunctionFieldName(sourceModelName),
    targetFieldName ?? generateJunctionFieldName(targetModelName),
  ];
}
