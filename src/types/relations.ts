// Relation Type Definitions
// Based on specification: readme/1.4_relation_class.md

// Relation types - following standard relational database patterns
export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";

// Legacy support for simpler relation types
export type SimplifiedRelationType = "one" | "many";

// Cascade options for relations
export type CascadeOptions = "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";

// Relation configuration
export interface RelationConfig {
  type: RelationType;
  target: () => any;
  onField?: string;
  refField?: string;
  cascade?: CascadeOptions;
  junctionTable?: string;
  junctionField?: string;
}

// Junction table configuration for many-to-many relations
export interface JunctionTableConfig {
  tableName: string;
  leftField: string;
  rightField: string;
  additionalFields?: Record<string, any>;
}

// Relation metadata for introspection
export interface RelationMetadata {
  type: RelationType;
  targetModel: string;
  onField?: string;
  refField?: string;
  cascade?: CascadeOptions;
  junctionTable?: string;
  junctionField?: string;
}

// Relation filter types
export interface RelationFilter<TModel> {
  is?: TModel | null;
  isNot?: TModel | null;
}

export interface ListRelationFilter<TModel> {
  every?: TModel;
  some?: TModel;
  none?: TModel;
}

// Nested relation operations for create/update
export interface CreateNestedOneInput<TModel, TRelation> {
  create?: TModel;
  connectOrCreate?: {
    where: any; // WhereUniqueInput for the related model
    create: TModel;
  };
  connect?: any; // WhereUniqueInput for the related model
}

export interface CreateNestedManyInput<TModel, TRelation> {
  create?: TModel | TModel[];
  connectOrCreate?:
    | {
        where: any;
        create: TModel;
      }
    | Array<{
        where: any;
        create: TModel;
      }>;
  connect?: any | any[];
}

export interface UpdateNestedOneInput<TModel, TRelation> {
  create?: TModel;
  connectOrCreate?: {
    where: any;
    create: TModel;
  };
  upsert?: {
    where: any;
    update: any; // UpdateInput for the related model
    create: TModel;
  };
  connect?: any;
  update?: any;
  disconnect?: boolean;
  delete?: boolean;
}

export interface UpdateNestedManyInput<TModel, TRelation> {
  create?: TModel | TModel[];
  connectOrCreate?:
    | {
        where: any;
        create: TModel;
      }
    | Array<{
        where: any;
        create: TModel;
      }>;
  upsert?:
    | {
        where: any;
        update: any;
        create: TModel;
      }
    | Array<{
        where: any;
        update: any;
        create: TModel;
      }>;
  set?: any | any[];
  disconnect?: any | any[];
  delete?: any | any[];
  connect?: any | any[];
  update?:
    | {
        where: any;
        data: any;
      }
    | Array<{
        where: any;
        data: any;
      }>;
  updateMany?:
    | {
        where: any;
        data: any;
      }
    | Array<{
        where: any;
        data: any;
      }>;
  deleteMany?: any | any[];
}

// Relation ordering
export interface RelationOrderBy<TModel> {
  [key: string]: "asc" | "desc" | RelationOrderBy<any>;
}

export interface RelationOrderByWithCount<TModel>
  extends RelationOrderBy<TModel> {
  _count?: "asc" | "desc";
}

// Aggregate relation operations
export interface RelationAggregateSelect {
  _count?:
    | boolean
    | {
        [key: string]: boolean;
      };
  _min?: {
    [key: string]: boolean;
  };
  _max?: {
    [key: string]: boolean;
  };
  _avg?: {
    [key: string]: boolean;
  };
  _sum?: {
    [key: string]: boolean;
  };
}
