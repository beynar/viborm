// ToMany Relation Class (Standalone)
// For oneToMany relations - the inverse side with minimal configuration

import { getRelationSchemas } from "./schemas";
import type { Getter, ToManyRelationState } from "./types";

// =============================================================================
// TO-MANY RELATION CLASS
// =============================================================================

/**
 * Relation class for one-to-many relations (oneToMany)
 * This is the inverse side of a relationship - FK lives on the other model
 * Minimal configuration needed since it doesn't own the FK
 *
 * @example
 * ```ts
 * const user = s.model({
 *   posts: s.oneToMany(() => post),  // No config needed - FK is on post.authorId
 * });
 * ```
 */
export class ToManyRelation<State extends ToManyRelationState> {
  private readonly _state: State;
  private _schemas: ReturnType<typeof getRelationSchemas<State>> | undefined;

  constructor(state: State) {
    this._state = state;
  }

  /**
   * Set a custom name for this relation
   */
  name(name: string) {
    return new ToManyRelation<State & { name: string }>({
      ...this._state,
      name,
    });
  }

  /**
   * Internal accessor for state and schemas
   */
  get "~"() {
    return {
      state: this._state,
      schemas: (this._schemas ??= getRelationSchemas(this._state)),
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a one-to-many relation
 */
export const oneToMany = <G extends Getter>(getter: G) => {
  return new ToManyRelation({ type: "oneToMany" as const, getter });
};
