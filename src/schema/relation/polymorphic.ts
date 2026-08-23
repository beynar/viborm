// Variant target domains: the normalization owner and the two variant terminals.
//
// "Polymorphic" is not a relation family. It is the derived observation that a
// declaration's TARGET DOMAIN holds named variants instead of one model, which
// is why the two variant terminals are reached through the same `s.toOne` /
// `s.toMany` factories as the model-target ones. What is irreducibly different
// is the legal local configuration: a row-held variant to-one may be
// `.optional()` and owns no public foreign key, and a member-junction variant
// to-many names one junction per variant through an exact `.through(...)` map.

import type { Scalar } from "@schema/scalars/base";
import { isValidSchemaIdentifier } from "../identifier";
import {
  createTargetSettlement,
  declaredKeys,
  hasExactKeys,
  isPlainRecord,
  normalizeRelationName,
  type RelationBuilder,
  readCallerProperty,
  refuseRelationInput,
} from "./terminal";
import type {
  AnyRelation,
  Getter,
  RelationInternal,
  Replace,
  VariantEntry,
  VariantJunctionOverride,
  VariantManyEntry,
  VariantToManyState,
  VariantToOneState,
} from "./types";

/**
 * The stored-discriminator grammar. A stored value is written to a physical
 * column and read back by migrations and predicates, so it admits namespaced
 * and versioned spellings the public variant key does not.
 */
const STORED_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;

const THROUGH_ENTRY_KEYS = ["table", "source", "target"] as const;

// =============================================================================
// FACTORY-LEVEL TYPES
// =============================================================================

export type VariantGetterMap = Readonly<Record<string, Getter>>;

/**
 * The map overload's phantom refusal.
 *
 * It is NOT redundant with {@link GetterOnly}. With the map overload first and
 * an unconstrained getter overload second, a structurally-map argument that
 * fails this guard would otherwise fall through to the getter overload, whose
 * conditional return answers `never` — and `never` is assignable to a model
 * shape, so the refusal would disappear entirely. This guard uniquely owns
 * "structurally a map, but not a legal variant map"; `GetterOnly` uniquely owns
 * "not a map at all and not a getter".
 */
export type VariantMapGuard<Entries> = string extends keyof Entries
  ? {
      readonly "a variant map needs literal keys, not a string index signature": never;
    }
  : [keyof Entries] extends [never]
    ? { readonly "a variant map needs at least one variant": never }
    : unknown;

export type VariantOptions<Entries> = {
  readonly values: { readonly [Key in keyof Entries]: string };
};

/**
 * The whole options bag is exact, not only `values`: a NON-FRESH bag with a
 * sibling key beside `values` sails through excess-property checking, so the
 * unknown keys are refused structurally.
 */
export type ExactVariantOptions<Options, Entries> = Options extends undefined
  ? unknown
  : Record<Exclude<keyof Options, "values">, never> & {
      readonly values: Record<
        Exclude<
          keyof (Options extends { readonly values: infer Values }
            ? Values
            : never),
          keyof Entries
        >,
        never
      >;
    };

/**
 * Normalized entries carry the getter's exact type and a plain `string` stored
 * value: the stored discriminator is runtime storage, never a public result
 * discriminator, so carrying its literal would be a public type parameter no
 * consumer reads.
 */
export type NormalizedOneEntries<Entries> = {
  readonly [Key in keyof Entries]: {
    readonly getter: Entries[Key];
    readonly storedValue: string;
  };
};

export type NormalizedManyEntries<Entries> = {
  readonly [Key in keyof Entries]: {
    readonly getter: Entries[Key];
    readonly storedValue: string;
    readonly junction?: VariantJunctionOverride;
  };
};

type VariantEntriesOfState<State> = State extends {
  readonly target: { readonly entries: infer Entries };
}
  ? Entries
  : never;

type VariantThroughMap<Entries> = {
  readonly [Key in keyof Entries]: VariantJunctionOverride;
};

type ExactVariantThroughMap<Given, Entries> = Record<
  Exclude<keyof Given, keyof Entries>,
  never
> & {
  readonly [Key in keyof Given]: Record<
    Exclude<keyof Given[Key], keyof VariantJunctionOverride>,
    never
  >;
};

// =============================================================================
// TERMINAL CAPABILITY SURFACES
// =============================================================================

/** A slot that holds at most one membership across its variants. */
export type VariantToOneRelation<State> = {
  readonly "~": RelationInternal<State>;
  name<const Name extends string>(
    name: Name
  ): VariantToOneRelation<Replace<State, { readonly name: Name }>>;
  optional(): VariantToOneRelation<Replace<State, { readonly optional: true }>>;
};

/**
 * A slot that holds a collection across its variants. No `.optional()`: an
 * empty collection is already the empty case.
 */
export type VariantToManyRelation<State> = {
  readonly "~": RelationInternal<State>;
  name<const Name extends string>(
    name: Name
  ): VariantToManyRelation<Replace<State, { readonly name: Name }>>;
  through<
    const ThroughMap extends VariantThroughMap<VariantEntriesOfState<State>>,
  >(
    map: ThroughMap &
      ExactVariantThroughMap<ThroughMap, VariantEntriesOfState<State>>
  ): VariantToManyRelation<State>;
};

// =============================================================================
// NORMALIZATION
// =============================================================================

/**
 * Read the target map and its options ONCE, judge every structurally knowable
 * fact, and build the single normalized entry map. There is no separately
 * stored `targets`, `values` or `through` map to keep in sync.
 *
 * Every own property at both map levels is read exactly once here and pinned as
 * a plain value: a live accessor could otherwise answer validation with one
 * value and the storage builder with another. Reading a property's value does
 * not invoke a target thunk; getters are stored as functions and stay lazy.
 */
export function normalizeVariantEntries(
  builder: RelationBuilder,
  variants: unknown,
  options: unknown
): Readonly<Record<string, VariantEntry>> {
  if (!isPlainRecord(variants)) {
    refuseRelationInput(
      builder,
      "target",
      "A relation target is either `() => model` or a plain map of named `() => model` getters"
    );
  }
  const variantKeys = declaredKeys(variants);
  if (variantKeys.length === 0) {
    refuseRelationInput(
      builder,
      "target",
      "A variant map needs at least one variant"
    );
  }
  const storedValues = readStoredValues(builder, variantKeys, options);
  const entries: Record<string, VariantEntry> = {};
  for (const variantKey of variantKeys) {
    if (!isValidSchemaIdentifier(variantKey)) {
      refuseRelationInput(
        builder,
        `target.${variantKey}`,
        `Variant key '${variantKey}' is not a valid schema identifier`
      );
    }
    const getter = readCallerProperty(
      builder,
      variants,
      variantKey,
      `target.${variantKey}`
    );
    if (typeof getter !== "function") {
      refuseRelationInput(
        builder,
        `target.${variantKey}`,
        `Variant '${variantKey}' must be a lazy getter; write \`() => model\` rather than the model itself`
      );
    }
    entries[variantKey] = Object.freeze({
      getter,
      storedValue: storedValues[variantKey] ?? variantKey,
    });
  }
  return Object.freeze(entries);
}

/**
 * The stored discriminator per variant: each public key by default, or the
 * exact `values` bag when one is supplied. An explicit `undefined` is
 * equivalent to omission; `{}` is not, because it declares an options bag
 * without the one option it may carry.
 */
function readStoredValues(
  builder: RelationBuilder,
  variantKeys: readonly string[],
  options: unknown
): Record<string, string> {
  if (options === undefined) return {};
  if (!isPlainRecord(options)) {
    refuseRelationInput(
      builder,
      "options",
      "Relation options must be a plain `{ values }` record; omit the argument to use each variant key as its stored value"
    );
  }
  if (!hasExactKeys(declaredKeys(options), ["values"])) {
    refuseRelationInput(
      builder,
      "options",
      "Relation options carry exactly one key, `values`; omit the argument to use each variant key as its stored value"
    );
  }
  const values = readCallerProperty(
    builder,
    options,
    "values",
    "options.values"
  );
  if (!isPlainRecord(values)) {
    refuseRelationInput(
      builder,
      "options.values",
      "`values` must be a plain record keyed by every variant"
    );
  }
  const valueKeys = declaredKeys(values);
  if (!hasExactKeys(valueKeys, variantKeys)) {
    refuseRelationInput(
      builder,
      "options.values",
      `\`values\` must be exact over the variant keys ${renderKeys(variantKeys)}; it declares ${renderKeys(valueKeys)}`
    );
  }
  const storedValues: Record<string, string> = {};
  const claimed = new Set<string>();
  for (const variantKey of variantKeys) {
    const storedValue = readCallerProperty(
      builder,
      values,
      variantKey,
      `options.values.${variantKey}`
    );
    if (typeof storedValue !== "string" || !STORED_VALUE.test(storedValue)) {
      refuseRelationInput(
        builder,
        `options.values.${variantKey}`,
        `Stored value for variant '${variantKey}' must match the stored-discriminator grammar`
      );
    }
    if (claimed.has(storedValue)) {
      refuseRelationInput(
        builder,
        `options.values.${variantKey}`,
        `Stored value '${storedValue}' is declared for more than one variant`
      );
    }
    claimed.add(storedValue);
    storedValues[variantKey] = storedValue;
  }
  return storedValues;
}

function renderKeys(keys: readonly string[]): string {
  return `[${keys.map((key) => `'${key}'`).join(", ")}]`;
}

/**
 * Fold one member-junction override into each normalized entry. The outer map
 * is exact over the variants and every inner value is exact — the runtime
 * mirror of the `.through()` type contract, and the reason there is no second
 * `through` map to keep in sync with the entries.
 */
function foldMemberJunctions(
  entries: Readonly<Record<string, VariantEntry>>,
  through: unknown
): Readonly<Record<string, VariantManyEntry>> {
  const variantKeys = Object.keys(entries);
  if (!isPlainRecord(through)) {
    refuseRelationInput(
      "s.toMany",
      "through",
      "`.through()` takes a plain map keyed by every variant"
    );
  }
  if (!hasExactKeys(declaredKeys(through), variantKeys)) {
    refuseRelationInput(
      "s.toMany",
      "through",
      `\`.through()\` must be exact over the variant keys ${renderKeys(variantKeys)}`
    );
  }
  const folded: Record<string, VariantManyEntry> = {};
  for (const [variantKey, entry] of Object.entries(entries)) {
    const override = readCallerProperty(
      "s.toMany",
      through,
      variantKey,
      `through.${variantKey}`
    );
    folded[variantKey] = Object.freeze({
      ...entry,
      junction: readJunctionOverride(variantKey, override),
    });
  }
  return Object.freeze(folded);
}

function readJunctionOverride(
  variantKey: string,
  override: unknown
): VariantJunctionOverride {
  const path = `through.${variantKey}`;
  if (!isPlainRecord(override)) {
    refuseRelationInput(
      "s.toMany",
      path,
      `Member junction '${variantKey}' must be a plain \`{ table, source, target }\` record`
    );
  }
  const table = readCallerProperty(
    "s.toMany",
    override,
    "table",
    `${path}.table`
  );
  const source = readCallerProperty(
    "s.toMany",
    override,
    "source",
    `${path}.source`
  );
  const target = readCallerProperty(
    "s.toMany",
    override,
    "target",
    `${path}.target`
  );
  if (
    !hasExactKeys(declaredKeys(override), THROUGH_ENTRY_KEYS) ||
    typeof table !== "string" ||
    typeof source !== "string" ||
    typeof target !== "string"
  ) {
    refuseRelationInput(
      "s.toMany",
      path,
      `Member junction '${variantKey}' declares exactly \`table\`, \`source\` and \`target\`, all strings`
    );
  }
  return Object.freeze({ table, source, target });
}

// =============================================================================
// TERMINALS
// =============================================================================

/**
 * Private terminal machinery. None of the four terminal classes is exported
 * from its module, let alone from the package: callers see only the
 * capabilities the two factories return. The two constructor helpers below are
 * the whole cross-module surface.
 */
class VariantToOne {
  private readonly state: VariantToOneState;
  private readonly internal: RelationInternal<VariantToOneState>;

  constructor(state: VariantToOneState) {
    this.state = Object.freeze(state);
    this.internal = Object.freeze({
      state: this.state,
      settleTarget: createTargetSettlement((variantKey) =>
        readVariantGetter(this.state, variantKey)
      ),
    });
  }

  name(name: string): VariantToOne {
    return new VariantToOne({
      ...this.state,
      name: normalizeRelationName("s.toOne", name),
    });
  }

  optional(): VariantToOne {
    return new VariantToOne({ ...this.state, optional: true });
  }

  get "~"(): RelationInternal<VariantToOneState> {
    return this.internal;
  }
}

class VariantToMany {
  private readonly state: VariantToManyState;
  private readonly internal: RelationInternal<VariantToManyState>;

  constructor(state: VariantToManyState) {
    this.state = Object.freeze(state);
    this.internal = Object.freeze({
      state: this.state,
      settleTarget: createTargetSettlement((variantKey) =>
        readVariantGetter(this.state, variantKey)
      ),
    });
  }

  name(name: string): VariantToMany {
    return new VariantToMany({
      ...this.state,
      name: normalizeRelationName("s.toMany", name),
    });
  }

  through(map: unknown): VariantToMany {
    return new VariantToMany({
      ...this.state,
      target: {
        kind: "variants",
        entries: foldMemberJunctions(this.state.target.entries, map),
      },
    });
  }

  get "~"(): RelationInternal<VariantToManyState> {
    return this.internal;
  }
}

/** Construct the row-held variant terminal for `s.toOne`. */
export function variantToOneTerminal(state: VariantToOneState): AnyRelation {
  return new VariantToOne(state);
}

/** Construct the member-junction variant terminal for `s.toMany`. */
export function variantToManyTerminal(state: VariantToManyState): AnyRelation {
  return new VariantToMany(state);
}

function readVariantGetter(
  state: VariantToOneState | VariantToManyState,
  variantKey: string | undefined
): unknown {
  if (variantKey === undefined) return undefined;
  const entry = state.target.entries[variantKey];
  return entry === undefined ? undefined : entry.getter;
}

// =============================================================================
// RESOLVED VARIANT STORAGE COLUMN
// =============================================================================
// Resolution OUTPUT, not declaration state: one private column the variant
// row-storage owner derives, carried on the resolved edge and read by the
// serializer and the engine. The descriptors that used to sit beside it are
// gone — the resolved edge IS the topology, and a second copy of it on the
// model was a second answer to every question the edge already answers.

export interface PolymorphicStorageColumn {
  readonly name: string;
  readonly scalar: Scalar;
  readonly nullable: boolean;
}
