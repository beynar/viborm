import { Field } from "@schema/fields";
import { ZodMiniType, iso } from "zod/v4-mini";
import { Model } from "../model";
import { Schema } from "../../../client/types";

export type SchemaDefinition = {
  on: "scalar" | "relation" | "aggregate" | "logical" | "unique"; //
  onField?: (field: Field) => ZodMiniType;
  onModel?: (model: Model) => ZodMiniType;
};
type SchemaDefinitions = Record<string, SchemaDefinition>;

export const baseSchemas = {
  where: {
    on: "scalar",
    onField: (field: Field) => field["~"].schemas.filter,
  },
  whereUnique: {
    on: "unique",
    onField: (field: Field): ZodMiniType => {
      if (field["~"].state.isId || field["~"].state.isUnique) {
        return field["~"].schemas.filter as unknown as ZodMiniType;
      }
      return undefined;
    },
  },
} satisfies SchemaDefinitions;

const buildSchemas = (schema: Schema, schemaDefinitions: SchemaDefinitions) => {
  const schemas = Object.keys(schemaDefinitions).reduce((acc, key) => {
    acc[key] = undefined;
    return acc;
  }, {} as Record<string, ZodMiniType | undefined>);
  const models = Object.values(schema);
  // Schema is {
  //     [x: string]: Model<any>;
  // }

  // Type 'Schema' must have a '[Symbol.iterator]()' method that returns an iterator.ts(2488)

  // iterate over the orm schema and build the schemas for each model each field and each definition
  for (const model of models) {
    const fields = model["~"].fieldMap.values();
    for (const field of fields) {
      const isScalar = field["~"].state.isScalar;
      const isRelation = field["~"].state.isRelation;
      for (const definition of Object.values(schemaDefinitions)) {
        if (definition.on === "scalar") {
          schemas[definition.name] = definition.onField(field);
        }
      }
    }
  }
};
