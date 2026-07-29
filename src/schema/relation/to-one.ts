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
   * Specify the foreign key field(s) on this model.
   *
   * Bare `string`, NOT this model's scalar names, and it cannot be otherwise:
   * the relation is a member of the very object literal that defines the model,
   * so at the moment `.fields()` is called the sibling scalars have no type yet.
   * A typo is caught by `validateSchema` / `validateSchemaOrThrow` instead —
   * runtime, not the editor. Probed in
   * `tests/client/contextual-typing-gate.test.ts`.
   */
  fields<const T extends string[]>(...fields: T) {
    return new ToOneRelation<State & { fields: T }>({
      ...this._state,
      fields,
    });
  }

  /**
   * Specify the referenced field(s) on the target model.
   *
   * Also bare `string`, and this one is not obviously forced — the target IS
   * reachable, through `State["getter"]`. It was tried: constraining to
   * `State["getter"] extends () => infer M ? Extract<keyof M["~"]["state"]["scalars"], string> : string`
   * costs 123 type errors across the estate, because resolving the getter's
   * return type is exactly what `RelationState.getter` is typed `any` to avoid.
   * A self-referential relation is the clearest witness: in
   * `node: { parent: s.manyToOne(() => node).fields("parentId").references("id") }`
   * the target's scalars resolve to `never` while `node` is still being
   * inferred, so the correct `"id"` becomes a compile error; mutually-recursive
   * pairs collapse both consts to `any` the same way. Runtime schema validation
   * is the guard here too. Probed in
   * `tests/client/contextual-typing-gate.test.ts`.
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
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a one-to-one relation
 */
export function oneToOne<const G>(
  getter: G
): G extends Getter ? ToOneRelation<{ type: "oneToOne"; getter: G }> : never;
export function oneToOne(getter: Getter) {
  return new ToOneRelation({ type: "oneToOne" as const, getter });
}

/**
 * Create a many-to-one relation
 */
export function manyToOne<const G>(
  getter: G
): G extends Getter ? ToOneRelation<{ type: "manyToOne"; getter: G }> : never;
export function manyToOne(getter: Getter) {
  return new ToOneRelation({ type: "manyToOne" as const, getter });
}
