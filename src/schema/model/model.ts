// Model Class Implementation
// Defines database models with scalars and relations

import type { ObjectSchema, VibSchema } from "@validation";
import v from "@validation/primitives/v";
import { emptyRecord, put } from "../record";
import type { AnyRelation } from "../relation";
import type { Scalar } from "../scalars/base";
import type { HydratedSchemaNames, SchemaNames } from "../scalars/common";
import {
  extractRelationMap,
  extractScalarMap,
  extractUniqueScalarMap,
  getNameFromKeys,
  type ModelShape,
  type NameFromKeys,
  type RelationMap,
  type ScalarMap,
  type StringKeyOf,
  type UniqueScalarMap,
} from "./helper";
// Re-export types from helpers for external use

// =============================================================================
// TYPE INFERENCE HELPER
// =============================================================================

export interface ModelState {
  shape: ModelShape;
  compoundId:
    | Record<string, ObjectSchema<Record<string, VibSchema>>>
    | undefined;
  compoundUniques:
    | Record<string, ObjectSchema<Record<string, VibSchema>>>
    | undefined;
  tableName: string | undefined;
  indexes: IndexDefinition[];
  omit: Record<string, true> | undefined;
  scalars: Record<string, Scalar>;
  /** ONE canonical relation map, holding both target domains in shape order. */
  relations: Record<string, AnyRelation>;
  uniques: Record<string, Scalar>;
}

/**
 * Internal accessor return type for Model["~"]
 * Explicit type annotation to avoid TS7056 (type too complex to serialize)
 */
export interface ModelInternal<T extends ModelState> {
  state: T;
  names: SchemaNames;
  nameRegistry: {
    fields: Map<string, SchemaNames>;
    relations: Map<string, SchemaNames>;
  };
  getFieldName: (key: string) => HydratedSchemaNames;
  getRelationName: (key: string) => HydratedSchemaNames;
  /** Cached scalar field names (computed once on first access) */
  scalarFieldNames: string[];
  /** Cached scalar field Set for O(1) lookup (computed once on first access) */
  scalarFieldSet: Set<string>;
  /** Cached relation names (computed once on first access) */
  relationNames: string[];
  /** Cached relation Set for O(1) lookup (computed once on first access) */
  relationSet: Set<string>;
}

/**
 * The index kinds a schema may declare. The union is the whole of what any
 * dialect accepts, not what all of them accept — `validateIndexType` in
 * `migrations/drivers/base.ts` refuses each one on the dialects whose
 * `supportsIndexTypes` does not list it, by name, at push time.
 *
 * `fulltext` and `spatial` are here because MySQL's whole round trip already
 * exists and only this union could not spell it: the emitter writes the
 * `FULLTEXT`/`SPATIAL` prefix and refuses to combine either with `UNIQUE`
 * (`mysql/index.ts`), the introspection reads them back and normalizes MySQL's
 * `RTREE` to `spatial` (`mysql/introspect.ts`), the migration snapshot's
 * `IndexDef` already carries both (`migrations/types.ts`), and the capability
 * list already declares them. See Phase 10 item 6 in
 * `docs/architecture/query-performance-plan.md`.
 */
export type IndexType =
  | "btree"
  | "hash"
  | "gin"
  | "gist"
  | "fulltext"
  | "spatial";

export interface IndexOptions {
  name?: string;
  unique?: boolean;
  type?: IndexType;
  where?: string; // For partial indexes (PostgreSQL)
}

export interface IndexDefinition<
  Keys extends string[] = string[],
  O extends IndexOptions = IndexOptions,
> {
  fields: Keys;
  options: O;
}

/** A partial index cannot constrain rows excluded by its predicate. */
export function isTotalIndex(options: Pick<IndexOptions, "where">): boolean {
  return !options.where;
}

export type UpdateIndexDefinition<
  State extends ModelState,
  Index extends IndexDefinition,
> = [...State["indexes"], Index];

/** The name a compound `.id()` / `.unique()` constraint may be given. */
export interface CompoundKeyOptions {
  name?: string;
}

/**
 * An options bag that carries the surface's own keys and NOTHING else.
 *
 * A generic `O extends Options` is no guard on its own: when inference produces
 * a bag the constraint would reject, TypeScript CLAMPS `O` to the constraint and
 * only excess-property checking is left to catch the stray key — and that needs
 * a fresh object literal, so `.index(["a"], sharedIndexOptions)` sails through
 * with `uniqu: true` recorded as nothing at all. Demanding `never` for the
 * unknown keys refuses structurally instead, whatever the argument's freshness.
 * Same instrument as `UnknownOmitKeys` below.
 */
type ExactOptions<Given, Allowed> = Given &
  Record<Exclude<keyof Given, keyof Allowed>, never>;

/**
 * The constraint name: the caller's `name` when they gave one, otherwise the
 * underscore-joined field names. Read off the options bag rather than a separate
 * inferred parameter so that ONE type parameter carries the whole literal — the
 * parameter `ExactOptions` needs in order to see the unknown keys.
 */
type CompoundKeyName<
  Keys extends string[],
  O extends CompoundKeyOptions,
> = O extends { name: infer N extends string } ? N : NameFromKeys<Keys>;

export const mergeIndexDefinitions = <
  State extends ModelState,
  Index extends IndexDefinition,
>(
  state: State,
  index: Index
): UpdateIndexDefinition<State, Index> => {
  return [...state.indexes, index] as UpdateIndexDefinition<State, Index>;
};

export type UpdateState<
  State extends ModelState,
  Update extends Partial<ModelState>,
> = Omit<State, keyof Update> & Update;

/**
 * The keys a proposed `.omit()` names that this model does NOT have as a
 * scalar: the typos and the relation names.
 *
 * `Hidden` is inferred from the argument's own keys and is deliberately NOT
 * constrained to the scalar names. A constrained type parameter is no guard
 * here: when inference produces something the constraint rejects, TypeScript
 * silently CLAMPS the parameter to the constraint and only excess-property
 * checking — which needs a fresh object literal — is left to catch the bad
 * key. Anything non-fresh (`as const`, a spread, an annotated variable, a
 * widened `Record<string, true>`) then sails through and records a
 * hidden-column claim nobody wrote. Excluding the unknown keys and demanding
 * `never` for them refuses structurally instead, whatever the argument's
 * freshness, and a `never` the caller cannot produce is a compile error at the
 * offending key.
 *
 * Relations are absent from the accepted set because `State["scalars"]` is the
 * scalar half of the shape (`ScalarMap`), the same source `.index()` /
 * `.id()` / `.unique()` key off. Reading it never touches a relation's
 * `getter`, the member that must not be resolved while two model consts still
 * refer to each other (see `RelationState.getter`).
 */
type UnknownOmitKeys<Hidden extends string, State extends ModelState> = Exclude<
  Hidden,
  StringKeyOf<State["scalars"]>
>;

/**
 * This model's scalar names, each optionally flagged `true`.
 *
 * It carries NO refusal — `UnknownOmitKeys` does that — and it adds no
 * requirement, every key being optional. It is in the parameter for one
 * reason: an editor offers the keys of a CONCRETE contextual type, and
 * `Record<Hidden, true>` is not concrete until `Hidden` has been inferred from
 * the very literal being typed. Without this member `.omit({ ` autocompletes
 * the global scope; with it, the model's scalars.
 */
export type ModelOmitInput<State extends ModelState> = Partial<
  Record<StringKeyOf<State["scalars"]>, true>
>;

/**
 * Merge a new compound constraint into the existing record so repeated
 * .id()/.unique() calls accumulate instead of replacing each other.
 * Resolves to just `Added` when nothing was set yet.
 */
type MergeCompound<Existing, Added> = Added &
  (Existing extends Record<string, ObjectSchema<Record<string, VibSchema>>>
    ? Existing
    : unknown);

/**
 * Resolve compound-key members to their base schemas, refusing any name that
 * is not a scalar of the model AT THE DECLARING SITE. The typed surface
 * already refuses these names; this throw is the runtime backstop for
 * untyped callers and JSON documents (the document interpreter relocates it
 * onto the `ids[]`/`uniques[]` node that wrote it), and it must fire on the
 * rule-free paths (`serializeModels`, `generate`,
 * `push({ skipValidation: true })`) that never run the advisory rules. I003
 * keeps its own coverage: post-construction shape drift (`.extends()`
 * shadowing a key member) is invisible to this constructor.
 *
 * A module function rather than a `Model` method: adding members to the class
 * perturbs how TS compares mutually-recursive model instantiations.
 */
function compoundMembers(
  state: ModelState,
  fields: readonly string[],
  label: string
): Record<string, VibSchema> {
  const members = emptyRecord<VibSchema>();
  for (const fieldName of fields) {
    // `in` is exact here: both maps come from the extractors, which build
    // prototype-free records, so no key can resolve an inherited member.
    const scalar =
      fieldName in state.scalars ? state.scalars[fieldName] : undefined;
    if (!scalar) {
      throw new Error(
        fieldName in state.relations
          ? `${label} field '${fieldName}' is a relation and cannot be a key member`
          : `${label} field '${fieldName}' does not exist`
      );
    }
    put(members, fieldName, scalar["~"].state.base);
  }
  return members;
}

/**
 * Name registry for scalars and relations.
 * Maps scalar/relation keys to their resolved names (ts and sql).
 * This is populated during hydration.
 */
export interface NameRegistry {
  /** Scalar names: key -> {ts, sql} */
  fields: Map<string, SchemaNames>;
  /** Relation names: key -> {ts, sql} — one lane for both target domains */
  relations: Map<string, SchemaNames>;
}

export class Model<State extends ModelState> {
  // biome-ignore lint/style/useReadonlyClassProperties: <it is reassigned when hydrating schemas>
  private _names: SchemaNames = {};
  // biome-ignore lint/style/useReadonlyClassProperties: <it is reassigned when hydrating schemas>
  private _nameRegistry: NameRegistry = {
    fields: new Map(),
    relations: new Map(),
  };
  private readonly state: State;

  // Cached field metadata (lazily computed on first access)
  private _scalarFieldNames: string[] | undefined;
  private _scalarFieldSet: Set<string> | undefined;
  private _relationNames: string[] | undefined;
  private _relationSet: Set<string> | undefined;
  private _internal: ModelInternal<State> | undefined;

  constructor(state: State) {
    this.state = state;
  }

  /**
   * Maps the model to a specific database table name
   */
  map<Name extends string>(tableName: Name) {
    return new Model({ ...this.state, tableName }) as unknown as Model<
      UpdateState<State, { tableName: Name }>
    >;
  }

  /**
   * Hide scalars from every result of this model — the schema-level exclusion.
   *
   * Keyed to the model's own SCALARS, so a typo or a relation name is a
   * compile error instead of an `omit` that quietly hides nothing. That
   * matters more here than anywhere else the builder takes field names: this
   * is the spelling used for secrets, and a silently-ignored key is a leaked
   * column. The refusal is per KEY, not per call: `{ secret: true, tokne:
   * true }` fails on `tokne` even though `secret` is real — two secrets with
   * one misspelled is the realistic case, and it is exactly the case an
   * excess-property-only refusal would wave through (see `UnknownOmitKeys`).
   *
   * Every value must be `true`. `false` has no meaning here (model-level omit
   * only ever hides) and a flag that may be `undefined` hides nothing at
   * runtime — `projectableScalarNames` compares against `true` — so
   * `Record<Hidden, true>` refuses both rather than recording a claim the
   * runtime would not honor.
   *
   * The literal survives the round trip — `.omit({ secret: true })` carries
   * exactly `{ secret: true }` into the state, not a widened record — which is
   * what every downstream `keyof State["omit"]` reads. `Hidden` defaults to
   * `never` for the one call with nothing to infer from, `.omit({})`: a bare
   * `extends string` would fall back to `string` there and hand the state a
   * record keyed by every conceivable name.
   */
  omit<Hidden extends string = never>(
    items: Record<Hidden, true> &
      Record<UnknownOmitKeys<Hidden, State>, never> &
      ModelOmitInput<State>
  ) {
    return new Model({
      ...this.state,
      omit: items,
    }) as unknown as Model<UpdateState<State, { omit: Record<Hidden, true> }>>;
  }

  index<
    const Keys extends StringKeyOf<State["scalars"]>[],
    O extends IndexOptions = IndexOptions,
  >(
    fields: Keys,
    options: ExactOptions<O, IndexOptions> = {} as ExactOptions<O, IndexOptions>
  ) {
    return new Model({
      ...this.state,
      indexes: mergeIndexDefinitions(this.state, { fields, options }),
    }) as unknown as Model<
      UpdateState<
        State,
        { indexes: UpdateIndexDefinition<State, { fields; options }> }
      >
    >;
  }

  id<
    const Keys extends StringKeyOf<State["scalars"]>[],
    const O extends CompoundKeyOptions = Record<never, never>,
  >(fields: Keys, options?: ExactOptions<O, CompoundKeyOptions>) {
    const name = getNameFromKeys(options?.name, fields);
    const fieldsRecord = compoundMembers(this.state, fields, "Compound ID");

    const compoundId = {
      ...this.state.compoundId,
      [name]: v.object(fieldsRecord, { partial: false }),
    } as any;
    return new Model({ ...this.state, compoundId }) as unknown as Model<
      UpdateState<
        State,
        {
          compoundId: MergeCompound<
            State["compoundId"],
            {
              [K in CompoundKeyName<Keys, O>]: ObjectSchema<{
                [K2 in Keys[number]]: State["scalars"][K2]["~"]["state"]["base"];
              }>;
            }
          >;
        }
      >
    >;
  }

  unique<
    const Keys extends StringKeyOf<State["scalars"]>[],
    const O extends CompoundKeyOptions = Record<never, never>,
  >(fields: Keys, options?: ExactOptions<O, CompoundKeyOptions>) {
    const name = getNameFromKeys(options?.name, fields);
    const fieldsRecord = compoundMembers(this.state, fields, "Compound unique");

    const compoundUniques = {
      ...this.state.compoundUniques,
      [name]: v.object(fieldsRecord, { partial: false }),
    } as any;
    return new Model({ ...this.state, compoundUniques }) as unknown as Model<
      UpdateState<
        State,
        {
          compoundUniques: MergeCompound<
            State["compoundUniques"],
            {
              [K in CompoundKeyName<Keys, O>]: ObjectSchema<{
                [K2 in Keys[number]]: State["scalars"][K2]["~"]["state"]["base"];
              }>;
            }
          >;
        }
      >
    >;
  }

  extends<ETShape extends ModelShape>(shape: ETShape) {
    const newShape = { ...this.state.shape, ...shape } as State["shape"] &
      ETShape;
    return new Model({
      ...this.state,
      shape: newShape,
      scalars: extractScalarMap(newShape),
      relations: extractRelationMap(newShape),
      uniques: extractUniqueScalarMap(newShape),
    }) as unknown as Model<
      UpdateState<
        State,
        {
          shape: State["shape"] & ETShape;
          scalars: ScalarMap<State["shape"] & ETShape>;
          relations: RelationMap<State["shape"] & ETShape>;
          uniques: UniqueScalarMap<State["shape"] & ETShape>;
        }
      >
    >;
  }

  get "~"(): ModelInternal<State> {
    if (this._internal) {
      return this._internal;
    }
    // Capture model instance for use in getters
    const model = this;

    this._internal = {
      state: this.state,
      // getters so hydration after first access is still observed
      get names() {
        return model._names;
      },
      get nameRegistry() {
        return model._nameRegistry;
      },
      /**
       * Get the resolved names for a field.
       * Throws if the schema has not been hydrated.
       */
      getFieldName: (key: string): HydratedSchemaNames => {
        const registered = model._nameRegistry.fields.get(key);
        if (registered) {
          return registered as HydratedSchemaNames;
        }
        throw new Error(`Scalar "${key}" not found in nameRegistry`);
      },
      /**
       * Get the resolved names for a relation.
       * Throws if the schema has not been hydrated.
       */
      getRelationName: (key: string): HydratedSchemaNames => {
        const registered = model._nameRegistry.relations.get(key);
        if (registered) {
          return registered as HydratedSchemaNames;
        }
        throw new Error(`Relation "${key}" not found in nameRegistry`);
      },
      /** Cached scalar field names (computed once on first access) */
      get scalarFieldNames(): string[] {
        return (model._scalarFieldNames ??= Object.keys(model.state.scalars));
      },
      /** Cached scalar field Set for O(1) lookup (computed once on first access) */
      get scalarFieldSet(): Set<string> {
        return (model._scalarFieldSet ??= new Set(this.scalarFieldNames));
      },
      /** Cached relation names (computed once on first access) */
      get relationNames(): string[] {
        return (model._relationNames ??= Object.keys(model.state.relations));
      },
      /** Cached relation Set for O(1) lookup (computed once on first access) */
      get relationSet(): Set<string> {
        return (model._relationSet ??= new Set(this.relationNames));
      },
    };
    return this._internal;
  }
}

export const model = <TShape extends ModelShape>(
  shape: TShape
): Model<
  UpdateState<
    ModelState,
    {
      shape: TShape;
      scalars: ScalarMap<TShape>;
      relations: RelationMap<TShape>;
      uniques: UniqueScalarMap<TShape>;
      omit: undefined;
    }
  >
> =>
  new Model({
    compoundId: undefined,
    compoundUniques: undefined,
    tableName: undefined,
    indexes: [],
    omit: undefined,
    shape,
    scalars: extractScalarMap(shape),
    relations: extractRelationMap(shape),
    uniques: extractUniqueScalarMap(shape),
  });

export type AnyModel = Model<any>;

/**
 * SQL table name for a model: hydrated name, then .map() tableName, then
 * the given fallback.
 */
export function getTableName(model: AnyModel, fallback = "unknown"): string {
  return model["~"].names.sql ?? model["~"].state.tableName ?? fallback;
}

/**
 * SQL column name for a field, resolved through the model's nameRegistry
 * (supports field reuse across models) with .map() and field-name fallbacks.
 */
export function getColumnName(model: AnyModel, fieldName: string): string {
  return model["~"].getFieldName(fieldName).sql;
}
