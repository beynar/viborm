// Model Class Implementation
// Defines database models with fields and relations

import { type Field } from "../fields/base";
import { type SchemaNames } from "../fields/common";
import { AnyRelation } from "../relation/relation";
import type { FieldRecord } from "./types/helpers";
import {
  ScalarFieldKeys,
  ScalarFields,
  extractScalarFields,
  extractRelationFields,
  extractUniqueFields,
  RelationFields,
  UniqueFields,
  CompoundConstraint,
  NameFromKeys,
  getNameFromKeys,
  StringKeyOf,
  ToString,
} from "./helper";
import { getModelSchemas } from "./schemas";
import v, { ObjectSchema, VibSchema } from "../../validation";
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
  omit: string[];
  scalars: Record<string, Field>;
  relations: Record<string, AnyRelation>;
  uniques: Record<string, Field>;
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

  omit<Keys extends StringKeyOf<State["scalars"]>[]>(
    ...keys: [...State["omit"], ...Keys]
  ): Model<UpdateState<State, { omit: [...State["omit"], ...Keys] }>> {
    return new Model({
      ...this.state,
      omit: this.state.omit.concat(keys) as [...State["omit"], ...Keys],
    });
  }

  index<
    const Keys extends StringKeyOf<State["scalars"]>[],
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
    const Keys extends StringKeyOf<State["scalars"]>[],
    Name extends string | undefined = undefined
  >(
    fields: Keys,
    options?: { name?: Name }
  ): Model<
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
  > {
    const name = getNameFromKeys(options?.name, fields);
    const fieldsRecord = fields.reduce((acc, fieldName) => {
      const field =
        fieldName in this.state.scalars
          ? this.state.scalars[fieldName]
          : undefined;
      if (field) {
        acc[fieldName] = field["~"].schemas.base;
      }
      return acc;
    }, {} as Record<string, VibSchema>);

    const compoundId = {
      [name]: v.object(fieldsRecord, { partial: false }),
    } as any;
    return new Model({ ...this.state, compoundId });
  }

  unique<
    const Keys extends StringKeyOf<State["scalars"]>[],
    Name extends string | undefined = undefined
  >(
    fields: Keys,
    options?: { name?: Name }
  ): Model<
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
  > {
    const name = getNameFromKeys(options?.name, fields);
    const fieldsRecord = fields.reduce((acc, fieldName) => {
      const field =
        fieldName in this.state.scalars
          ? this.state.scalars[fieldName]
          : undefined;
      if (field) {
        acc[fieldName] = field["~"].schemas.base;
      }
      return acc;
    }, {} as Record<string, VibSchema>);

    const compoundUniques = {
      [name]: v.object(fieldsRecord, { partial: false }),
    } as any;
    return new Model({ ...this.state, compoundUniques });
  }

  extends<ETFields extends FieldRecord>(
    fields: ETFields
  ): Model<
    UpdateState<
      State,
      {
        fields: State["fields"] & ETFields;
        scalars: ScalarFields<State["fields"] & ETFields>;
        relations: RelationFields<State["fields"] & ETFields>;
        uniques: UniqueFields<State["fields"] & ETFields>;
      }
    >
  > {
    return new Model({
      ...this.state,
      fields: { ...this.state.fields, ...fields },
      scalars: extractScalarFields(fields),
      relations: extractRelationFields(fields),
      uniques: extractUniqueFields(fields),
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
    }
  >
> =>
  new Model({
    compoundId: undefined,
    compoundUniques: undefined,
    tableName: undefined,
    indexes: [],
    omit: [],
    fields,
    scalars: extractScalarFields(fields),
    relations: extractRelationFields(fields),
    uniques: extractUniqueFields(fields),
  });

export type AnyModel = Model<any>;
