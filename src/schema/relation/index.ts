// Relation exports

export type { Getter, ReferentialAction, RelationType } from "./relation";
export {
  type AnyRelation,
  generateJunctionFieldName,
  generateJunctionTableName,
  getJunctionFieldNames,
  getJunctionTableName,
  manyToMany,
  manyToOne,
  oneToMany,
  oneToOne,
  Relation,
} from "./relation";
export * from "./schemas";
