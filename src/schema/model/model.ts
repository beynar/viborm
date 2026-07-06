// Model Class Implementation
// Defines database models with scalars and relations

import v from "@validation/primitives/v";
import type { ObjectSchema, VibSchema } from "@validation";
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

export type IndexType = "btree" | "hash" | "gin" | "gist";

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

export type UpdateIndexDefinition<
  State extends ModelState,
  Index extends IndexDefinition,
> = [...State["indexes"], Index];

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
 * Merge a new compound constraint into the existing record so repeated
 * .id()/.unique() calls accumulate instead of replacing each other.
 * Resolves to just `Added` when nothing was set yet.
 */
type MergeCompound<Existing, Added> = Added &
  (Existing extends Record<string, ObjectSchema<Record<string, VibSchema>>>
    ? Existing
    : unknown);

/**
 * Name registry for scalars and relations.
 * Maps scalar/relation keys to their resolved names (ts and sql).
 * This is populated during hydration.
 */
export interface NameRegistry {
  /** Scalar names: key -> {ts, sql} */
  fields: Map<string, SchemaNames>;
  /** Relation names: key -> {ts, sql} */
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

  omit<OmitItems extends Record<string, true>>(items: OmitItems) {
    return new Model({
      ...this.state,
      omit: items,
    }) as unknown as Model<UpdateState<State, { omit: OmitItems }>>;
  }

  index<
    const Keys extends StringKeyOf<State["scalars"]>[],
    O extends IndexOptions = IndexOptions,
  >(fields: Keys, options: O = {} as O) {
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
    Name extends string | undefined = undefined,
  >(fields: Keys, options?: { name?: Name }) {
    const name = getNameFromKeys(options?.name, fields);
    const fieldsRecord = fields.reduce(
      (acc, fieldName) => {
        const scalar =
          fieldName in this.state.scalars
            ? this.state.scalars[fieldName]
            : undefined;
        if (scalar) {
          acc[fieldName] = scalar["~"].state.base;
        }
        return acc;
      },
      {} as Record<string, VibSchema>
    );

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
              [K in Name extends undefined
                ? NameFromKeys<Keys>
                : Name]: ObjectSchema<{
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
    Name extends string | undefined = undefined,
  >(fields: Keys, options?: { name?: Name }) {
    const name = getNameFromKeys(options?.name, fields);
    const fieldsRecord = fields.reduce(
      (acc, fieldName) => {
        const scalar =
          fieldName in this.state.scalars
            ? this.state.scalars[fieldName]
            : undefined;
        if (scalar) {
          acc[fieldName] = scalar["~"].state.base;
        }
        return acc;
      },
      {} as Record<string, VibSchema>
    );

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
              [K in Name extends undefined
                ? NameFromKeys<Keys>
                : Name]: ObjectSchema<{
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
