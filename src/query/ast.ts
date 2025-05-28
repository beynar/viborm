// Query AST (Abstract Syntax Tree) for VibeORM
// Simplified, unified structure using VibeORM query language

import { Model } from "../schema/model";
import { BaseField } from "../schema/fields/base";
import { Relation } from "../schema/relation";
import { Operation } from "../types/client/operations/defintion";

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
  data?: DataAST[];
  select?: SelectionAST;
  include?: InclusionAST;
  orderBy?: OrderingAST[];
  groupBy?: string[];
  having?: ConditionAST[];
  take?: number;
  skip?: number;
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
  // Array/List operations (VibeORM logical operations)
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
  | "arrayEndsWith";

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
  // Array operations (logical - adapters handle implementation)
  | "push"
  | "pop"
  | "unshift"
  | "shift"
  | "remove"
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
  valueType: VibeOrmValueType;
  options?: ValueOptionsAST;
}

export interface ValueOptionsAST {
  mode?: "insensitive"; // For string operations
  path?: string[]; // For JSON operations
  [key: string]: any; // Extensible for other options
}

export type VibeOrmValueType =
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
  | "null"
  // Array types (adapters decide storage)
  | "array";

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
  visitOrdering?(node: OrderingAST): T;
  visitValue?(node: ValueAST): T;
}

export interface ASTTransformer {
  transform(node: QueryAST): QueryAST;
  transformCondition(node: ConditionAST): ConditionAST;
  transformSelection(node: SelectionAST): SelectionAST;
  transformData(node: DataAST): DataAST;
  transformValue(node: ValueAST): ValueAST;
}

// ================================
// AST Validation
// ================================

export interface ASTValidator {
  validate(ast: QueryAST): ValidationResult;
  validateCondition(condition: ConditionAST): ValidationResult;
  validateData(data: DataAST): ValidationResult;
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
  valueType: VibeOrmValueType,
  options?: ValueOptionsAST
): ValueAST {
  const valueNode: ValueAST = {
    type: "VALUE",
    value,
    valueType,
  };

  if (options !== undefined) {
    valueNode.options = options;
  }

  return valueNode;
}
