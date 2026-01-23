// Model Class Implementation
// Defines database models with fields and relations

import v, { type ObjectSchema, type VibSchema } from "@validation";
import type { Field } from "../fields/base";
import type { HydratedSchemaNames, SchemaNames } from "../fields/common";
import type { AnyRelation } from "../relation";
import {
  extractRelationFields,
  extractScalarFields,
  extractUniqueFields,
  type FieldRecord,
  getNameFromKeys,
  type NameFromKeys,
  type RelationFields,
  type ScalarFields,
  type StringKeyOf,
  type UniqueFields,
} from "./helper";
import { ModelSchemas } from "./schemas/model-schemas";
// Re-export types from helpers for external use

// =============================================================================
// TYPE INFERENCE HELPER
// =============================================================================

export interface ModelState {
  fields: FieldRecord;
  compoundId:
    | Record<string, ObjectSchema<Record<string, VibSchema>>>
    | undefined;
  compoundUniques:
    | Record<string, ObjectSchema<Record<string, VibSchema>>>
    | undefined;
  tableName: string | undefined;
  indexes: IndexDefinition[];
  omit: Record<string, true> | undefined;
  scalars: Record<string, Field>;
  relations: Record<string, AnyRelation>;
  uniques: Record<string, Field>;
}

/**
 * Internal accessor return type for Model["~"]
 * Explicit type annotation to avoid TS7056 (type too complex to serialize)
 */
export interface ModelInternal<T extends ModelState> {
  state: T;
  schemas: ModelSchemas<T>;
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
 * Name registry for fields and relations.
 * Maps field/relation keys to their resolved names (ts and sql).
 * This is populated during hydration.
 */
export interface NameRegistry {
  /** Field names: key -> {ts, sql} */
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
  // Using ModelSchemas<any> to avoid type incompatibility when model state is transformed
  private _schemas: ModelSchemas<any> | undefined;
  private _scalarFieldNames: string[] | undefined;
  private _scalarFieldSet: Set<string> | undefined;
  private _relationNames: string[] | undefined;
  private _relationSet: Set<string> | undefined;

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
        const field =
          fieldName in this.state.scalars
            ? this.state.scalars[fieldName]
            : undefined;
        if (field) {
          acc[fieldName] = field["~"].schemas.base;
        }
        return acc;
      },
      {} as Record<string, VibSchema>
    );

    const compoundId = {
      [name]: v.object(fieldsRecord, { partial: false }),
    } as any;
    return new Model({ ...this.state, compoundId }) as unknown as Model<
      UpdateState<
        State,
        {
          compoundId: {
            [K in Name extends undefined
              ? NameFromKeys<Keys>
              : Name]: ObjectSchema<{
              [K2 in Keys[number]]: State["scalars"][K2]["~"]["schemas"]["base"];
            }>;
          };
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
        const field =
          fieldName in this.state.scalars
            ? this.state.scalars[fieldName]
            : undefined;
        if (field) {
          acc[fieldName] = field["~"].schemas.base;
        }
        return acc;
      },
      {} as Record<string, VibSchema>
    );

    const compoundUniques = {
      [name]: v.object(fieldsRecord, { partial: false }),
    } as any;
    return new Model({ ...this.state, compoundUniques }) as unknown as Model<
      UpdateState<
        State,
        {
          compoundUniques: {
            [K in Name extends undefined
              ? NameFromKeys<Keys>
              : Name]: ObjectSchema<{
              [K2 in Keys[number]]: State["scalars"][K2]["~"]["schemas"]["base"];
            }>;
          };
        }
      >
    >;
  }

  extends<ETFields extends FieldRecord>(fields: ETFields) {
    const newFields = { ...this.state.fields, ...fields } as State["fields"] &
      ETFields;
    return new Model({
      ...this.state,
      fields: newFields,
      scalars: extractScalarFields(newFields),
      relations: extractRelationFields(newFields),
      uniques: extractUniqueFields(newFields),
    }) as unknown as Model<
      UpdateState<
        State,
        {
          fields: State["fields"] & ETFields;
          scalars: ScalarFields<State["fields"] & ETFields>;
          relations: RelationFields<State["fields"] & ETFields>;
          uniques: UniqueFields<State["fields"] & ETFields>;
        }
      >
    >;
  }

  get "~"(): ModelInternal<State> {
    // Capture model instance for use in getters
    const model = this;

    return {
      state: this.state,
      /** Cached model schemas (computed once on first access) */
      get schemas() {
        return (model._schemas ??= new ModelSchemas(
          model.state
        ) as ModelSchemas<State>);
      },
      names: this._names,
      nameRegistry: this._nameRegistry,
      /**
       * Get the resolved names for a field.
       * Throws if the schema has not been hydrated.
       */
      getFieldName: (key: string): HydratedSchemaNames => {
        const registered = model._nameRegistry.fields.get(key);
        if (registered) {
          return registered as HydratedSchemaNames;
        }
        throw new Error(`Field "${key}" not found in nameRegistry`);
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
  }
}

export const model = <TFields extends FieldRecord>(
  fields: TFields
): Model<
  UpdateState<
    ModelState,
    {
      fields: TFields;
      scalars: ScalarFields<TFields>;
      relations: RelationFields<TFields>;
      uniques: UniqueFields<TFields>;
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
    fields,
    scalars: extractScalarFields(fields),
    relations: extractRelationFields(fields),
    uniques: extractUniqueFields(fields),
  });

export type AnyModel = Model<any>;
