// Core adapter interfaces and types for VibeORM

import type { Sql } from "../sql/sql.js";
import type { BaseField } from "../schema/fields/base.js";
import type { QueryAST } from "../query/ast.js";

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
  duration?: number;
}

// Database adapter interface - pure SQL generation from AST
export interface DatabaseAdapter {
  readonly dialect: "postgres" | "mysql";

  // AST to SQL translation - the core responsibility
  translateQuery(ast: QueryAST): Sql;

  // Type transformation using BaseField for rich type information
  transformToDatabase(value: unknown, field: BaseField): unknown;
  transformFromDatabase(value: unknown, field: BaseField): unknown;

  // Identifier escaping
  escapeIdentifier(identifier: string): string;

  // Optional: Query optimization (can modify AST before translation)
  optimizeAST?(ast: QueryAST): QueryAST;
}

// Provider adapter interface - connection management and execution
export interface ProviderAdapter {
  readonly databaseAdapter: DatabaseAdapter;

  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Query execution using AST
  executeQuery<T = unknown>(ast: QueryAST): Promise<QueryResult<T>>;

  // Raw SQL execution (for advanced use cases)
  executeSql<T = unknown>(query: Sql): Promise<QueryResult<T>>;

  // Transaction support
  transaction<T>(
    callback: (adapter: ProviderAdapter) => Promise<T>
  ): Promise<T>;

  // Health and monitoring
  healthCheck(): Promise<boolean>;
}

// Schema integration types (for query planning and relation resolution)
export interface SchemaContext {
  models: Map<string, ModelDefinition>;
  relations: Map<string, RelationDefinition>;
}

export interface ModelDefinition {
  name: string;
  table: string;
  fields: Map<string, FieldDefinition>;
  primaryKey: string[];
}

export interface FieldDefinition {
  name: string;
  field: BaseField; // Store the actual BaseField instance for rich type information
  nullable: boolean;
  defaultValue?: unknown;
  validation?: ValidationRule[];
}

export interface RelationDefinition {
  type: "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";
  from: {
    model: string;
    field: string;
  };
  to: {
    model: string;
    field: string;
  };
  through?: string; // For many-to-many relations
}

export interface ValidationRule {
  type: string;
  params?: Record<string, unknown>;
  message?: string;
}

// Error types for adapter operations
export type AdapterError =
  | ConnectionError
  | QueryError
  | ValidationError
  | SchemaError
  | ASTError;

export interface ConnectionError {
  type: "connection";
  code: string;
  message: string;
  cause?: Error;
}

export interface QueryError {
  type: "query";
  code: string;
  message: string;
  query?: string;
  parameters?: unknown[];
  cause?: Error;
}

export interface ValidationError {
  type: "validation";
  field: string;
  rule: string;
  message: string;
  value?: unknown;
}

export interface SchemaError {
  type: "schema";
  message: string;
  entity?: string;
  cause?: Error;
}

export interface ASTError {
  type: "ast";
  message: string;
  node?: string; // AST node type that caused the error
  cause?: Error;
}
