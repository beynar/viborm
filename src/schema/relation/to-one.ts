// `s.toOne` — one of the two relation factories.
//
// The factory states the SLOT CARDINALITY (one) and its argument states the
// TARGET DOMAIN (one model, or named variants). Which endpoint owns a foreign
// key, whether the pair is one-to-one or many-to-one, and whether a model-target
// slot may be empty are DERIVED later by the full-schema topology owner.

import {
  type ExactVariantOptions,
  type NormalizedOneEntries,
  normalizeVariantEntries,
  type VariantGetterMap,
  type VariantMapGuard,
  type VariantOptions,
  type VariantToOneRelation,
  variantToOneTerminal,
} from "./polymorphic";
import {
  createTargetSettlement,
  normalizeFieldTuple,
  normalizeReferentialAction,
  normalizeRelationName,
  refuseRelationInput,
} from "./terminal";
import type {
  AnyRelation,
  ForeignKeyDeclaration,
  Getter,
  GetterOnly,
  ModelToOneState,
  NonEmptyFieldTuple,
  ReferentialAction,
  RelationInternal,
  Replace,
} from "./types";

// =============================================================================
// TERMINAL CAPABILITY SURFACE
// =============================================================================

/**
 * Referential actions exist only once a complete reference exists — they act on
 * a foreign key, and there is no foreign key to act on before
 * `.references(...)` completes the pair.
 */
type ForeignKeyActions<State> = {
  onDelete<const Action extends ReferentialAction>(
    action: Action
  ): ModelToOneRelation<
    State extends { readonly foreignKey: infer FK }
      ? Replace<
          State,
          { readonly foreignKey: Replace<FK, { onDelete: Action }> }
        >
      : State
  >;
  onUpdate<const Action extends ReferentialAction>(
    action: Action
  ): ModelToOneRelation<
    State extends { readonly foreignKey: infer FK }
      ? Replace<
          State,
          { readonly foreignKey: Replace<FK, { onUpdate: Action }> }
        >
      : State
  >;
};

type ModelToOneCapabilities<State> = {
  readonly "~": RelationInternal<State>;
  name<const Name extends string>(
    name: Name
  ): ModelToOneRelation<Replace<State, { readonly name: Name }>>;
  fields<const Fields extends NonEmptyFieldTuple>(
    ...fields: Fields
  ): ReferencesStage<State, Fields>;
};

/**
 * A model-target singular slot. It exposes no `.optional()`: emptiness follows
 * from the nullability of a complete local foreign-key tuple, and a non-owning
 * singular view is derived nullable.
 */
export type ModelToOneRelation<State> = ModelToOneCapabilities<State> &
  (State extends { readonly foreignKey: ForeignKeyDeclaration }
    ? ForeignKeyActions<State>
    : unknown);

/**
 * The transient value `.fields(...)` returns.
 *
 * It carries NO relation brand, so neither `ModelShape` nor any downstream
 * relation consumer can mistake an incomplete foreign key for trusted schema
 * state, and `s.model(...)` refuses it outright. It exposes only
 * `.references(...)` and `.name(...)`: a name must not be able to turn an
 * incomplete pair into schema truth.
 */
export type ReferencesStage<State, Fields extends NonEmptyFieldTuple> = {
  references<
    const References extends NonEmptyFieldTuple & {
      readonly length: Fields["length"];
    },
  >(
    ...references: References
  ): ModelToOneRelation<
    Replace<
      State,
      {
        readonly foreignKey: Replace<
          State extends { readonly foreignKey: infer FK } ? FK : unknown,
          { readonly fields: Fields; readonly references: References }
        >;
      }
    >
  >;
  name<const Name extends string>(
    name: Name
  ): ReferencesStage<Replace<State, { readonly name: Name }>, Fields>;
};

// =============================================================================
// PRIVATE TERMINALS
// =============================================================================

class ModelToOne {
  private readonly state: ModelToOneState;
  private readonly internal: RelationInternal<ModelToOneState>;

  constructor(state: ModelToOneState) {
    this.state = Object.freeze(state);
    this.internal = Object.freeze({
      state: this.state,
      settleTarget: createTargetSettlement(() => this.state.target.getter),
    });
  }

  name(name: string): ModelToOne {
    return new ModelToOne({
      ...this.state,
      name: normalizeRelationName("s.toOne", name),
    });
  }

  fields(...fields: string[]): PendingReferences {
    return new PendingReferences(
      this.state,
      normalizeFieldTuple("s.toOne", "fields", fields)
    );
  }

  onDelete(action: ReferentialAction): ModelToOne {
    return this.withForeignKeyAction("onDelete", action);
  }

  onUpdate(action: ReferentialAction): ModelToOne {
    return this.withForeignKeyAction("onUpdate", action);
  }

  /**
   * The type surface hides both action setters until `.references(...)` has
   * completed a foreign key. This refusal covers the route a type pin cannot:
   * a JavaScript caller placing a referential action on a slot that owns no
   * foreign key, where the action would otherwise have nowhere to be stored and
   * would be silently dropped.
   */
  private withForeignKeyAction(
    action: "onDelete" | "onUpdate",
    value: ReferentialAction
  ): ModelToOne {
    const foreignKey = this.state.foreignKey;
    if (foreignKey === undefined) {
      refuseRelationInput(
        "s.toOne",
        action,
        `'${action}' is available only after \`.fields(...).references(...)\` declares a foreign key`
      );
    }
    return new ModelToOne({
      ...this.state,
      foreignKey: Object.freeze({
        ...foreignKey,
        [action]: normalizeReferentialAction(action, value),
      }),
    });
  }

  get "~"(): RelationInternal<ModelToOneState> {
    return this.internal;
  }
}

/**
 * The transient references stage. It has no `"~"` accessor by design: that
 * absence is what makes an incomplete chain unusable as a model member.
 */
class PendingReferences {
  private readonly state: ModelToOneState;
  private readonly localFields: NonEmptyFieldTuple;

  constructor(state: ModelToOneState, localFields: NonEmptyFieldTuple) {
    this.state = state;
    this.localFields = localFields;
  }

  name(name: string): PendingReferences {
    return new PendingReferences(
      { ...this.state, name: normalizeRelationName("s.toOne", name) },
      this.localFields
    );
  }

  references(...references: string[]): ModelToOne {
    const referenced = normalizeFieldTuple("s.toOne", "references", references);
    if (referenced.length !== this.localFields.length) {
      refuseRelationInput(
        "s.toOne",
        "references",
        `\`.references(...)\` declares ${referenced.length} field(s) against ${this.localFields.length} local field(s); a foreign key pairs them positionally`
      );
    }
    // Completing a second stage replaces the pair atomically and preserves the
    // endpoint's name and referential actions; the prior terminal is untouched.
    const prior = this.state.foreignKey;
    const foreignKey: ForeignKeyDeclaration = {
      fields: this.localFields,
      references: referenced,
      ...(prior?.onDelete === undefined ? {} : { onDelete: prior.onDelete }),
      ...(prior?.onUpdate === undefined ? {} : { onUpdate: prior.onUpdate }),
    };
    return new ModelToOne({
      ...this.state,
      foreignKey: Object.freeze(foreignKey),
    });
  }
}

/**
 * Is this model member a transient references stage?
 *
 * Deliberately nominal: a stage is only ever produced by `.fields(...)`, so an
 * `instanceof` test cannot be spoofed by a look-alike record, and the
 * `s.model(...)` boundary can refuse the one member shape that would otherwise
 * be silently dropped.
 */
export function isReferencesStage(value: unknown): boolean {
  return value instanceof PendingReferences;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Declare a slot that holds AT MOST ONE membership.
 *
 * The map overload is declared first so a variant map is never swallowed by the
 * broad getter overload. Dispatch examines only the argument representation and
 * never invokes a getter.
 */
export function toOne<
  const Entries extends VariantGetterMap,
  const Options extends VariantOptions<Entries> | undefined = undefined,
>(
  variants: Entries & VariantMapGuard<Entries>,
  options?: Options & ExactVariantOptions<Options, Entries>
): VariantToOneRelation<{
  readonly kind: "relation";
  readonly cardinality: "one";
  readonly target: {
    readonly kind: "variants";
    readonly entries: NormalizedOneEntries<Entries>;
  };
}>;
export function toOne<const G>(getter: G & GetterOnly<G>): G extends Getter
  ? ModelToOneRelation<{
      readonly kind: "relation";
      readonly cardinality: "one";
      readonly target: { readonly kind: "model"; readonly getter: G };
    }>
  : never;
export function toOne(target: unknown, options?: unknown): AnyRelation {
  if (typeof target === "function") {
    // biome-ignore lint/complexity/noArguments: distinguishes omission from explicit undefined without changing the factory's public arity
    if (arguments.length > 1) {
      refuseRelationInput(
        "s.toOne",
        "options",
        "A model-target relation takes exactly one argument"
      );
    }
    return new ModelToOne({
      kind: "relation",
      cardinality: "one",
      target: { kind: "model", getter: target },
    });
  }
  return variantToOneTerminal({
    kind: "relation",
    cardinality: "one",
    target: {
      kind: "variants",
      entries: normalizeVariantEntries("s.toOne", target, options),
    },
  });
}
