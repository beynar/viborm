// ManyToMany Relation Class (Standalone)
// For many-to-many relations with junction table configuration

import type { AnyModel } from "@schema/model";
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
  name<const N extends string>(name: N) {
    return new ManyToManyRelation<State & { name: N }>({
      ...this._state,
      name,
    });
  }

  /**
   * Internal accessor for state and source binding.
   */
  get "~"() {
    return {
      state: this._state,
      setSource: (source: AnyModel) => (this._state.source = source),
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a many-to-many relation
 */
export function manyToMany<const G>(
  getter: G
): G extends Getter
  ? ManyToManyRelation<{ type: "manyToMany"; getter: G }>
  : never;
export function manyToMany(getter: Getter) {
  return new ManyToManyRelation({ type: "manyToMany" as const, getter });
}
