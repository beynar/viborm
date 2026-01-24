// Lazy Model Schemas Class
// Builds operation and core schemas on-demand for performance optimization

import type { ModelState } from "../model";
import type { ModelArgs } from "./args";
import {
  getAggregateArgs,
  getCountArgs,
  getCreateArgs,
  getCreateManyArgs,
  getDeleteArgs,
  getDeleteManyArgs,
  getFindFirstArgs,
  getFindManyArgs,
  getFindUniqueArgs,
  getGroupByArgs,
  getUpdateArgs,
  getUpdateManyArgs,
  getUpsertArgs,
} from "./args";
import {
  type CompoundConstraintFilterSchema,
  type CompoundIdFilterSchema,
  type CreateSchema,
  getCompoundConstraintFilter,
  getCompoundIdFilter,
  getCreateSchema,
  getIncludeSchema,
  getNestedScalarCreate,
  getOrderBySchema,
  getRelationCreate,
  getRelationFilter,
  getRelationUpdate,
  getScalarCreate,
  getScalarFilter,
  getScalarUpdate,
  getSelectSchema,
  getUniqueFilter,
  getUpdateSchema,
  getWhereSchema,
  getWhereUniqueSchema,
  type IncludeSchema,
  type NestedScalarCreateSchema,
  type OrderBySchema,
  type RelationCreateSchema,
  type RelationFilterSchema,
  type RelationUpdateSchema,
  type ScalarCreateSchema,
  type ScalarFilterSchema,
  type ScalarUpdateSchema,
  type SelectSchema,
  type UniqueFilterSchema,
  type UpdateSchema,
  type WhereSchema,
  type WhereUniqueSchema,
} from "./core";

/**
 * Lazy args accessor that builds operation schemas on-demand.
 * Each operation schema is built only when first accessed and then cached.
 */
class LazyModelArgs<T extends ModelState> {
  private readonly schemas: ModelSchemas<T>;
  private readonly state: T;

  // Cached operation schemas
  private _findUnique?: ModelArgs<T>["findUnique"];
  private _findFirst?: ModelArgs<T>["findFirst"];
  private _findMany?: ModelArgs<T>["findMany"];
  private _create?: ModelArgs<T>["create"];
  private _createMany?: ModelArgs<T>["createMany"];
  private _update?: ModelArgs<T>["update"];
  private _updateMany?: ModelArgs<T>["updateMany"];
  private _delete?: ModelArgs<T>["delete"];
  private _deleteMany?: ModelArgs<T>["deleteMany"];
  private _upsert?: ModelArgs<T>["upsert"];
  private _count?: ModelArgs<T>["count"];
  private _aggregate?: ModelArgs<T>["aggregate"];
  private _groupBy?: ModelArgs<T>["groupBy"];

  constructor(schemas: ModelSchemas<T>, state: T) {
    this.schemas = schemas;
    this.state = state;
  }

  get findUnique() {
    return (this._findUnique ??= getFindUniqueArgs(this.schemas));
  }

  get findFirst() {
    return (this._findFirst ??= getFindFirstArgs(this.schemas));
  }

  get findMany() {
    return (this._findMany ??= getFindManyArgs(this.state, this.schemas));
  }

  get create() {
    return (this._create ??= getCreateArgs(this.schemas));
  }

  get createMany() {
    return (this._createMany ??= getCreateManyArgs(this.schemas));
  }

  get update() {
    return (this._update ??= getUpdateArgs(this.schemas));
  }

  get updateMany() {
    return (this._updateMany ??= getUpdateManyArgs(this.schemas));
  }

  get delete() {
    return (this._delete ??= getDeleteArgs(this.schemas));
  }

  get deleteMany() {
    return (this._deleteMany ??= getDeleteManyArgs(this.schemas));
  }

  get upsert() {
    return (this._upsert ??= getUpsertArgs(this.schemas));
  }

  get count() {
    return (this._count ??= getCountArgs(this.state, this.schemas));
  }

  get aggregate() {
    return (this._aggregate ??= getAggregateArgs(this.state, this.schemas));
  }

  get groupBy() {
    return (this._groupBy ??= getGroupByArgs(this.state, this.schemas));
  }
}

/**
 * Lazy model schemas class.
 * Builds core schemas and operation args on-demand for optimal performance.
 *
 * Instead of building all 28+ schemas upfront, each schema is built only
 * when first accessed and then cached for subsequent access.
 */
export class ModelSchemas<T extends ModelState> {
  private readonly state: T;

  // Cached core schemas (built on demand)
  private _scalarFilter?: ScalarFilterSchema<T>;
  private _uniqueFilter?: UniqueFilterSchema<T>;
  private _relationFilter?: RelationFilterSchema<T>;
  private _compoundIdFilter?: CompoundIdFilterSchema<T>;
  private _compoundConstraintFilter?: CompoundConstraintFilterSchema<T>;
  private _scalarCreate?: ScalarCreateSchema<T>;
  private _nestedScalarCreate?: NestedScalarCreateSchema<T>;
  private _relationCreate?: RelationCreateSchema<T>;
  private _scalarUpdate?: ScalarUpdateSchema<T>;
  private _relationUpdate?: RelationUpdateSchema<T>;
  private _where?: WhereSchema<T>;
  private _whereUnique?: WhereUniqueSchema<T>;
  private _create?: CreateSchema<T>;
  private _update?: UpdateSchema<T>;
  private _select?: SelectSchema<T>;
  private _include?: IncludeSchema<T>;
  private _orderBy?: OrderBySchema<T>;

  // Cached args accessor
  private _args?: LazyModelArgs<T>;

  constructor(state: T) {
    this.state = state;
  }

  // Core schema lazy getters
  get scalarFilter(): ScalarFilterSchema<T> {
    return (this._scalarFilter ??= getScalarFilter(this.state));
  }

  get uniqueFilter(): UniqueFilterSchema<T> {
    return (this._uniqueFilter ??= getUniqueFilter(this.state));
  }

  get relationFilter(): RelationFilterSchema<T> {
    return (this._relationFilter ??= getRelationFilter(this.state));
  }

  get compoundIdFilter(): CompoundIdFilterSchema<T> {
    return (this._compoundIdFilter ??= getCompoundIdFilter(this.state));
  }

  get compoundConstraintFilter(): CompoundConstraintFilterSchema<T> {
    return (this._compoundConstraintFilter ??= getCompoundConstraintFilter(
      this.state
    ));
  }

  get scalarCreate(): ScalarCreateSchema<T> {
    return (this._scalarCreate ??= getScalarCreate(this.state));
  }

  get nestedScalarCreate(): NestedScalarCreateSchema<T> {
    return (this._nestedScalarCreate ??= getNestedScalarCreate(this.state));
  }

  get relationCreate(): RelationCreateSchema<T> {
    return (this._relationCreate ??= getRelationCreate(this.state));
  }

  get scalarUpdate(): ScalarUpdateSchema<T> {
    return (this._scalarUpdate ??= getScalarUpdate(this.state));
  }

  get relationUpdate(): RelationUpdateSchema<T> {
    return (this._relationUpdate ??= getRelationUpdate(this.state));
  }

  get where(): WhereSchema<T> {
    return (this._where ??= getWhereSchema(this.state));
  }

  get whereUnique(): WhereUniqueSchema<T> {
    return (this._whereUnique ??= getWhereUniqueSchema(this.state));
  }

  get create(): CreateSchema<T> {
    return (this._create ??= getCreateSchema(this.state));
  }

  get update(): UpdateSchema<T> {
    return (this._update ??= getUpdateSchema(this.state));
  }

  get select(): SelectSchema<T> {
    return (this._select ??= getSelectSchema(this.state));
  }

  get include(): IncludeSchema<T> {
    return (this._include ??= getIncludeSchema(this.state));
  }

  get orderBy(): OrderBySchema<T> {
    return (this._orderBy ??= getOrderBySchema(this.state));
  }

  // Args accessor with lazy loading
  get args(): ModelArgs<T> {
    return (this._args ??= new LazyModelArgs(this, this.state)) as ModelArgs<T>;
  }
}
