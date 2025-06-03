// Core adapter interfaces and types for VibORM

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
