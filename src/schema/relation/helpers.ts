// Relation Helpers
// Junction table utility functions for many-to-many relations

import { isValidSchemaIdentifier } from "../identifier";
import type { ManyToManyRelationState, RelationState } from "./types";

// =============================================================================
// JUNCTION TABLE HELPERS
// =============================================================================

/** Any object with ["~"].state matching RelationState */
export type RelationLike = { "~": { state: RelationState } };

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
  const targetModel = state.getter();
  if (!targetModel?.["~"]) {
    return undefined;
  }

  const candidates: ManyToManyRelationState[] = [];
  for (const rel of Object.values(
    targetModel["~"].state.relations
  ) as RelationLike[]) {
    const relState = rel["~"].state;
    if (relState === state) {
      continue;
    }
    if (relState.type !== "manyToMany") {
      continue;
    }
    if (relState.getter() !== state.source) {
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
  const sourceName = state.source["~"].names.ts;
  const targetName = targetModel["~"].names.ts;
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
 * Get the legacy scalar junction column names.
 *
 * @deprecated This two-string projection cannot represent compound junction
 * sides. Engine and migration consumers must use the schema-owned complete group
 * resolver instead. It remains exported only for scalar API compatibility.
 */
export function getJunctionFieldNames(
  relation: RelationLike,
  sourceModelName: string,
  targetModelName: string
): [string, string] {
  return resolveJunctionFieldTokens(
    relation,
    sourceModelName,
    targetModelName,
    false,
    false
  );
}

export interface JunctionFieldGroup {
  /** The public `.A()` / `.B()` token, or its generated equivalent. */
  readonly token: string;
  /** Complete ordered junction columns for this endpoint's row key. */
  readonly fields: readonly string[];
}

export interface JunctionFieldGroups {
  readonly source: JunctionFieldGroup;
  readonly target: JunctionFieldGroup;
}

export type JunctionConstraintKind = "fkey" | "idx" | "key";

export class JunctionPhysicalNameError extends Error {
  readonly kind: "collision" | "invalidIdentifier";

  constructor(kind: "collision" | "invalidIdentifier", message: string) {
    super(message);
    this.name = "JunctionPhysicalNameError";
    this.kind = kind;
  }
}

/** Derive one portable junction constraint name from the side naming token. */
export function getJunctionConstraintName(
  table: string,
  side: JunctionFieldGroup,
  kind: JunctionConstraintKind
): string {
  const name = `${table}_${side.token}_${kind}`;
  if (!isValidSchemaIdentifier(name)) {
    throw new JunctionPhysicalNameError(
      "invalidIdentifier",
      `Generated junction ${kind} name '${name}' is not a valid SQL identifier.`
    );
  }
  return name;
}

/**
 * Resolve both complete junction sides from the two scalar naming tokens.
 *
 * `.A()` and `.B()` keep their historical exact-column meaning for a scalar
 * row key. For a compound row key they are prefixes, expanded positionally in
 * the model key catalog's order. Public configuration therefore never owns a
 * second list of primary-key members or their pairing.
 */
export function getJunctionFieldGroups(
  relation: RelationLike,
  sourceModelName: string,
  targetModelName: string,
  sourceRowKeyFields: readonly string[],
  targetRowKeyFields: readonly string[]
): JunctionFieldGroups {
  const [sourceToken, targetToken] = resolveJunctionFieldTokens(
    relation,
    sourceModelName,
    targetModelName,
    sourceRowKeyFields.length > 1,
    targetRowKeyFields.length > 1
  );
  return expandJunctionFieldGroups(
    sourceModelName,
    targetModelName,
    sourceToken,
    targetToken,
    sourceRowKeyFields,
    targetRowKeyFields
  );
}

/**
 * The relation-free guard core of {@link getJunctionFieldGroups}: expand the two
 * side naming tokens over their complete row keys. The four guards live HERE and
 * only here — row-key emptiness per side, token identifier validity, expanded
 * field identifier validity, and the cross-side field collision. The ordinary
 * pair path reaches them through {@link getJunctionFieldGroups}; the polymorphic
 * member path reaches them through `resolvePolymorphicMemberJunctionTopology`
 * (`./junction-topology`), so both spellings share one refusal set.
 */
export function expandJunctionFieldGroups(
  sourceModelName: string,
  targetModelName: string,
  sourceToken: string,
  targetToken: string,
  sourceRowKeyFields: readonly string[],
  targetRowKeyFields: readonly string[]
): JunctionFieldGroups {
  if (sourceRowKeyFields.length === 0) {
    throw new Error(
      `Model '${sourceModelName}' has no primary key; a junction side requires a complete row key.`
    );
  }
  if (targetRowKeyFields.length === 0) {
    throw new Error(
      `Model '${targetModelName}' has no primary key; a junction side requires a complete row key.`
    );
  }
  for (const token of [sourceToken, targetToken]) {
    if (!isValidSchemaIdentifier(token)) {
      throw new JunctionPhysicalNameError(
        "invalidIdentifier",
        `Junction side prefix '${token}' is not a valid SQL identifier.`
      );
    }
  }
  const source = junctionFieldGroup(sourceToken, sourceRowKeyFields.length);
  const target = junctionFieldGroup(targetToken, targetRowKeyFields.length);
  const occupied = new Map<string, string>();
  for (const field of [...source.fields, ...target.fields]) {
    if (!isValidSchemaIdentifier(field)) {
      throw new JunctionPhysicalNameError(
        "invalidIdentifier",
        `Expanded junction field '${field}' is not a valid SQL identifier.`
      );
    }
    const portableName = field.toLowerCase();
    const previous = occupied.get(portableName);
    if (previous !== undefined) {
      throw new JunctionPhysicalNameError(
        "collision",
        `Junction fields '${previous}' and '${field}' collide after compound-prefix expansion.`
      );
    }
    occupied.set(portableName, field);
  }
  return { source, target };
}

/** Canonical physical side order shared by snapshots and bound membership. */
export function junctionSourceSideIsFirst(
  sourceModelName: string,
  sourceFields: readonly string[],
  targetModelName: string,
  targetFields: readonly string[]
): boolean {
  const sourceModel = sourceModelName.toLowerCase();
  const targetModel = targetModelName.toLowerCase();
  if (sourceModel !== targetModel) return sourceModel < targetModel;
  return sourceFields.join("\0") <= targetFields.join("\0");
}

function junctionFieldGroup(
  token: string,
  rowKeyArity: number
): JunctionFieldGroup {
  return {
    token,
    fields:
      rowKeyArity === 1
        ? [token]
        : Array.from(
            { length: rowKeyArity },
            (_, index) => `${token}_${index + 1}`
          ),
  };
}

function resolveJunctionFieldTokens(
  relation: RelationLike,
  sourceModelName: string,
  targetModelName: string,
  sourceIsCompound: boolean,
  targetIsCompound: boolean
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
    return [
      sourceFieldName ?? `${lower}A${sourceIsCompound ? "" : "Id"}`,
      targetFieldName ?? `${lower}B${targetIsCompound ? "" : "Id"}`,
    ];
  }

  return [
    sourceFieldName ??
      (sourceIsCompound
        ? sourceModelName.toLowerCase()
        : generateJunctionFieldName(sourceModelName)),
    targetFieldName ??
      (targetIsCompound
        ? targetModelName.toLowerCase()
        : generateJunctionFieldName(targetModelName)),
  ];
}
