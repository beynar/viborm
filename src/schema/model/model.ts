// Model Class Implementation
// Defines database models with fields and relations

import { isField, type Field } from "../fields/base";
import { type SchemaNames } from "../fields/common";
import { AnyRelation, Relation } from "../relation/relation";
import { getModelSchemas } from "./schemas";
import type {
  FieldRecord,
  ScalarFieldKeys as _ScalarFieldKeys,
  AnyModelState,
  DefaultModelState,
  CompoundConstraint,
  AnyCompoundConstraint,
} from "./types/helpers";

import { MergeDeep } from "type-fest";

// Re-export types from helpers for external use
export type {
  AnyModelState,
  DefaultModelState,
  ExtractFields,
  ExtractCompoundId,
  ExtractCompoundUniques,
  CompoundKeyName,
  CompoundConstraint,
  EffectiveKeyName,
} from "./types/helpers";

// Re-export ScalarFieldKeys for convenience
export type ScalarFieldKeys<T extends FieldRecord> = _ScalarFieldKeys<T> &
  string;

// =============================================================================
// TYPE INFERENCE HELPER
// =============================================================================

export interface ModelState {
  fields: FieldRecord;
  compoundId: CompoundConstraint<string[], string | undefined> | undefined;
  compoundUniques: CompoundConstraint<string[], string | undefined>[];
  tableName: string | undefined;
  indexes: IndexDefinition[];
  omit: string[];
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
  O extends IndexOptions = IndexOptions
> {
  fields: Keys;
  options: O;
}

export type UpdateIndexDefinition<
  State extends ModelState,
  Index extends IndexDefinition
> = [...State["indexes"], Index];

export const mergeIndexDefinitions = <
  State extends ModelState,
  Index extends IndexDefinition
>(
  state: State,
  index: Index
): UpdateIndexDefinition<State, Index> => {
  return [...state.indexes, index] as UpdateIndexDefinition<State, Index>;
};

export type UpdateCompoundUniques<
  State extends ModelState,
  CompoundUniques extends CompoundConstraint<string[], string | undefined>
> = [...State["compoundUniques"], CompoundUniques];

export const mergeCompoundUniques = <
  State extends ModelState,
  CompoundUniques extends CompoundConstraint<string[], string | undefined>
>(
  state: State,
  compoundUniques: CompoundUniques
): UpdateCompoundUniques<State, CompoundUniques> => {
  return [...state.compoundUniques, compoundUniques] as UpdateCompoundUniques<
    State,
    CompoundUniques
  >;
};

export type UpdateState<
  State extends ModelState,
  Update extends Partial<ModelState>
> = Omit<State, keyof Update> & Update;

export class Model<State extends ModelState> {
  private _names: SchemaNames = {};
  constructor(private state: State) {}

  /**
   * Maps the model to a specific database table name
   */
  map<Name extends string>(
    tableName: Name
  ): Model<UpdateState<State, { tableName: Name }>> {
    return new Model({ ...this.state, tableName });
  }

  omit<Keys extends ScalarFieldKeys<State["fields"]>[]>(
    ...keys: [...State["omit"], ...Keys]
  ): Model<UpdateState<State, { omit: [...State["omit"], ...Keys] }>> {
    return new Model({
      ...this.state,
      omit: this.state.omit.concat(keys) as [...State["omit"], ...Keys],
    });
  }

  index<
    const Keys extends ScalarFieldKeys<State["fields"]>[],
    O extends IndexOptions = IndexOptions
  >(
    fields: Keys,
    options: O = {} as O
  ): Model<
    UpdateState<
      State,
      { indexes: UpdateIndexDefinition<State, { fields; options }> }
    >
  > {
    return new Model({
      ...this.state,
      indexes: mergeIndexDefinitions(this.state, { fields, options }),
    });
  }

  id<
    Keys extends ScalarFieldKeys<State["fields"]>[],
    Name extends string | undefined = undefined
  >(
    fields: Keys,
    options?: { name?: Name }
  ): Model<UpdateState<State, { compoundId: CompoundConstraint<Keys, Name> }>> {
    return new Model({
      ...this.state,
      compoundId: { fields, name: options?.name } as CompoundConstraint<
        Keys,
        Name
      >,
    });
  }

  unique<
    Keys extends ScalarFieldKeys<State["fields"]>[],
    Name extends string | undefined = undefined
  >(
    fields: Keys,
    options?: { name?: Name }
  ): Model<
    UpdateState<
      State,
      {
        compoundUniques: UpdateCompoundUniques<
          State,
          CompoundConstraint<Keys, Name>
        >;
      }
    >
  > {
    return new Model({
      ...this.state,
      compoundUniques: mergeCompoundUniques(this.state, {
        fields,
        name: options?.name ?? Object.keys(fields).join("_"),
      }) as UpdateCompoundUniques<State, CompoundConstraint<Keys, Name>>,
    });
  }

  extends<ETFields extends FieldRecord>(
    fields: ETFields
  ): Model<UpdateState<State, { fields: State["fields"] & ETFields }>> {
    return new Model({
      ...this.state,
      fields: { ...this.state.fields, ...fields },
    });
  }

  get "~"() {
    return {
      state: this.state,
      schemas: getModelSchemas(this.state),
      names: this._names,
    };
  }
}

export const model = <const TFields extends FieldRecord>(
  fields: TFields
): Model<UpdateState<ModelState, { fields: TFields }>> =>
  new Model({
    compoundId: undefined,
    compoundUniques: [],
    tableName: undefined,
    indexes: [],
    omit: [],
    fields,
  });

export type AnyModel = Model<any>;
