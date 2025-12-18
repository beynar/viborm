// Relation Class Implementation
// Clean class hierarchy for different relation types

import { type AnyModel } from "../model";
import { type SchemaNames } from "../fields/common";
import { getRelationSchemas } from "./schemas";

export type Getter = () => AnyModel;
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
  State extends BaseRelationState,
  Update extends Partial<BaseRelationState>
> = State & Update;

export interface RelationState extends BaseRelationState {
  type: RelationType;
  // getter: Getter;
}
export interface BaseRelationState {
  fields?: string[];
  references?: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  optional?: boolean;
  through?: string;
  throughA?: string;
  throughB?: string;
}

// =============================================================================
// BASE RELATION (shared logic)
// =============================================================================

export class Relation<State extends RelationState, G extends Getter> {
  private _state: State;
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};
  private _getter: G;

  constructor(state: State, getter: G) {
    this._state = state;
    this._getter = getter;
  }

  get "~"() {
    return {
      getter: this._getter,
      state: this._state,
      names: this._names,
      schemas: getRelationSchemas(this._state),
    };
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

export class RelationBuilderImpl<State extends BaseRelationState> {
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
  oneToOne<G extends Getter>(getter: G) {
    return new Relation<RelationState & { type: "oneToOne" }, G>(
      { ...this._state, type: "oneToOne" },
      getter
    );
  }

  // /** Create a many-to-one relation */
  // manyToOne<G extends Getter>(getter: G) {
  //   return new Relation({ ...this._state, type: "manyToOne", getter });
  // }

  // /** Create a one-to-many relation */
  // oneToMany<G extends Getter>(getter: G) {
  //   return new Relation({ ...this._state, type: "oneToMany", getter });
  // }

  // /** Create a many-to-many relation */
  // manyToMany<G extends Getter>(getter: G) {
  //   return new Relation({
  //     ...this._state,
  //     type: "manyToMany",
  //     getter,
  //   });
  // }
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
  relation: Relation<RelationState, Getter>,
  sourceModelName: string,
  targetModelName: string
): string {
  return (
    relation["~"].state.through ||
    generateJunctionTableName(sourceModelName, targetModelName)
  );
}

export function getJunctionFieldNames(
  relation: Relation<RelationState, Getter>,
  sourceModelName: string,
  targetModelName: string
): [string, string] {
  const sourceFieldName =
    relation["~"].state.throughA || generateJunctionFieldName(sourceModelName);
  const targetFieldName =
    relation["~"].state.throughB || generateJunctionFieldName(targetModelName);
  return [sourceFieldName, targetFieldName];
}

export type AnyRelation = Relation<RelationState, Getter>;

export const newRelation = <State extends RelationState, G extends Getter>(
  getter: G,
  state: State
) => {
  return new Relation<State, G>(state, getter);
};
