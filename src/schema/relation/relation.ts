// Relation Class Implementation
// Clean class hierarchy for different relation types

import { Model } from "../model";
import { type SchemaNames } from "../fields/common";
import { Simplify } from "../../types/utilities.js";

export type Getter = () => Model<any>;
export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";
export type ReferentialAction = "cascade" | "setNull" | "restrict" | "noAction";

// =============================================================================
// RELATION INTERNALS (exposed via ~)
// =============================================================================

type UpdateState<
  State extends RelationState,
  Update extends Partial<RelationState>
> = State & Update;
export interface RelationState {
  fields?: string[];
  references?: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  optional: boolean;
  through?: string;
  throughA?: string;
  throughB?: string;
}

export interface RelationInternals<
  G extends Getter,
  T extends RelationType,
  TOptional extends boolean = false
> {
  readonly getter: G;
  readonly relationType: T;
  readonly isToMany: boolean;
  readonly isToOne: boolean;
  readonly isOptional: TOptional;
  readonly fields?: string[] | undefined;
  readonly references?: string[] | undefined;
  readonly onDelete?: ReferentialAction | undefined;
  readonly onUpdate?: ReferentialAction | undefined;
  // ManyToMany only
  readonly through?: string | undefined;
  readonly throughA?: string | undefined;
  readonly throughB?: string | undefined;
  // Name slots hydrated by client at initialization
  readonly names: SchemaNames;
  // Type inference
  readonly infer: G extends () => infer M
    ? M extends Model<any>
      ? T extends "oneToMany" | "manyToMany"
        ? Simplify<M["~"]["infer"]>[]
        : TOptional extends true
        ? Simplify<M["~"]["infer"]> | null
        : Simplify<M["~"]["infer"]>
      : never
    : never;
}

// =============================================================================
// BASE RELATION (shared logic)
// =============================================================================

export abstract class Relation<
  const G extends Getter,
  State extends RelationState = RelationState,
  T extends RelationType = RelationType
> {
  private _getter: G;
  private _state: State;
  private _relationType: T;
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(getter: G, state: State, relationType: T) {
    this._getter = getter;
    this._state = state;
    this._relationType = relationType;
  }

  get "~"(): State & { getter: G; relationType: T; names: SchemaNames } {
    return {
      ...this._state,
      getter: this._getter,
      relationType: this._relationType,
      names: this._names,
    };
  }
}

// =============================================================================
// TO-ONE RELATIONS (oneToOne, manyToOne) - can be optional
// =============================================================================

export class OneToOneRelation<
  const G extends Getter,
  State extends RelationState = RelationState
> extends Relation<G, State, "oneToOne"> {
  constructor(getter: G, state: State) {
    super(getter, state, "oneToOne");
  }
}

export class ManyToOneRelation<
  G extends Getter,
  State extends RelationState = RelationState
> extends Relation<G, State, "manyToOne"> {
  constructor(getter: G, state: State) {
    super(getter, state, "manyToOne");
  }
}

// =============================================================================
// ONE-TO-MANY RELATION - no optional, no through
// =============================================================================

export class OneToManyRelation<
  G extends Getter,
  State extends RelationState = RelationState
> extends Relation<G, State, "oneToMany"> {
  constructor(getter: G, state: State) {
    super(getter, state, "oneToMany");
  }
}

// =============================================================================
// MANY-TO-MANY RELATION - has through, A, B
// =============================================================================

export class ManyToManyRelation<
  G extends Getter,
  State extends RelationState = RelationState
> extends Relation<G, State, "manyToMany"> {
  constructor(getter: G, state: State) {
    super(getter, state, "manyToMany");
  }
}

// =============================================================================
// RELATION BUILDER (getter-last pattern)
// =============================================================================

/**
 * RelationBuilder class for defining relations with config-first, getter-last pattern.
 *
 * This pattern avoids TypeScript circular reference issues because:
 * 1. Config methods (fields, references, etc.) return `this` - no generics involved
 * 2. Terminal methods (oneToOne, manyToOne, etc.) introduce the generic LAST
 * 3. Since there's no more chaining after the terminal method, TypeScript doesn't
 *    need to resolve the generic to enable further method calls
 *
 * @example
 * const user = s.model({
 *   posts: s.relation.oneToMany(() => post),
 *   profile: s.relation.optional().oneToOne(() => profile),
 * });
 * const post = s.model({
 *   author: s.relation.fields("authorId").references("id").manyToOne(() => user),
 * });
 */

export class RelationBuilderImpl<State extends RelationState> {
  private _state: State;
  constructor(state: State) {
    this._state = state;
  }

  /** FK field(s) on the current model */
  fields(
    ...names: string[]
  ): RelationBuilderImpl<UpdateState<State, { fields: string[] }>> {
    return new RelationBuilderImpl({ ...this._state, fields: names });
  }

  /** Field(s) on the target model being referenced */
  references(
    ...names: string[]
  ): RelationBuilderImpl<UpdateState<State, { references: string[] }>> {
    const builder = new RelationBuilderImpl({
      ...this._state,
      references: names,
    });
    return builder;
  }

  /** Action when referenced row is deleted */
  onDelete(
    action: ReferentialAction
  ): RelationBuilderImpl<UpdateState<State, { onDelete: ReferentialAction }>> {
    return new RelationBuilderImpl({ ...this._state, onDelete: action });
  }

  /** Action when referenced row is updated */
  onUpdate(
    action: ReferentialAction
  ): RelationBuilderImpl<UpdateState<State, { onUpdate: ReferentialAction }>> {
    return new RelationBuilderImpl({ ...this._state, onUpdate: action });
  }

  /** Mark relation as optional (allows null) - only for to-one relations */
  optional(): RelationBuilderImpl<UpdateState<State, { optional: true }>> {
    return new RelationBuilderImpl({ ...this._state, optional: true });
  }

  /** Junction table name (many-to-many only) */
  through(
    tableName: string
  ): RelationBuilderImpl<UpdateState<State, { through: string }>> {
    return new RelationBuilderImpl({ ...this._state, through: tableName });
  }

  /** Junction table FK column for source model (many-to-many only) */
  A(
    fieldName: string
  ): RelationBuilderImpl<UpdateState<State, { throughA: string }>> {
    return new RelationBuilderImpl({ ...this._state, throughA: fieldName });
  }

  /** Junction table FK column for target model (many-to-many only) */
  B(
    fieldName: string
  ): RelationBuilderImpl<UpdateState<State, { throughB: string }>> {
    return new RelationBuilderImpl({ ...this._state, throughB: fieldName });
  }

  // ===========================================================================
  // TERMINAL METHODS - These introduce the generic and finalize the relation
  // ===========================================================================

  /** Create a one-to-one relation */
  oneToOne<G extends Getter>(getter: G): OneToOneRelation<G, State> {
    return new OneToOneRelation<G, State>(getter, this._state);
  }

  /** Create a many-to-one relation */
  manyToOne<G extends Getter>(getter: G): ManyToOneRelation<G, State> {
    return new ManyToOneRelation<G, State>(getter, this._state);
  }

  /** Create a one-to-many relation */
  oneToMany<G extends Getter>(getter: G): OneToManyRelation<G, State> {
    return new OneToManyRelation<G, State>(getter, this._state);
  }

  /** Create a many-to-many relation */
  manyToMany<G extends Getter>(getter: G): ManyToManyRelation<G> {
    return new ManyToManyRelation<G, State>(getter, this._state);
  }
}

/**
 * Relation builder entry point.
 * Always creates a fresh builder instance to avoid state pollution.
 *
 * @example
 * // Simple relation
 * posts: s.relation.oneToMany(() => post)
 *
 * // With FK config
 * author: s.relation.fields("authorId").references("id").manyToOne(() => user)
 *
 * // Optional relation
 * profile: s.relation.optional().oneToOne(() => profile)
 *
 * // Many-to-many with junction
 * tags: s.relation.through("post_tags").A("postId").B("tagId").manyToMany(() => tag)
 */
export const relation = new Proxy({} as RelationBuilderImpl<RelationState>, {
  get(_target, prop) {
    // Always create a fresh builder for each property access
    const builder = new RelationBuilderImpl<RelationState>({} as RelationState);
    const value = (builder as any)[prop];
    if (typeof value === "function") {
      return value.bind(builder);
    }
    return value;
  },
});

// =============================================================================
// HELPERS
// =============================================================================

export function generateJunctionTableName(
  model1: string,
  model2: string
): string {
  const names = [model1.toLowerCase(), model2.toLowerCase()].sort();
  return `${names[0]}_${names[1]}`;
}

export function generateJunctionFieldName(modelName: string): string {
  return `${modelName.toLowerCase()}Id`;
}

export function getJunctionTableName(
  relation: Relation<any, any, any>,
  sourceModelName: string,
  targetModelName: string
): string {
  return (
    relation["~"].through ||
    generateJunctionTableName(sourceModelName, targetModelName)
  );
}

export function getJunctionFieldNames(
  relation: Relation<any, any, any>,
  sourceModelName: string,
  targetModelName: string
): [string, string] {
  const sourceFieldName =
    relation["~"].throughA || generateJunctionFieldName(sourceModelName);
  const targetFieldName =
    relation["~"].throughB || generateJunctionFieldName(targetModelName);
  return [sourceFieldName, targetFieldName];
}

export type AnyRelation =
  | OneToOneRelation<any, any>
  | ManyToOneRelation<any, any>
  | OneToManyRelation<any, any>
  | ManyToManyRelation<any, any>;
