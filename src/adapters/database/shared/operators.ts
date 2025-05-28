// Operator system for WHERE clause generation in BaseORM adapters

import type { WhereClause } from "../../types.js";
import type { Sql } from "../../../sql/sql.js";
import sql, { raw } from "../../../sql/sql.js";

/**
 * Operator registry that maps logical operators to SQL generation functions
 */
export class OperatorRegistry {
  private operators = new Map<string, OperatorFunction>();

  constructor() {
    this.registerDefaultOperators();
  }

  /**
   * Register a custom operator
   */
  register(name: string, operator: OperatorFunction): void {
    this.operators.set(name, operator);
  }

  /**
   * Get an operator by name
   */
  get(name: string): OperatorFunction | undefined {
    return this.operators.get(name);
  }

  /**
   * Check if an operator exists
   */
  has(name: string): boolean {
    return this.operators.has(name);
  }

  /**
   * Get all registered operator names
   */
  getOperatorNames(): string[] {
    return Array.from(this.operators.keys());
  }

  /**
   * Register all default operators
   */
  private registerDefaultOperators(): void {
    // Comparison operators
    this.register("equals", createComparisonOperator("="));
    this.register("eq", createComparisonOperator("="));
    this.register("not_equals", createComparisonOperator("!="));
    this.register("ne", createComparisonOperator("!="));
    this.register("greater_than", createComparisonOperator(">"));
    this.register("gt", createComparisonOperator(">"));
    this.register("greater_than_or_equal", createComparisonOperator(">="));
    this.register("gte", createComparisonOperator(">="));
    this.register("less_than", createComparisonOperator("<"));
    this.register("lt", createComparisonOperator("<"));
    this.register("less_than_or_equal", createComparisonOperator("<="));
    this.register("lte", createComparisonOperator("<="));

    // Null checks
    this.register("is_null", createNullOperator(true));
    this.register("is_not_null", createNullOperator(false));

    // String operators
    this.register("contains", createLikeOperator("contains"));
    this.register("starts_with", createLikeOperator("start"));
    this.register("ends_with", createLikeOperator("end"));
    this.register("like", createLikeOperator("raw"));
    this.register("ilike", createILikeOperator());

    // Array operators
    this.register("in", createInOperator(false));
    this.register("not_in", createInOperator(true));

    // Range operators
    this.register("between", createBetweenOperator(false));
    this.register("not_between", createBetweenOperator(true));
  }
}

/**
 * Function signature for operator implementations
 */
export type OperatorFunction = (
  field: string,
  value: unknown,
  context: OperatorContext
) => Sql;

/**
 * Context provided to operator functions
 */
export interface OperatorContext {
  dialect: "postgres" | "mysql";
  escapeIdentifier: (name: string) => string;
}

// Default operator registry instance
export const defaultOperators = new OperatorRegistry();

/**
 * Generate SQL from a WHERE clause
 */
export function buildWhereClause(
  where: WhereClause,
  context: OperatorContext
): Sql {
  return processWhereClause(where, context);
}

/**
 * Process a WHERE clause recursively
 */
function processWhereClause(where: WhereClause, context: OperatorContext): Sql {
  // Handle logical operators (AND, OR, NOT)
  if (where.and && where.and.length > 0) {
    const conditions = where.and.map((condition) =>
      processWhereClause(condition, context)
    );
    return joinConditions(conditions, " AND ");
  }

  if (where.or && where.or.length > 0) {
    const conditions = where.or.map((condition) =>
      processWhereClause(condition, context)
    );
    const joined = joinConditions(conditions, " OR ");
    return sql`(${joined})`;
  }

  if (where.not) {
    const condition = processWhereClause(where.not, context);
    return sql`NOT (${condition})`;
  }

  // Handle field-level conditions
  if (where.field && where.operator) {
    const operator = defaultOperators.get(where.operator);
    if (!operator) {
      throw new Error(`Unknown operator: ${where.operator}`);
    }

    return operator(where.field, where.value, context);
  }

  throw new Error(
    "Invalid WHERE clause: must specify field/operator or logical operators"
  );
}

/**
 * Join multiple SQL conditions with a separator
 */
function joinConditions(conditions: Sql[], separator: string): Sql {
  if (conditions.length === 0) {
    return raw("");
  }

  if (conditions.length === 1) {
    return conditions[0]!;
  }

  // Build the template strings and values for joining
  const strings = [""];
  const values: Sql[] = [];

  for (let i = 0; i < conditions.length; i++) {
    if (i > 0) {
      strings[strings.length - 1] += separator;
    }
    values.push(conditions[i]!);
    strings.push("");
  }

  // Use the imported sql function to create the joined SQL
  return sql(strings as readonly string[], ...values);
}

// Operator factory functions

/**
 * Create a simple comparison operator (=, !=, >, <, etc.)
 */
function createComparisonOperator(sqlOperator: string): OperatorFunction {
  return (field: string, value: unknown, context: OperatorContext): Sql => {
    const escapedField = context.escapeIdentifier(field);
    return sql`${raw(escapedField)} ${raw(sqlOperator)} ${value}`;
  };
}

/**
 * Create a NULL check operator
 */
function createNullOperator(isNull: boolean): OperatorFunction {
  return (field: string, _value: unknown, context: OperatorContext): Sql => {
    const escapedField = context.escapeIdentifier(field);
    const operator = isNull ? "IS NULL" : "IS NOT NULL";
    return sql`${raw(escapedField)} ${raw(operator)}`;
  };
}

/**
 * Create a LIKE operator for string matching
 */
function createLikeOperator(
  mode: "contains" | "start" | "end" | "raw"
): OperatorFunction {
  return (field: string, value: unknown, context: OperatorContext): Sql => {
    if (typeof value !== "string") {
      throw new Error(
        `LIKE operator requires string value, got ${typeof value}`
      );
    }

    const escapedField = context.escapeIdentifier(field);
    let pattern: string;

    switch (mode) {
      case "contains":
        pattern = `%${escapeLikePattern(value)}%`;
        break;
      case "start":
        pattern = `${escapeLikePattern(value)}%`;
        break;
      case "end":
        pattern = `%${escapeLikePattern(value)}`;
        break;
      case "raw":
        pattern = value; // Use value as-is for raw LIKE
        break;
      default:
        throw new Error(`Invalid LIKE mode: ${mode}`);
    }

    return sql`${raw(escapedField)} LIKE ${pattern}`;
  };
}

/**
 * Create a case-insensitive LIKE operator (PostgreSQL ILIKE)
 */
function createILikeOperator(): OperatorFunction {
  return (field: string, value: unknown, context: OperatorContext): Sql => {
    if (typeof value !== "string") {
      throw new Error(
        `ILIKE operator requires string value, got ${typeof value}`
      );
    }

    const escapedField = context.escapeIdentifier(field);
    const pattern = `%${escapeLikePattern(value)}%`;

    if (context.dialect === "postgres") {
      return sql`${raw(escapedField)} ILIKE ${pattern}`;
    } else {
      // MySQL doesn't have ILIKE, use LOWER() with LIKE
      return sql`LOWER(${raw(escapedField)}) LIKE LOWER(${pattern})`;
    }
  };
}

/**
 * Create an IN operator for array matching
 */
function createInOperator(negate: boolean): OperatorFunction {
  return (field: string, value: unknown, context: OperatorContext): Sql => {
    if (!Array.isArray(value)) {
      throw new Error(`IN operator requires array value, got ${typeof value}`);
    }

    if (value.length === 0) {
      // Empty array - return condition that's always false/true
      return negate
        ? sql`1 = 1` // NOT IN ([]) is always true
        : sql`1 = 0`; // IN ([]) is always false
    }

    const escapedField = context.escapeIdentifier(field);
    const operator = negate ? "NOT IN" : "IN";

    // Create placeholders for the IN clause
    const placeholders = value.map(() => raw("?"));
    const inClause = joinConditions(placeholders, ", ");

    return sql`${raw(escapedField)} ${raw(operator)} (${inClause})`;
  };
}

/**
 * Create a BETWEEN operator for range matching
 */
function createBetweenOperator(negate: boolean): OperatorFunction {
  return (field: string, value: unknown, context: OperatorContext): Sql => {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error("BETWEEN operator requires array with exactly 2 values");
    }

    const [min, max] = value;
    const escapedField = context.escapeIdentifier(field);
    const operator = negate ? "NOT BETWEEN" : "BETWEEN";

    return sql`${raw(escapedField)} ${raw(operator)} ${min} AND ${max}`;
  };
}

// Utility functions

/**
 * Escape special characters in LIKE patterns
 */
function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, "\\$&");
}

/**
 * Validate operator name
 */
export function validateOperatorName(name: string): boolean {
  return /^[a-z_]+$/.test(name);
}

/**
 * Get operator information for debugging/documentation
 */
export function getOperatorInfo(name: string): OperatorInfo | undefined {
  const operatorInfoMap: Record<string, OperatorInfo> = {
    equals: {
      name: "equals",
      aliases: ["eq"],
      description: "Equal to value",
      valueType: "any",
    },
    not_equals: {
      name: "not_equals",
      aliases: ["ne"],
      description: "Not equal to value",
      valueType: "any",
    },
    greater_than: {
      name: "greater_than",
      aliases: ["gt"],
      description: "Greater than value",
      valueType: "comparable",
    },
    greater_than_or_equal: {
      name: "greater_than_or_equal",
      aliases: ["gte"],
      description: "Greater than or equal to value",
      valueType: "comparable",
    },
    less_than: {
      name: "less_than",
      aliases: ["lt"],
      description: "Less than value",
      valueType: "comparable",
    },
    less_than_or_equal: {
      name: "less_than_or_equal",
      aliases: ["lte"],
      description: "Less than or equal to value",
      valueType: "comparable",
    },
    is_null: {
      name: "is_null",
      aliases: [],
      description: "Field is NULL",
      valueType: "none",
    },
    is_not_null: {
      name: "is_not_null",
      aliases: [],
      description: "Field is not NULL",
      valueType: "none",
    },
    contains: {
      name: "contains",
      aliases: [],
      description: "String contains substring",
      valueType: "string",
    },
    starts_with: {
      name: "starts_with",
      aliases: [],
      description: "String starts with substring",
      valueType: "string",
    },
    ends_with: {
      name: "ends_with",
      aliases: [],
      description: "String ends with substring",
      valueType: "string",
    },
    like: {
      name: "like",
      aliases: [],
      description: "String matches LIKE pattern",
      valueType: "string",
    },
    ilike: {
      name: "ilike",
      aliases: [],
      description: "String matches LIKE pattern (case-insensitive)",
      valueType: "string",
    },
    in: {
      name: "in",
      aliases: [],
      description: "Value is in array",
      valueType: "array",
    },
    not_in: {
      name: "not_in",
      aliases: [],
      description: "Value is not in array",
      valueType: "array",
    },
    between: {
      name: "between",
      aliases: [],
      description: "Value is between two values",
      valueType: "array[2]",
    },
    not_between: {
      name: "not_between",
      aliases: [],
      description: "Value is not between two values",
      valueType: "array[2]",
    },
  };

  return operatorInfoMap[name];
}

export interface OperatorInfo {
  name: string;
  aliases: string[];
  description: string;
  valueType:
    | "any"
    | "string"
    | "number"
    | "comparable"
    | "array"
    | "array[2]"
    | "none";
}

/**
 * Create operator context for a specific database dialect
 */
export function createOperatorContext(
  dialect: "postgres" | "mysql",
  escapeIdentifier: (name: string) => string
): OperatorContext {
  return { dialect, escapeIdentifier };
}
