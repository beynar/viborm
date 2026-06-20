// ToOne Relation Class (Standalone)
// For oneToOne and manyToOne relations with chainable configuration API

import type { AnyModel } from "@schema/model";
import type { Getter, ReferentialAction, ToOneRelationState } from "./types";

// =============================================================================
// TO-ONE RELATION CLASS
// =============================================================================

/**
 * Relation class for to-one relations (oneToOne, manyToOne)
 * Supports chainable configuration for FK fields, references, and referential actions
 *
 * @example
 * ```ts
 * // Simple relation
 * s.manyToOne(() => user)
 *
 * // With FK configuration
 * s.manyToOne(() => user)
 *   .fields("authorId")
 *   .references("id")
 *   .onDelete("cascade")
 *
 * // Optional relation
 * s.oneToOne(() => profile).optional()
 * ```
 */
export class ToOneRelation<State extends ToOneRelationState> {
  private readonly _state: State;

  constructor(state: State) {
    this._state = state;
  }

  /**
   * Specify the foreign key field(s) on this model
   */
  fields<const T extends string[]>(...fields: T) {
    return new ToOneRelation<State & { fields: T }>({
      ...this._state,
      fields,
    });
  }

  /**
   * Specify the referenced field(s) on the target model
   */
  references<const T extends string[]>(...refs: T) {
    return new ToOneRelation<State & { references: T }>({
      ...this._state,
      references: refs,
    });
  }

  /**
   * Mark this relation as optional (FK can be null)
   */
  optional() {
    return new ToOneRelation<State & { optional: true }>({
      ...this._state,
      optional: true,
    });
  }

  /**
   * Specify the referential action when the referenced record is deleted
   */
  onDelete(action: ReferentialAction) {
    return new ToOneRelation<State & { onDelete: ReferentialAction }>({
      ...this._state,
      onDelete: action,
    });
  }

  /**
   * Specify the referential action when the referenced record's key is updated
   */
  onUpdate(action: ReferentialAction) {
    return new ToOneRelation<State & { onUpdate: ReferentialAction }>({
      ...this._state,
      onUpdate: action,
    });
  }

  /**
   * Set a custom name for this relation
   */
  name<const T extends string>(name: T) {
    return new ToOneRelation<State & { name: T }>({
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
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a one-to-one relation
 */
export function oneToOne<const G>(
  getter: G
): G extends Getter
  ? ToOneRelation<{ type: "oneToOne"; getter: G }>
  : never;
export function oneToOne(getter: Getter) {
  return new ToOneRelation({ type: "oneToOne" as const, getter });
}

/**
 * Create a many-to-one relation
 */
export function manyToOne<const G>(
  getter: G
): G extends Getter
  ? ToOneRelation<{ type: "manyToOne"; getter: G }>
  : never;
export function manyToOne(getter: Getter) {
  return new ToOneRelation({ type: "manyToOne" as const, getter });
}
