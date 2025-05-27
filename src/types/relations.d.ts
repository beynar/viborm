export type RelationType = "one" | "many";
export interface CascadeOptions {
    onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
    onUpdate?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
}
export interface RelationConfig {
    type: RelationType;
    target: () => any;
    onField?: string;
    refField?: string;
    cascade?: CascadeOptions;
    junctionTable?: string;
    junctionField?: string;
}
export interface JunctionTableConfig {
    tableName: string;
    leftField: string;
    rightField: string;
    additionalFields?: Record<string, any>;
}
export interface RelationMetadata {
    type: RelationType;
    targetModel: string;
    onField?: string;
    refField?: string;
    cascade?: CascadeOptions;
    junctionTable?: string;
    junctionField?: string;
}
export interface RelationFilter<TModel> {
    is?: TModel | null;
    isNot?: TModel | null;
}
export interface ListRelationFilter<TModel> {
    every?: TModel;
    some?: TModel;
    none?: TModel;
}
export interface CreateNestedOneInput<TModel, TRelation> {
    create?: TModel;
    connectOrCreate?: {
        where: any;
        create: TModel;
    };
    connect?: any;
}
export interface CreateNestedManyInput<TModel, TRelation> {
    create?: TModel | TModel[];
    connectOrCreate?: {
        where: any;
        create: TModel;
    } | Array<{
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
        update: any;
        create: TModel;
    };
    connect?: any;
    update?: any;
    disconnect?: boolean;
    delete?: boolean;
}
export interface UpdateNestedManyInput<TModel, TRelation> {
    create?: TModel | TModel[];
    connectOrCreate?: {
        where: any;
        create: TModel;
    } | Array<{
        where: any;
        create: TModel;
    }>;
    upsert?: {
        where: any;
        update: any;
        create: TModel;
    } | Array<{
        where: any;
        update: any;
        create: TModel;
    }>;
    set?: any | any[];
    disconnect?: any | any[];
    delete?: any | any[];
    connect?: any | any[];
    update?: {
        where: any;
        data: any;
    } | Array<{
        where: any;
        data: any;
    }>;
    updateMany?: {
        where: any;
        data: any;
    } | Array<{
        where: any;
        data: any;
    }>;
    deleteMany?: any | any[];
}
export interface RelationOrderBy<TModel> {
    [key: string]: "asc" | "desc" | RelationOrderBy<any>;
}
export interface RelationOrderByWithCount<TModel> extends RelationOrderBy<TModel> {
    _count?: "asc" | "desc";
}
export interface RelationAggregateSelect {
    _count?: boolean | {
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
//# sourceMappingURL=relations.d.ts.map