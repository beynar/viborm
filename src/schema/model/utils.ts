import { Field } from "../fields";
import { Model } from "./model";

export const getUniqueFields = <M extends Model>(model: M) => {
  return getUniqueFieldsNames(model).map(
    (field) => model.fields.get(field) as Field
  );
};

export const getScalarFields = <M extends Model>(model: M) => {
  return Array.from(model.fields.values());
};

export const getRelations = <M extends Model>(model: M) => {
  return Array.from(model.relations.values());
};

export const getSingularRelations = <M extends Model>(model: M) => {
  return Array.from(model.relations.values()).filter(
    (relation) =>
      relation["~relationType"] === "oneToOne" ||
      relation["~relationType"] === "manyToOne"
  );
};

export const getPluralRelations = <M extends Model>(model: M) => {
  return Array.from(model.relations.values()).filter(
    (relation) =>
      relation["~relationType"] === "oneToMany" ||
      relation["~relationType"] === "manyToMany"
  );
};

export const getScalarFieldsNames = <M extends Model>(model: M) => {
  return Array.from(model.fields.keys()) as string[];
};

export const getUniqueFieldsNames = <M extends Model>(model: M) => {
  let fields: string[] = [];
  for (const [name, field] of model.fields.entries()) {
    if (field["~isUnique"] || field["~isId"]) {
      fields.push(name);
    }
  }
  return fields;
};

export const getRelationalFieldsNames = <M extends Model>(model: M) => {
  return Array.from(model.relations.keys()) as string[];
};

export const getSingularRelationFieldsNames = <M extends Model>(model: M) => {
  return Array.from(model.relations.entries())
    .filter(
      ([relationName, relation]) =>
        relation["~relationType"] === "oneToOne" ||
        relation["~relationType"] === "manyToOne"
    )
    .map(([relationName]) => relationName);
};

export const getPluralRelationFieldsNames = <M extends Model>(model: M) => {
  return Array.from(model.relations.entries())
    .filter(
      ([relationName, relation]) =>
        relation["~relationType"] === "oneToMany" ||
        relation["~relationType"] === "manyToMany"
    )
    .map(([relationName]) => relationName);
};
