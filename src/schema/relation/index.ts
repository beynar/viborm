// Relation exports
export {
  Relation,
  oneToOne,
  manyToOne,
  oneToMany,
  manyToMany,
  generateJunctionTableName,
  generateJunctionFieldName,
  getJunctionTableName,
  getJunctionFieldNames,
  type AnyRelation,
} from "./relation";
export type { Getter, RelationType, ReferentialAction } from "./relation";
export * from "./schemas";
