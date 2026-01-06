// ManyToMany Relation Class (Standalone)
// For many-to-many relations with junction table configuration

import type { SchemaNames } from "../fields/common";
import { getRelationSchemas } from "./schemas";
import type {
  Getter,
  ManyToManyRelationState,
  ReferentialAction,
} from "./types";

// =============================================================================
// MANY-TO-MANY RELATION CLASS
// =============================================================================

/**
 * Relation class for many-to-many relations
 * Supports configuration for junction table name and field names
 *
 * @example
 * ```ts
 * // Simple - auto-generated junction table "post_tag"
 * const post = s.model({
 *   tags: s.manyToMany(() => tag),
 * });
 *
 * // With explicit junction table
 * const post = s.model({
 *   tags: s.manyToMany(() => tag).through("post_tags"),
 * });
 *
 * // With custom field names in junction table
 * const post = s.model({
 *   tags: s.manyToMany(() => tag)
 *     .through("post_tags")
 *     .A("postId")
 *     .B("tagId"),
 * });
 * ```
 */
export class ManyToManyRelation<State extends ManyToManyRelationState> {
  private readonly _state: State;
  private readonly _names: SchemaNames = {};
  private _schemas: ReturnType<typeof getRelationSchemas<State>> | undefined;

  constructor(state: State) {
    this._state = state;
  }

  /**
   * Specify the junction table name
   */
  through(tableName: string) {
    return new ManyToManyRelation<State & { through: string }>({
      ...this._state,
      through: tableName,
    });
  }

  /**
   * Specify the source field name in the junction table
   */
  A(fieldName: string) {
    return new ManyToManyRelation<State & { A: string }>({
      ...this._state,
      A: fieldName,
    });
  }

  /**
   * Specify the target field name in the junction table
   */
  B(fieldName: string) {
    return new ManyToManyRelation<State & { B: string }>({
      ...this._state,
      B: fieldName,
    });
  }

  /**
   * Specify the referential action when a related record is deleted
   */
  onDelete(action: ReferentialAction) {
    return new ManyToManyRelation<State & { onDelete: ReferentialAction }>({
      ...this._state,
      onDelete: action,
    });
  }

  /**
   * Specify the referential action when a related record's key is updated
   */
  onUpdate(action: ReferentialAction) {
    return new ManyToManyRelation<State & { onUpdate: ReferentialAction }>({
      ...this._state,
      onUpdate: action,
    });
  }

  /**
   * Set a custom name for this relation
   */
  name(name: string) {
    return new ManyToManyRelation<State & { name: string }>({
      ...this._state,
      name,
    });
  }

  /**
   * Internal accessor for state, schemas, and names
   */
  get "~"() {
    return {
      state: this._state,
      names: this._names,
      schemas: (this._schemas ??= getRelationSchemas(this._state)),
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a many-to-many relation
 */
export const manyToMany = <G extends Getter>(getter: G) => {
  return new ManyToManyRelation({ type: "manyToMany" as const, getter });
};
