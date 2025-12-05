import { ZodMiniType } from "zod/v4-mini";
import { Model } from "./model";
import {
  getScalarFieldsNames,
  getUniqueFieldsNames,
  getSingularRelationFieldsNames,
  getPluralRelationFieldsNames,
} from "./utils";
import { Relation } from "@schema/relation";

export const parseScalarsCreationInput = (
  model: Model,
  input: Record<string, any>
) => {
  const scalars = getScalarFieldsNames(model);

  return scalars.reduce((acc, scalar) => {
    const field = model.fields.get(scalar)!;

    const validator = field["~createValidator"] as ZodMiniType;
    const result = validator.safeParse(input[scalar]);

    if (!result.success) {
      throw new Error(`Scalar ${scalar["~name"]} is not valid`);
    }

    Object.assign(acc, {
      [scalar]: result.data,
    });

    return acc;
  }, {});
};

export const parseCreateInput = (model: Model, input: Record<string, any>) => {
  // TODO ADD RELATIONS CREATE VALIDATION
  return parseScalarsCreationInput(model, input);
};

export const parseScalarsUpdateInput = (
  model: Model,
  input: Record<string, any>
) => {
  const scalars = getScalarFieldsNames(model);

  return scalars.reduce((acc, scalar) => {
    const field = model.fields.get(scalar)!;
    const validator = field["~updateValidator"] as ZodMiniType;
    const result = validator.safeParse(input[scalar]);

    if (!result.success) {
      throw new Error(`Scalar ${scalar} is not valid`);
    }

    Object.assign(acc, {
      [scalar]: result.data,
    });

    return acc;
  }, {});
};

export const parseUpdateInput = (model: Model, input: Record<string, any>) => {
  // TODO ADD RELATIONS UPDATE VALIDATION
  return parseScalarsUpdateInput(model, input);
};

export const parseScalarsFilterInput = (
  model: Model,
  input: Record<string, any>
) => {
  const scalars = getScalarFieldsNames(model);

  return scalars.reduce((acc, scalar) => {
    const field = model.fields.get(scalar)!;

    const validator = field["~filterValidator"] as ZodMiniType;
    const result = validator.safeParse(input[scalar]);

    if (!result.success) {
      throw new Error(`Scalar ${scalar} is not valid`);
    }

    Object.assign(acc, {
      [scalar]: result.data,
    });
    return acc;
  }, {});
};

export const parsePluralRelationsFilterInput = (
  model: Model,
  input: Record<string, any>
) => {
  const pluralRelations = getPluralRelationFieldsNames(model);

  return pluralRelations.reduce((acc, relationName) => {
    const relation = model.relations.get(relationName)! as Relation;
    // This will throw if the filter is not valid
    // The filter will look like a `some`/`every`/`none` WhereManyInput
    Object.assign(acc, {
      [relationName]: relation["~validate"]["nestedPlural"](
        input[relationName]
      ),
    });

    return acc;
  }, {});
};

export const parseSingularRelationsFilterInput = (
  model: Model,
  input: Record<string, any>
) => {
  const singularRelations = getSingularRelationFieldsNames(model);

  return singularRelations.reduce((acc, relationName) => {
    const relation = model.relations.get(relationName)! as Relation;
    // This will throw if the filter is not valid
    // The filter wiil look like a whereManyInput
    Object.assign(acc, {
      [relationName]: relation["~validate"]["nestedSingular"](
        input[relationName]
      ),
    });

    return acc;
  });
};

export const parseWhereManyInput = (
  model: Model,
  input: Record<string, any>
) => {
  const scalarsFilter = parseScalarsFilterInput(model, input);
  const pluralRelationsFilter = parsePluralRelationsFilterInput(model, input);
  const singularRelationsFilter = parseSingularRelationsFilterInput(
    model,
    input
  );

  return Object.assign(
    {},
    scalarsFilter,
    pluralRelationsFilter,
    singularRelationsFilter
  );
};

export const parseWhereUniqueInput = (
  model: Model,
  input: Record<string, any>
) => {
  const uniqueFields = getUniqueFieldsNames(model);

  return uniqueFields.reduce((acc, scalar) => {
    const field = model.fields.get(scalar)!;
    const validator = field["~baseValidator"] as ZodMiniType;

    const result = validator.safeParse(input[scalar]);
    if (!result.success) {
      throw new Error(`Field ${scalar} is not valid`);
    }

    Object.assign(acc, {
      [scalar]: result.data,
    });

    return acc;
  }, {});
};
