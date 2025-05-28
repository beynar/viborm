// PostgreSQL database adapter implementation

import type { DatabaseAdapter } from "../../types.js";
import type { Sql } from "../../../sql/sql.js";
import type { BaseField } from "../../../schema/fields/base.js";
import type {
  QueryAST,
  SelectAST,
  InsertAST,
  UpdateAST,
  DeleteAST,
  ExpressionAST,
  SelectFieldAST,
  OrderByAST,
  JoinAST,
  FromClauseAST,
} from "../../../query/ast.js";
import sql, { raw, join, bulk } from "../../../sql/sql.js";

export class PostgresAdapter implements DatabaseAdapter {
  readonly dialect = "postgres" as const;

  /**
   * Translate AST to PostgreSQL SQL
   */
  translateQuery(ast: QueryAST): Sql {
    switch (ast.type) {
      case "SELECT":
        return this.translateSelect(ast);
      case "INSERT":
        return this.translateInsert(ast);
      case "UPDATE":
        return this.translateUpdate(ast);
      case "DELETE":
        return this.translateDelete(ast);
      default:
        throw new Error(`Unsupported query type: ${(ast as any).type}`);
    }
  }

  /**
   * Translate SELECT AST to PostgreSQL SQL
   */
  private translateSelect(ast: SelectAST): Sql {
    let query = sql`SELECT`;

    // DISTINCT
    if (ast.distinct) {
      query = sql`${query} DISTINCT`;
    }

    // Fields
    const fields = this.translateSelectFields(ast.fields);
    query = sql`${query} ${fields}`;

    // FROM
    const fromClause = this.translateFromClause(ast.from);
    query = sql`${query} FROM ${fromClause}`;

    // JOINs
    if (ast.joins && ast.joins.length > 0) {
      for (const joinAst of ast.joins) {
        const joinClause = this.translateJoin(joinAst);
        query = sql`${query} ${joinClause}`;
      }
    }

    // WHERE
    if (ast.where) {
      const whereClause = this.translateExpression(ast.where);
      query = sql`${query} WHERE ${whereClause}`;
    }

    // GROUP BY
    if (ast.groupBy && ast.groupBy.length > 0) {
      const groupByExpressions = ast.groupBy.map((expr) =>
        this.translateExpression(expr)
      );
      const groupByClause = join(groupByExpressions, ", ");
      query = sql`${query} GROUP BY ${groupByClause}`;
    }

    // HAVING
    if (ast.having) {
      const havingClause = this.translateExpression(ast.having);
      query = sql`${query} HAVING ${havingClause}`;
    }

    // ORDER BY
    if (ast.orderBy && ast.orderBy.length > 0) {
      const orderByExpressions = ast.orderBy.map((orderBy) =>
        this.translateOrderBy(orderBy)
      );
      const orderByClause = join(orderByExpressions, ", ");
      query = sql`${query} ORDER BY ${orderByClause}`;
    }

    // LIMIT
    if (ast.limit) {
      const limitValue = this.translateExpression(ast.limit.count);
      query = sql`${query} LIMIT ${limitValue}`;
    }

    // OFFSET
    if (ast.offset) {
      const offsetValue = this.translateExpression(ast.offset.count);
      query = sql`${query} OFFSET ${offsetValue}`;
    }

    return query;
  }

  /**
   * Translate INSERT AST to PostgreSQL SQL
   */
  private translateInsert(ast: InsertAST): Sql {
    let query = sql`INSERT INTO ${this.translateTable(ast.table)}`;

    // Fields (if specified)
    if (ast.fields && ast.fields.length > 0) {
      const fields = ast.fields.map((field) => this.translateColumn(field));
      const fieldsClause = join(fields, ", ");
      query = sql`${query} (${fieldsClause})`;
    }

    // VALUES or SELECT
    if (ast.values) {
      if (ast.values.type === "VALUES") {
        const valuesClause = this.translateValues(ast.values);
        query = sql`${query} ${valuesClause}`;
      } else {
        // INSERT ... SELECT
        const selectClause = this.translateSelect(ast.values);
        query = sql`${query} ${selectClause}`;
      }
    }

    // ON CONFLICT (PostgreSQL specific)
    if (ast.onConflict) {
      const conflictClause = this.translateOnConflict(ast.onConflict);
      query = sql`${query} ${conflictClause}`;
    }

    // RETURNING
    if (ast.returning && ast.returning.length > 0) {
      const returningFields = this.translateSelectFields(ast.returning);
      query = sql`${query} RETURNING ${returningFields}`;
    }

    return query;
  }

  /**
   * Translate UPDATE AST to PostgreSQL SQL
   */
  private translateUpdate(ast: UpdateAST): Sql {
    let query = sql`UPDATE ${this.translateTable(ast.table)}`;

    // SET clauses
    const setExpressions = ast.sets.map((setClause) => {
      const column = this.translateColumn(setClause.column);
      const value = this.translateExpression(setClause.value);
      return sql`${column} = ${value}`;
    });
    const setClause = join(setExpressions, ", ");
    query = sql`${query} SET ${setClause}`;

    // FROM (PostgreSQL supports FROM in UPDATE)
    if (ast.from) {
      const fromClause = this.translateFromClause(ast.from);
      query = sql`${query} FROM ${fromClause}`;
    }

    // JOINs
    if (ast.joins && ast.joins.length > 0) {
      for (const joinAst of ast.joins) {
        const joinClause = this.translateJoin(joinAst);
        query = sql`${query} ${joinClause}`;
      }
    }

    // WHERE
    if (ast.where) {
      const whereClause = this.translateExpression(ast.where);
      query = sql`${query} WHERE ${whereClause}`;
    }

    // RETURNING
    if (ast.returning && ast.returning.length > 0) {
      const returningFields = this.translateSelectFields(ast.returning);
      query = sql`${query} RETURNING ${returningFields}`;
    }

    return query;
  }

  /**
   * Translate DELETE AST to PostgreSQL SQL
   */
  private translateDelete(ast: DeleteAST): Sql {
    let query = sql`DELETE FROM ${this.translateTable(ast.from)}`;

    // USING (PostgreSQL supports USING in DELETE)
    if (ast.using) {
      const usingClause = this.translateFromClause(ast.using);
      query = sql`${query} USING ${usingClause}`;
    }

    // WHERE
    if (ast.where) {
      const whereClause = this.translateExpression(ast.where);
      query = sql`${query} WHERE ${whereClause}`;
    }

    // RETURNING
    if (ast.returning && ast.returning.length > 0) {
      const returningFields = this.translateSelectFields(ast.returning);
      query = sql`${query} RETURNING ${returningFields}`;
    }

    return query;
  }

  /**
   * Translate expression AST to SQL
   */
  private translateExpression(ast: ExpressionAST): Sql {
    switch (ast.type) {
      case "COLUMN":
        return this.translateColumn(ast);
      case "LITERAL":
        return this.translateLiteral(ast);
      case "PARAMETER":
        return this.translateParameter(ast);
      case "BINARY_OPERATION":
        return this.translateBinaryOperation(ast);
      case "UNARY_OPERATION":
        return this.translateUnaryOperation(ast);
      case "FUNCTION_CALL":
        return this.translateFunctionCall(ast);
      case "CASE_EXPRESSION":
        return this.translateCaseExpression(ast);
      case "SUBQUERY_EXPRESSION":
        return this.translateSubqueryExpression(ast);
      case "ARRAY_EXPRESSION":
        return this.translateArrayExpression(ast);
      case "CAST_EXPRESSION":
        return this.translateCastExpression(ast);
      default:
        throw new Error(`Unsupported expression type: ${(ast as any).type}`);
    }
  }

  // Helper methods for AST translation
  private translateColumn(ast: any): Sql {
    if (ast.table) {
      return raw(
        `${this.escapeIdentifier(ast.table)}.${this.escapeIdentifier(ast.name)}`
      );
    }
    return raw(this.escapeIdentifier(ast.name));
  }

  private translateTable(ast: any): Sql {
    let tableSql = raw(this.escapeIdentifier(ast.name));
    if (ast.alias) {
      tableSql = sql`${tableSql} AS ${raw(this.escapeIdentifier(ast.alias))}`;
    }
    return tableSql;
  }

  private translateLiteral(ast: any): Sql {
    return sql`${ast.value}`;
  }

  private translateParameter(ast: any): Sql {
    return sql`${ast.value}`;
  }

  private translateBinaryOperation(ast: any): Sql {
    const left = this.translateExpression(ast.left);
    const right = this.translateExpression(ast.right);
    const operator = this.mapBinaryOperator(ast.operator);
    return sql`${left} ${raw(operator)} ${right}`;
  }

  private translateUnaryOperation(ast: any): Sql {
    const operand = this.translateExpression(ast.operand);
    const operator = this.mapUnaryOperator(ast.operator);

    if (ast.operator === "IS_NULL") {
      return sql`${operand} IS NULL`;
    } else if (ast.operator === "IS_NOT_NULL") {
      return sql`${operand} IS NOT NULL`;
    }

    return sql`${raw(operator)} ${operand}`;
  }

  private translateFunctionCall(ast: any): Sql {
    const args = ast.arguments.map((arg: any) => this.translateExpression(arg));
    const argsClause = join(args, ", ");
    return sql`${raw(ast.name)}(${argsClause})`;
  }

  private translateCaseExpression(ast: any): Sql {
    // Simplified CASE implementation
    return sql`CASE WHEN ${raw("true")} THEN ${raw("null")} END`;
  }

  private translateSubqueryExpression(ast: any): Sql {
    const subquery = this.translateSelect(ast.subquery);
    return sql`(${subquery})`;
  }

  private translateArrayExpression(ast: any): Sql {
    const elements = ast.elements.map((elem: any) =>
      this.translateExpression(elem)
    );
    const elementsClause = join(elements, ", ");
    return sql`ARRAY[${elementsClause}]`;
  }

  private translateCastExpression(ast: any): Sql {
    const expression = this.translateExpression(ast.expression);
    return sql`${expression}::${raw(ast.targetType.name)}`;
  }

  private translateSelectFields(fields: SelectFieldAST[]): Sql {
    const fieldSqls = fields.map((field) => {
      switch (field.type) {
        case "WILDCARD":
          return field.table
            ? raw(`${this.escapeIdentifier(field.table)}.*`)
            : raw("*");
        case "COLUMN_SELECT":
          const column = this.translateColumn(field.column);
          return field.alias
            ? sql`${column} AS ${raw(this.escapeIdentifier(field.alias))}`
            : column;
        case "EXPRESSION_SELECT":
          const expr = this.translateExpression(field.expression);
          return field.alias
            ? sql`${expr} AS ${raw(this.escapeIdentifier(field.alias))}`
            : expr;
        default:
          throw new Error(
            `Unsupported select field type: ${(field as any).type}`
          );
      }
    });
    return join(fieldSqls, ", ");
  }

  private translateFromClause(from: FromClauseAST): Sql {
    switch (from.type) {
      case "TABLE":
        return this.translateTable(from);
      case "SUBQUERY_FROM":
        const subquery = this.translateSelect(from.subquery);
        return sql`(${subquery}) AS ${raw(this.escapeIdentifier(from.alias))}`;
      case "JOIN":
        return this.translateJoin(from);
      default:
        throw new Error(`Unsupported FROM clause type: ${(from as any).type}`);
    }
  }

  private translateJoin(joinAst: JoinAST): Sql {
    const joinType = joinAst.joinType.replace("_", " ");
    const left = this.translateFromClause(joinAst.left);
    const right = this.translateFromClause(joinAst.right);

    let conditionSql: Sql;
    if (joinAst.condition.type === "ON_CONDITION") {
      conditionSql = this.translateExpression(joinAst.condition.expression);
      return sql`${left} ${raw(joinType)} JOIN ${right} ON ${conditionSql}`;
    } else if (joinAst.condition.type === "USING_CONDITION") {
      const columns = joinAst.condition.columns.map((col) =>
        this.translateColumn(col)
      );
      const columnsClause = join(columns, ", ");
      return sql`${left} ${raw(
        joinType
      )} JOIN ${right} USING (${columnsClause})`;
    } else {
      throw new Error(
        `Unsupported join condition type: ${(joinAst.condition as any).type}`
      );
    }
  }

  private translateOrderBy(orderBy: OrderByAST): Sql {
    const expression = this.translateExpression(orderBy.expression);
    let orderSql = sql`${expression} ${raw(orderBy.direction)}`;

    if (orderBy.nullsOrder) {
      orderSql = sql`${orderSql} ${raw(orderBy.nullsOrder.replace("_", " "))}`;
    }

    return orderSql;
  }

  private translateValues(values: any): Sql {
    const rowSqls = values.rows.map((row: any[]) => {
      const valueSqls = row.map((value) => this.translateExpression(value));
      const valuesClause = join(valueSqls, ", ");
      return sql`(${valuesClause})`;
    });
    const rowsClause = join(rowSqls, ", ");
    return sql`VALUES ${rowsClause}`;
  }

  private translateOnConflict(onConflict: any): Sql {
    // Simplified ON CONFLICT implementation
    return sql`ON CONFLICT DO NOTHING`;
  }

  private mapBinaryOperator(operator: string): string {
    const operatorMap: Record<string, string> = {
      EQ: "=",
      NE: "!=",
      GT: ">",
      GTE: ">=",
      LT: "<",
      LTE: "<=",
      AND: "AND",
      OR: "OR",
      LIKE: "LIKE",
      ILIKE: "ILIKE",
      IN: "IN",
      NOT_IN: "NOT IN",
      ADD: "+",
      SUBTRACT: "-",
      MULTIPLY: "*",
      DIVIDE: "/",
    };
    return operatorMap[operator] || operator;
  }

  private mapUnaryOperator(operator: string): string {
    const operatorMap: Record<string, string> = {
      NOT: "NOT",
      MINUS: "-",
      PLUS: "+",
    };
    return operatorMap[operator] || operator;
  }

  /**
   * Transform JavaScript values to PostgreSQL-compatible values
   */
  transformToDatabase(value: unknown, field: BaseField): unknown {
    if (value === null || value === undefined) {
      return null;
    }

    const fieldType = field["~fieldType"];
    const isArray = field["~isArray"];

    // Handle array fields
    if (isArray && Array.isArray(value)) {
      return value.map((item) => this.transformSingleValue(item, fieldType));
    }

    return this.transformSingleValue(value, fieldType);
  }

  /**
   * Transform PostgreSQL values to JavaScript values
   */
  transformFromDatabase(value: unknown, field: BaseField): unknown {
    if (value === null || value === undefined) {
      return null;
    }

    const fieldType = field["~fieldType"];
    const isArray = field["~isArray"];

    // Handle array fields
    if (isArray && Array.isArray(value)) {
      return value.map((item) =>
        this.transformSingleValueFromDb(item, fieldType)
      );
    }

    return this.transformSingleValueFromDb(value, fieldType);
  }

  /**
   * Transform a single value to PostgreSQL format
   */
  private transformSingleValue(value: unknown, fieldType?: string): unknown {
    if (value === null || value === undefined) {
      return null;
    }

    switch (fieldType) {
      case "string":
        return String(value);

      case "dateTime":
        if (value instanceof Date) {
          return value.toISOString();
        }
        if (typeof value === "string") {
          return value; // Assume it's already in ISO format
        }
        return String(value);

      case "json":
        if (typeof value === "object") {
          return JSON.stringify(value);
        }
        return value;

      case "boolean":
        return Boolean(value);

      case "int":
      case "float":
      case "decimal":
        return Number(value);

      case "bigInt":
        if (typeof value === "bigint") {
          return value.toString(); // PostgreSQL bigint as string
        }
        return String(value);

      case "blob":
        if (value instanceof Uint8Array) {
          return value;
        }
        // Convert other formats to Uint8Array if needed
        return value;

      default:
        return value;
    }
  }

  /**
   * Transform a single value from PostgreSQL format
   */
  private transformSingleValueFromDb(
    value: unknown,
    fieldType?: string
  ): unknown {
    if (value === null || value === undefined) {
      return null;
    }

    switch (fieldType) {
      case "string":
        return String(value);

      case "dateTime":
        if (typeof value === "string") {
          return new Date(value);
        }
        if (value instanceof Date) {
          return value;
        }
        return new Date(String(value));

      case "json":
        if (typeof value === "string") {
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        }
        return value;

      case "boolean":
        return Boolean(value);

      case "int":
      case "float":
      case "decimal":
        return Number(value);

      case "bigInt":
        if (typeof value === "string") {
          return BigInt(value);
        }
        if (typeof value === "number") {
          return BigInt(value);
        }
        return BigInt(String(value));

      case "blob":
        if (value instanceof Uint8Array) {
          return value;
        }
        // Handle other binary formats if needed
        return value;

      default:
        return value;
    }
  }

  /**
   * Escape a PostgreSQL identifier (table/column name)
   */
  escapeIdentifier(identifier: string): string {
    // Validate identifier contains only safe characters
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
      throw new Error(`Invalid PostgreSQL identifier: ${identifier}`);
    }

    return `"${identifier.replace(/"/g, '""')}"`;
  }
}
