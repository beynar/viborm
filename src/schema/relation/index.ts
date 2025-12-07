// Relation exports
export {
  Relation,
  ToOneRelation,
  OneToManyRelation,
  ManyToManyRelation,
  relation,
  oneToOne,
  oneToMany,
  manyToOne,
  manyToMany,
  generateJunctionTableName,
  generateJunctionFieldName,
  getJunctionTableName,
  getJunctionFieldNames,
  type AnyRelation,
} from "./relation";
export type {
  Getter,
  RelationType,
  ReferentialAction,
  RelationInternals,
} from "./relation";
export * from "./schemas";
