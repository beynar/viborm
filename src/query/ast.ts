// Query AST (Abstract Syntax Tree) for BaseORM
// Simplified, unified structure using BaseORM query language

import { Model } from "../schema/model";
import { BaseField } from "../schema/fields/base";
import { Relation } from "../schema/relation";
import { Operation } from "../types/client/operations/defintion";

// ================================
// Parser Error Types
// ================================

export class ParseError extends Error {
  constructor(
    message: string,
    public context?: {
      model?: string;
      field?: string;
      operation?: string;
      path?: string[];
    }
  ) {
    super(message);
    this.name = "ParseError";
  }
}

// ================================
// Base AST Node Types
// ================================

export interface ASTNode {
  type: string;
  location?: SourceLocation;
}

export interface SourceLocation {
  start: number;
  end: number;
  line?: number;
  column?: number;
}

// ================================
// Schema Reference Types
// ================================

export interface ModelReference {
  name: string;
  model: Model<any>;
}

export interface FieldReference {
  name: string;
  field: BaseField<any>;
  model: Model<any>;
}

export interface RelationReference {
  name: string;
  relation: Relation<any, any>;
  sourceModel: Model<any>;
  targetModel: Model<any>;
}

// ================================
// Root Query AST (Unified)
// ================================

export interface QueryAST extends ASTNode {
  type: "QUERY";
  operation: Operation;
  model: ModelReference;
  args: QueryArgsAST;
}

// ================================
// Unified Query Arguments
// ================================

export interface QueryArgsAST extends ASTNode {
  type: "QUERY_ARGS";
  where?: ConditionAST[];
  data?: DataAST[] | BatchDataAST; // Support both single and batch data operations
  select?: SelectionAST | AggregationAST; // Support both selection and aggregation
  include?: InclusionAST;
  orderBy?: OrderingAST[];
  groupBy?: GroupByAST[];
  having?: ConditionAST[];
  take?: number;
  skip?: number;
  cursor?: CursorAST; // Cursor-based pagination
  distinct?: string[];
}

// ================================
// Condition System (Unified WHERE)
// ================================

export interface ConditionAST extends ASTNode {
  type: "CONDITION";
  target: ConditionTarget;
  operator: ConditionOperator;
  value?: ValueAST | ValueAST[];
  nested?: ConditionAST[];
  logic?: "AND" | "OR";
  negated?: boolean;
}

export type ConditionTarget =
  | FieldConditionTarget
  | RelationConditionTarget
  | LogicalConditionTarget;

export interface FieldConditionTarget {
  type: "FIELD";
  field: FieldReference;
}

export interface RelationConditionTarget {
  type: "RELATION";
  relation: RelationReference;
  operation: "some" | "every" | "none" | "is" | "isNot";
}

export interface LogicalConditionTarget {
  type: "LOGICAL";
  operator: "AND" | "OR" | "NOT";
}

// Database-agnostic operators - adapters handle the specifics
export type ConditionOperator =
  // Basic comparison
  | "equals"
  | "not"
  | "in"
  | "notIn"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  // String operations
  | "contains"
  | "startsWith"
  | "endsWith"
  // Null checks
  | "isNull"
  | "isNotNull"
  // Array/List operations (BaseORM logical operations)
  | "has"
  | "hasEvery"
  | "hasSome"
  | "isEmpty"
  // JSON operations
  | "jsonPath"
  | "jsonContains"
  | "jsonStartsWith"
  | "jsonEndsWith"
  // Array JSON operations
  | "arrayContains"
  | "arrayStartsWith"
  | "arrayEndsWith"
  // Advanced JSON path operations (NEW)
  | "jsonPathExists"
  | "jsonPathEquals"
  | "jsonPathContains"
  | "jsonPathIn"
  | "jsonPathRegex"
  // Advanced array operations (NEW)
  | "arrayLength"
  | "arrayOverlaps"
  | "arrayContainedBy"
  | "arrayAny"
  | "arrayAll";

// ================================
// Selection System
// ================================

export interface SelectionAST extends ASTNode {
  type: "SELECTION";
  model: ModelReference;
  fields: SelectionFieldAST[];
}

export interface SelectionFieldAST extends ASTNode {
  type: "SELECTION_FIELD";
  field: FieldReference;
  include?: boolean;
  nested?: NestedSelectionAST;
}

export interface InclusionAST extends ASTNode {
  type: "INCLUSION";
  model: ModelReference;
  relations: InclusionRelationAST[];
}

export interface InclusionRelationAST extends ASTNode {
  type: "INCLUSION_RELATION";
  relation: RelationReference;
  include?: boolean;
  nested?: NestedSelectionAST;
}

export interface NestedSelectionAST extends ASTNode {
  type: "NESTED_SELECTION";
  relation: RelationReference;
  args?: QueryArgsAST;
}

// ================================
// Data Manipulation
// ================================

export interface DataAST extends ASTNode {
  type: "DATA";
  model: ModelReference;
  fields: DataFieldAST[];
}

export interface DataFieldAST extends ASTNode {
  type: "DATA_FIELD";
  target: DataTarget;
  operation: DataOperation;
  value?: ValueAST | ValueAST[];
}

export type DataTarget = FieldDataTarget | RelationDataTarget;

export interface FieldDataTarget {
  type: "FIELD";
  field: FieldReference;
}

export interface RelationDataTarget {
  type: "RELATION";
  relation: RelationReference;
}

export type DataOperation =
  // Basic operations
  | "set"
  // Numeric operations
  | "increment"
  | "decrement"
  | "multiply"
  | "divide"
  // Array operations (only set and push are currently supported)
  | "push"
  // Relation operations
  | "connect"
  | "disconnect"
  | "connectOrCreate"
  | "create"
  | "update"
  | "upsert"
  | "delete";

// ================================
// Ordering System
// ================================

export interface OrderingAST extends ASTNode {
  type: "ORDERING";
  target: OrderingTarget;
  direction: "asc" | "desc";
  nulls?: "first" | "last";
}

export type OrderingTarget =
  | FieldOrderingTarget
  | RelationOrderingTarget
  | AggregateOrderingTarget;

export interface FieldOrderingTarget {
  type: "FIELD";
  field: FieldReference;
}

export interface RelationOrderingTarget {
  type: "RELATION";
  relation: RelationReference;
  nested?: OrderingAST;
}

export interface AggregateOrderingTarget {
  type: "AGGREGATE";
  operation: "count" | "avg" | "sum" | "min" | "max";
  field?: FieldReference;
  relation?: RelationReference;
}

// ================================
// Value System
// ================================

export interface ValueAST extends ASTNode {
  type: "VALUE";
  value: unknown;
  valueType: BaseOrmValueType;
  isArray?: boolean; // Flag to indicate if this is an array of the base type
  options?: ValueOptionsAST;
}

export interface ValueOptionsAST {
  mode?: "insensitive"; // For string operations
  path?: string[]; // For JSON path operations (matches JsonFilter.path)
  // JSON filter operations (matching JsonFilter from filters.ts)
  string_contains?: string;
  string_starts_with?: string;
  string_ends_with?: string;
  array_contains?: any;
  array_starts_with?: any;
  array_ends_with?: any;
  // Array filter operations (for ListFilter)
  arrayOp?: "has" | "hasEvery" | "hasSome" | "isEmpty";
  // Special operation flags
  operation?: string; // For operations like "push"
  [key: string]: any; // Extensible for other options
}

export type BaseOrmValueType =
  | "string"
  | "boolean"
  | "int"
  | "bigInt"
  | "float"
  | "decimal"
  | "dateTime"
  | "json"
  | "blob"
  | "vector"
  | "enum"
  | "null";

// ================================
// Schema Registry
// ================================

export interface SchemaRegistry {
  models: Map<string, Model<any>>;
  getModel(name: string): Model<any> | undefined;
  getField(modelName: string, fieldName: string): BaseField<any> | undefined;
  getRelation(
    modelName: string,
    relationName: string
  ): Relation<any, any> | undefined;
  createModelReference(name: string): ModelReference;
  createFieldReference(modelName: string, fieldName: string): FieldReference;
  createRelationReference(
    modelName: string,
    relationName: string
  ): RelationReference;
}

export class DefaultSchemaRegistry implements SchemaRegistry {
  models = new Map<string, Model<any>>();

  registerModel(model: Model<any>): void {
    this.models.set(model.name, model);
  }

  getModel(name: string): Model<any> | undefined {
    return this.models.get(name);
  }

  getField(modelName: string, fieldName: string): BaseField<any> | undefined {
    const model = this.getModel(modelName);
    return model?.fields.get(fieldName);
  }

  getRelation(
    modelName: string,
    relationName: string
  ): Relation<any, any> | undefined {
    const model = this.getModel(modelName);
    return model?.relations.get(relationName);
  }

  createModelReference(name: string): ModelReference {
    const model = this.getModel(name);
    if (!model) {
      throw new Error(`Model '${name}' not found in schema registry`);
    }
    return { name, model };
  }

  createFieldReference(modelName: string, fieldName: string): FieldReference {
    const model = this.getModel(modelName);
    if (!model) {
      throw new Error(`Model '${modelName}' not found in schema registry`);
    }

    const field = model.fields.get(fieldName);
    if (!field) {
      throw new Error(`Field '${fieldName}' not found in model '${modelName}'`);
    }

    return { name: fieldName, field, model };
  }

  createRelationReference(
    modelName: string,
    relationName: string
  ): RelationReference {
    const model = this.getModel(modelName);
    if (!model) {
      throw new Error(`Model '${modelName}' not found in schema registry`);
    }

    const relation = model.relations.get(relationName);
    if (!relation) {
      throw new Error(
        `Relation '${relationName}' not found in model '${modelName}'`
      );
    }

    const targetModel = relation.targetModel;
    return {
      name: relationName,
      relation,
      sourceModel: model,
      targetModel,
    };
  }
}

// ================================
// AST Builder Interface
// ================================

export interface QueryBuilder {
  registry: SchemaRegistry;
  build(model: string, operation: Operation, args: any): QueryAST;
}

// ================================
// AST Utilities
// ================================

export interface ASTVisitor<T = void> {
  visitQuery?(node: QueryAST): T;
  visitCondition?(node: ConditionAST): T;
  visitSelection?(node: SelectionAST): T;
  visitInclusion?(node: InclusionAST): T;
  visitData?(node: DataAST): T;
  visitBatchData?(node: BatchDataAST): T;
  visitAggregation?(node: AggregationAST): T;
  visitGroupBy?(node: GroupByAST): T;
  visitCursor?(node: CursorAST): T;
  visitOrdering?(node: OrderingAST): T;
  visitValue?(node: ValueAST): T;
}

export interface ASTTransformer {
  transform(node: QueryAST): QueryAST;
  transformCondition(node: ConditionAST): ConditionAST;
  transformSelection(node: SelectionAST): SelectionAST;
  transformAggregation(node: AggregationAST): AggregationAST;
  transformData(node: DataAST): DataAST;
  transformBatchData(node: BatchDataAST): BatchDataAST;
  transformValue(node: ValueAST): ValueAST;
}

// ================================
// AST Validation
// ================================

export interface ASTValidator {
  validate(ast: QueryAST): ValidationResult;
  validateCondition(condition: ConditionAST): ValidationResult;
  validateData(data: DataAST): ValidationResult;
  validateBatchData(batchData: BatchDataAST): ValidationResult;
  validateAggregation(aggregation: AggregationAST): ValidationResult;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

// ================================
// Helper Functions
// ================================

export function createCondition(
  target: ConditionTarget,
  operator: ConditionOperator,
  value?: ValueAST | ValueAST[],
  options?: { logic?: "AND" | "OR"; negated?: boolean; nested?: ConditionAST[] }
): ConditionAST {
  const condition: ConditionAST = {
    type: "CONDITION",
    target,
    operator,
  };

  if (value !== undefined) {
    condition.value = value;
  }
  if (options?.logic !== undefined) {
    condition.logic = options.logic;
  }
  if (options?.negated !== undefined) {
    condition.negated = options.negated;
  }
  if (options?.nested !== undefined) {
    condition.nested = options.nested;
  }

  return condition;
}

export function createValue(
  value: unknown,
  valueType: BaseOrmValueType,
  options?: ValueOptionsAST & { isArray?: boolean }
): ValueAST {
  const valueNode: ValueAST = {
    type: "VALUE",
    value,
    valueType,
  };

  if (options?.isArray) {
    valueNode.isArray = true;
  }

  if (options && Object.keys(options).length > 0) {
    const { isArray, ...restOptions } = options;
    if (Object.keys(restOptions).length > 0) {
      valueNode.options = restOptions;
    }
  }

  return valueNode;
}

// ================================
// Aggregation System
// ================================

export interface AggregationAST extends ASTNode {
  type: "AGGREGATION";
  model: ModelReference;
  aggregations: AggregationFieldAST[];
}

export interface AggregationFieldAST extends ASTNode {
  type: "AGGREGATION_FIELD";
  operation: AggregationOperation;
  field?: FieldReference; // Optional for count operations
  alias?: string; // For custom naming
}

export type AggregationOperation = "_count" | "_avg" | "_sum" | "_min" | "_max";

export interface GroupByAST extends ASTNode {
  type: "GROUP_BY";
  field: FieldReference;
}

// ================================
// Batch Operations System
// ================================

export interface BatchDataAST extends ASTNode {
  type: "BATCH_DATA";
  model: ModelReference;
  operation: BatchOperation;
  items: DataAST[]; // Array of individual data operations
  options?: BatchOptionsAST;
}

export interface BatchOptionsAST {
  skipDuplicates?: boolean; // For createMany
  updateOnConflict?: boolean; // For upsert behavior
}

export type BatchOperation = "createMany" | "updateMany" | "deleteMany";

// ================================
// Cursor Pagination System
// ================================

export interface CursorAST extends ASTNode {
  type: "CURSOR";
  field: FieldReference;
  value: ValueAST;
  direction?: "forward" | "backward";
}

export function createAggregation(
  model: ModelReference,
  aggregations: AggregationFieldAST[]
): AggregationAST {
  return {
    type: "AGGREGATION",
    model,
    aggregations,
  };
}

export function createAggregationField(
  operation: AggregationOperation,
  field?: FieldReference,
  alias?: string
): AggregationFieldAST {
  const aggregationField: AggregationFieldAST = {
    type: "AGGREGATION_FIELD",
    operation,
  };

  if (field !== undefined) {
    aggregationField.field = field;
  }
  if (alias !== undefined) {
    aggregationField.alias = alias;
  }

  return aggregationField;
}

export function createBatchData(
  model: ModelReference,
  operation: BatchOperation,
  items: DataAST[],
  options?: BatchOptionsAST
): BatchDataAST {
  const batchData: BatchDataAST = {
    type: "BATCH_DATA",
    model,
    operation,
    items,
  };

  if (options !== undefined) {
    batchData.options = options;
  }

  return batchData;
}

export function createGroupBy(field: FieldReference): GroupByAST {
  return {
    type: "GROUP_BY",
    field,
  };
}

export function createCursor(
  field: FieldReference,
  value: ValueAST,
  direction?: "forward" | "backward"
): CursorAST {
  const cursor: CursorAST = {
    type: "CURSOR",
    field,
    value,
  };

  if (direction !== undefined) {
    cursor.direction = direction;
  }

  return cursor;
}

// ================================
// Upsert System (NEW)
// ================================

export interface UpsertAST extends ASTNode {
  type: "UPSERT";
  model: ModelReference;
  conflictTarget: ConflictTargetAST;
  createData: DataAST;
  updateData: DataAST;
  where?: ConditionAST[];
}

export interface ConflictTargetAST extends ASTNode {
  type: "CONFLICT_TARGET";
  target: ConflictTargetType;
}

export type ConflictTargetType =
  | FieldConflictTarget
  | IndexConflictTarget
  | ConstraintConflictTarget;

export interface FieldConflictTarget {
  type: "FIELD";
  fields: FieldReference[];
}

export interface IndexConflictTarget {
  type: "INDEX";
  indexName: string;
}

export interface ConstraintConflictTarget {
  type: "CONSTRAINT";
  constraintName: string;
}

// ================================
// Upsert Helper Functions (NEW)
// ================================

export function createUpsert(
  model: ModelReference,
  conflictTarget: ConflictTargetAST,
  createData: DataAST,
  updateData: DataAST,
  where?: ConditionAST[]
): UpsertAST {
  const upsert: UpsertAST = {
    type: "UPSERT",
    model,
    conflictTarget,
    createData,
    updateData,
  };

  if (where !== undefined) {
    upsert.where = where;
  }

  return upsert;
}

export function createConflictTarget(
  target: ConflictTargetType
): ConflictTargetAST {
  return {
    type: "CONFLICT_TARGET",
    target,
  };
}

export function createFieldConflictTarget(
  fields: FieldReference[]
): FieldConflictTarget {
  return {
    type: "FIELD",
    fields,
  };
}

export function createIndexConflictTarget(
  indexName: string
): IndexConflictTarget {
  return {
    type: "INDEX",
    indexName,
  };
}

export function createConstraintConflictTarget(
  constraintName: string
): ConstraintConflictTarget {
  return {
    type: "CONSTRAINT",
    constraintName,
  };
}

// ================================
// Enhanced Value Helper Functions (NEW)
// ================================

export function createJsonPathValue(
  value: unknown,
  path: string[],
  jsonOptions?: {
    string_contains?: string;
    string_starts_with?: string;
    string_ends_with?: string;
    array_contains?: any;
    array_starts_with?: any;
    array_ends_with?: any;
  }
): ValueAST {
  return {
    type: "VALUE",
    value,
    valueType: "json",
    options: {
      path,
      ...jsonOptions,
    },
  };
}

export function createArrayValue(
  value: unknown,
  baseType: BaseOrmValueType,
  arrayOptions?: {
    array_contains?: any;
    array_starts_with?: any;
    array_ends_with?: any;
  }
): ValueAST {
  const valueNode: ValueAST = {
    type: "VALUE",
    value,
    valueType: baseType,
  };

  if (arrayOptions) {
    valueNode.options = arrayOptions;
  }

  return valueNode;
}
