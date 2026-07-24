// ToMany Relation Class (Standalone)
// For oneToMany relations - the inverse side with minimal configuration

import type { AnyModel } from "@schema/model";
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

  constructor(state: State) {
    this._state = state;
  }

  /**
   * Set a custom name for this relation
   */
  name<T extends string>(name: T) {
    return new ToManyRelation<State & { name: T }>({
      ...this._state,
      name,
    });
  }

  /**
   * Internal accessor for state and source binding.
   */
  private _internal?: {
    state: State;
    setSource: (source: AnyModel) => void;
  };

  get "~"() {
    return (this._internal ??= {
      state: this._state,
      setSource: (source: AnyModel) => {
        this._state.source = source;
      },
    });
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a one-to-many relation
 */
export function oneToMany<const G>(
  getter: G
): G extends Getter ? ToManyRelation<{ type: "oneToMany"; getter: G }> : never;
export function oneToMany(getter: Getter) {
  return new ToManyRelation({ type: "oneToMany" as const, getter });
}
