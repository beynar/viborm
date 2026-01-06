// ToOne Relation Class (Standalone)
// For oneToOne and manyToOne relations with chainable configuration API

import { getRelationSchemas } from "./schemas";
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
  private _schemas: ReturnType<typeof getRelationSchemas<State>> | undefined;

  constructor(state: State) {
    this._state = state;
  }

  /**
   * Specify the foreign key field(s) on this model
   */
  fields(...fields: string[]) {
    return new ToOneRelation<State & { fields: string[] }>({
      ...this._state,
      fields,
    });
  }

  /**
   * Specify the referenced field(s) on the target model
   */
  references(...refs: string[]) {
    return new ToOneRelation<State & { references: string[] }>({
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
  name(name: string) {
    return new ToOneRelation<State & { name: string }>({
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
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a one-to-one relation
 */
export const oneToOne = <G extends Getter>(getter: G) => {
  return new ToOneRelation({ type: "oneToOne" as const, getter });
};

/**
 * Create a many-to-one relation
 */
export const manyToOne = <G extends Getter>(getter: G) => {
  return new ToOneRelation({ type: "manyToOne" as const, getter });
};
