# BaseORM AST to Database Adapter Implementation Guide

This document explains how to use BaseORM's AST (Abstract Syntax Tree) parser to implement database adapters for different databases like PostgreSQL, MySQL, SQLite, etc.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Adapter Interface](#adapter-interface)
4. [Global AST Visitor](#global-ast-visitor)
5. [Implementing Adapter Methods](#implementing-adapter-methods)
6. [Working with Nested Queries](#working-with-nested-queries)
7. [Examples](#examples)
8. [Best Practices](#best-practices)

## Overview

BaseORM uses a **Global AST Visitor** pattern where:

1. **A single visitor** recursively traverses the entire AST
2. **The visitor calls specific adapter methods** for each operation
3. **Adapters implement a small, focused interface** with targeted methods
4. **The visitor handles recursion and nesting** automatically
5. **Relations are handled via JSON subqueries** instead of JOINs

```typescript
// High-level flow
Query Object → AST Parser → QueryAST → Global Visitor → Adapter Methods → SQL Fragments → Complete SQL
```

This approach ensures adapters only need to implement a small surface area of specific database operations, while the visitor handles all the complexity of AST traversal and composition.

### SQL Template Literal System

BaseORM provides a powerful SQL template literal system in `src/sql/sql.ts` that adapter developers **must use** for building SQL queries safely. This system:

- **Prevents SQL injection** by properly separating SQL strings from values
- **Supports nested SQL composition** for complex queries
- **Handles parameter binding** automatically
- **Provides multiple output formats** (MySQL `?`, PostgreSQL `$1`, etc.)

```typescript
import sql from "../sql/sql.ts";

// Example usage in adapter
buildFieldCondition(field: string, operator: string, value: string): string {
  switch (operator) {
    case "equals":
      return sql`${sql.raw(field)} = ${value}`.sql;
    case "in":
      return sql`${sql.join(values)}`.sql;
  }
}
```

**Important**: Always use `sql.raw()` for identifiers and field names, and pass values directly to the template literal for proper parameter binding.

## Architecture

### The Visitor-Adapter Pattern

```typescript
// Global visitor handles AST traversal
class SQLASTVisitor {
  constructor(private adapter: DatabaseAdapter) {}

  visit(ast: QueryAST): string {
    // Recursively traverse AST, calling adapter methods
    return this.visitQuery(ast);
  }

  visitQuery(node: QueryAST): string {
    // Gather child SQL fragments by visiting children
    const selectClause = this.visitSelect(node.args.select);
    const whereClause = this.visitWhere(node.args.where);
    const orderByClause = this.visitOrderBy(node.args.orderBy);

    // Call adapter to compose final query
    return this.adapter.buildQuery({
      operation: node.operation,
      table: node.model.name,
      select: selectClause,
      where: whereClause,
      orderBy: orderByClause,
      // ... other clauses
    });
  }
}

// Adapter implements small, focused interface
interface DatabaseAdapter {
  buildQuery(parts: QueryParts): string;
  buildWhereClause(conditions: string[]): string;
  buildSelectClause(fields: string[]): string;
  // ... other focused methods
}
```

## Adapter Interface

Your adapter only needs to implement these focused methods:

```typescript
interface DatabaseAdapter {
  // Core query building
  buildQuery(parts: QueryParts): string;

  // Clause builders (receive processed child fragments)
  buildSelectClause(fields: string[]): string;
  buildWhereClause(conditions: string[]): string;
  buildOrderByClause(orderings: string[]): string;
  buildGroupByClause(fields: string[]): string;
  buildHavingClause(conditions: string[]): string;

  // Condition builders (atomic operations)
  buildFieldCondition(field: string, operator: string, value: string): string;
  buildLogicalCondition(
    operator: "AND" | "OR" | "NOT",
    conditions: string[]
  ): string;
  buildRelationCondition(
    relation: RelationInfo,
    operation: string,
    subquery: string
  ): string;

  // Value and identifier formatting
  formatValue(value: any, type: string): string;
  formatIdentifier(identifier: string): string;
  formatTableName(table: string): string;

  // Operation-specific builders
  buildInsertQuery(table: string, fields: string[], values: string[][]): string;
  buildUpdateQuery(
    table: string,
    setClauses: string[],
    whereClause?: string
  ): string;
  buildDeleteQuery(table: string, whereClause?: string): string;

  // Aggregation builders
  buildAggregateQuery(
    table: string,
    aggregations: string[],
    whereClause?: string,
    groupBy?: string[],
    having?: string[]
  ): string;
  buildCountQuery(table: string, field?: string, whereClause?: string): string;

  // Batch operations
  buildBatchInsert(
    table: string,
    fields: string[],
    valueRows: string[][],
    options?: BatchOptions
  ): string;
  buildBatchUpdate(
    table: string,
    setClauses: string[],
    whereClause?: string
  ): string;
  buildBatchDelete(table: string, whereClause?: string): string;

  // Pagination
  buildLimitOffset(limit?: number, offset?: number): string;
  buildCursorPagination(
    field: string,
    value: string,
    direction: "forward" | "backward"
  ): string;

  // JSON aggregation methods for nested relations (NEW)
  buildJsonObject(keyValuePairs: Array<{ key: string; value: string }>): string;
  buildJsonArray(elements: string[]): string;
  buildJsonArrayAgg(expression: string): string;
  buildNestedRelationSubquery(
    relation: RelationInfo,
    selectClause: string,
    whereClause?: string,
    orderByClause?: string,
    limitClause?: string
  ): string;
  buildRelationFieldSelect(
    relation: RelationInfo,
    subquery: string,
    alias: string
  ): string;
}

interface QueryParts {
  operation: string;
  table: string;
  select?: string;
  where?: string;
  orderBy?: string;
  groupBy?: string;
  having?: string;
  limit?: string;
  offset?: string;
}
```

## Global AST Visitor

The visitor handles all AST traversal and calls your adapter methods:

```typescript
class SQLASTVisitor {
  constructor(private adapter: DatabaseAdapter) {}

  // Main entry point
  visit(ast: QueryAST): string {
    switch (ast.operation) {
      case "findMany":
      case "findFirst":
      case "findUnique":
        return this.visitSelectQuery(ast);
      case "create":
        return this.visitInsertQuery(ast);
      case "update":
        return this.visitUpdateQuery(ast);
      case "delete":
        return this.visitDeleteQuery(ast);
      case "aggregate":
      case "count":
        return this.visitAggregateQuery(ast);
      case "groupBy":
        return this.visitGroupByQuery(ast);
      case "createMany":
      case "updateMany":
      case "deleteMany":
        return this.visitBatchQuery(ast);
      default:
        throw new Error(`Unsupported operation: ${ast.operation}`);
    }
  }

  // Visit SELECT queries
  private visitSelectQuery(ast: QueryAST): string {
    const parts: QueryParts = {
      operation: ast.operation,
      table: this.adapter.formatTableName(ast.model.name),
    };

    // Visit children and build SQL fragments
    if (ast.args.select) {
      parts.select = this.visitSelect(ast.args.select);
    }

    if (ast.args.where) {
      parts.where = this.visitWhereArray(ast.args.where);
    }

    if (ast.args.orderBy) {
      parts.orderBy = this.visitOrderByArray(ast.args.orderBy);
    }

    if (ast.args.groupBy) {
      parts.groupBy = this.visitGroupByArray(ast.args.groupBy);
    }

    if (ast.args.having) {
      parts.having = this.visitWhereArray(ast.args.having); // Same as WHERE
    }

    if (ast.args.include) {
      parts.joins = this.visitIncludes(ast.args.include);
    }

    if (ast.args.take || ast.args.skip) {
      parts.limit = this.adapter.buildLimitOffset(ast.args.take, ast.args.skip);
    }

    if (ast.args.cursor) {
      const cursorCondition = this.visitCursor(ast.args.cursor);
      parts.where = parts.where
        ? this.adapter.buildLogicalCondition("AND", [
            parts.where,
            cursorCondition,
          ])
        : cursorCondition;
    }

    // Let adapter compose the final query
    return this.adapter.buildQuery(parts);
  }

  // Visit WHERE conditions
  private visitWhereArray(conditions: ConditionAST[]): string {
    const conditionStrings = conditions.map((cond) =>
      this.visitCondition(cond)
    );
    return this.adapter.buildWhereClause(conditionStrings);
  }

  private visitCondition(condition: ConditionAST): string {
    switch (condition.target.type) {
      case "FIELD":
        return this.visitFieldCondition(condition);
      case "RELATION":
        return this.visitRelationCondition(condition);
      case "LOGICAL":
        return this.visitLogicalCondition(condition);
      default:
        throw new Error(
          `Unknown condition target type: ${condition.target.type}`
        );
    }
  }

  private visitFieldCondition(condition: ConditionAST): string {
    const target = condition.target as FieldConditionTarget;
    const field = this.adapter.formatIdentifier(target.field.name);
    const operator = condition.operator;

    let value: string;
    if (Array.isArray(condition.value)) {
      // Handle IN, NOT IN operators
      value = `(${condition.value.map((v) => this.visitValue(v)).join(", ")})`;
    } else if (condition.value) {
      value = this.visitValue(condition.value);
    } else {
      value = "";
    }

    return this.adapter.buildFieldCondition(field, operator, value);
  }

  private visitLogicalCondition(condition: ConditionAST): string {
    if (!condition.nested || condition.nested.length === 0) {
      return "";
    }

    const nestedConditions = condition.nested.map((nested) =>
      this.visitCondition(nested)
    );
    const operator = condition.logic || "AND";

    let result = this.adapter.buildLogicalCondition(operator, nestedConditions);

    if (condition.negated) {
      result = this.adapter.buildLogicalCondition("NOT", [result]);
    }

    return result;
  }

  private visitRelationCondition(condition: ConditionAST): string {
    const target = condition.target as RelationConditionTarget;
    const relation = target.relation;

    // Recursively visit nested conditions
    const nestedConditions =
      condition.nested?.map((nested) => this.visitCondition(nested)) || [];
    const subquery =
      nestedConditions.length > 0
        ? this.adapter.buildWhereClause(nestedConditions)
        : "";

    const relationInfo: RelationInfo = {
      sourceTable: relation.sourceModel.name,
      targetTable: relation.targetModel.name,
      relationName: relation.name,
      // Add foreign key info, relation type, etc.
    };

    return this.adapter.buildRelationCondition(
      relationInfo,
      target.operation,
      subquery
    );
  }

  // Visit SELECT clause
  private visitSelect(selection: SelectionAST | AggregationAST): string {
    if (selection.type === "SELECTION") {
      const fields = selection.fields
        .filter((field) => field.include)
        .map((field) => this.adapter.formatIdentifier(field.field.name));
      return this.adapter.buildSelectClause(fields);
    } else {
      // Handle aggregation
      return this.visitAggregation(selection);
    }
  }

  private visitAggregation(aggregation: AggregationAST): string {
    const aggregationStrings = aggregation.aggregations.map((agg) => {
      const field = agg.field
        ? this.adapter.formatIdentifier(agg.field.name)
        : undefined;
      return this.buildAggregationOperation(agg.operation, field);
    });

    return aggregationStrings.join(", ");
  }

  private buildAggregationOperation(operation: string, field?: string): string {
    switch (operation) {
      case "_count":
        return field ? `COUNT(${field})` : `COUNT(*)`;
      case "_avg":
        return `AVG(${field})`;
      case "_sum":
        return `SUM(${field})`;
      case "_min":
        return `MIN(${field})`;
      case "_max":
        return `MAX(${field})`;
      default:
        throw new Error(`Unknown aggregation operation: ${operation}`);
    }
  }

  // Visit ORDER BY clause
  private visitOrderByArray(orderings: OrderingAST[]): string {
    const orderingStrings = orderings.map((ordering) =>
      this.visitOrdering(ordering)
    );
    return this.adapter.buildOrderByClause(orderingStrings);
  }

  private visitOrdering(ordering: OrderingAST): string {
    let field: string;

    switch (ordering.target.type) {
      case "FIELD":
        const fieldTarget = ordering.target as FieldOrderingTarget;
        field = this.adapter.formatIdentifier(fieldTarget.field.name);
        break;
      case "AGGREGATE":
        const aggTarget = ordering.target as AggregateOrderingTarget;
        const aggField = aggTarget.field
          ? this.adapter.formatIdentifier(aggTarget.field.name)
          : undefined;
        field = this.buildAggregationOperation(aggTarget.operation, aggField);
        break;
      default:
        throw new Error(
          `Unknown ordering target type: ${ordering.target.type}`
        );
    }

    let result = `${field} ${ordering.direction.toUpperCase()}`;

    if (ordering.nulls) {
      result += ` NULLS ${ordering.nulls.toUpperCase()}`;
    }

    return result;
  }

  // Visit VALUES
  private visitValue(valueAST: ValueAST): string {
    return this.adapter.formatValue(valueAST.value, valueAST.valueType);
  }

  // Visit other clause types...
  private visitGroupByArray(groupBy: GroupByAST[]): string {
    const fields = groupBy.map((gb) =>
      this.adapter.formatIdentifier(gb.field.name)
    );
    return this.adapter.buildGroupByClause(fields);
  }

  private visitCursor(cursor: CursorAST): string {
    const field = this.adapter.formatIdentifier(cursor.field.name);
    const value = this.visitValue(cursor.value);
    return this.adapter.buildCursorPagination(
      field,
      value,
      cursor.direction || "forward"
    );
  }

  // ... other visit methods
}

// Usage
const visitor = new SQLASTVisitor(new PostgreSQLAdapter());
const sql = visitor.visit(ast);
```

## Implementing Adapter Methods

Now your adapter only needs to implement focused, database-specific methods:

### PostgreSQL Adapter Example

```typescript
class PostgreSQLAdapter implements DatabaseAdapter {
  buildQuery(parts: QueryParts): string {
    let sql = "";

    switch (parts.operation) {
      case "findMany":
      case "findFirst":
        sql = `SELECT ${parts.select || "*"} FROM ${parts.table}`;
        if (parts.joins) sql += ` ${parts.joins}`;
        if (parts.where) sql += ` WHERE ${parts.where}`;
        if (parts.groupBy) sql += ` GROUP BY ${parts.groupBy}`;
        if (parts.having) sql += ` HAVING ${parts.having}`;
        if (parts.orderBy) sql += ` ORDER BY ${parts.orderBy}`;
        if (parts.limit) sql += ` ${parts.limit}`;
        break;

      default:
        throw new Error(`Unsupported operation: ${parts.operation}`);
    }

    return sql;
  }

  buildWhereClause(conditions: string[]): string {
    return conditions.join(" AND ");
  }

  buildSelectClause(fields: string[]): string {
    return fields.length > 0 ? fields.join(", ") : "*";
  }

  buildOrderByClause(orderings: string[]): string {
    return orderings.join(", ");
  }

  buildGroupByClause(fields: string[]): string {
    return fields.join(", ");
  }

  buildHavingClause(conditions: string[]): string {
    return conditions.join(" AND ");
  }

  buildFieldCondition(field: string, operator: string, value: string): string {
    switch (operator) {
      case "equals":
        return `${field} = ${value}`;
      case "not":
        return `${field} != ${value}`;
      case "in":
        return `${field} IN ${value}`;
      case "notIn":
        return `${field} NOT IN ${value}`;
      case "gt":
        return `${field} > ${value}`;
      case "gte":
        return `${field} >= ${value}`;
      case "lt":
        return `${field} < ${value}`;
      case "lte":
        return `${field} <= ${value}`;
      case "contains":
        return `${field} ILIKE ${this.formatLikeValue(value, "%", "%")}`;
      case "startsWith":
        return `${field} ILIKE ${this.formatLikeValue(value, "", "%")}`;
      case "endsWith":
        return `${field} ILIKE ${this.formatLikeValue(value, "%", "")}`;
      case "isNull":
        return `${field} IS NULL`;
      case "isNotNull":
        return `${field} IS NOT NULL`;
      default:
        throw new Error(`Unsupported operator: ${operator}`);
    }
  }

  buildLogicalCondition(
    operator: "AND" | "OR" | "NOT",
    conditions: string[]
  ): string {
    if (conditions.length === 0) return "";

    if (operator === "NOT") {
      return `NOT (${conditions[0]})`;
    }

    return `(${conditions.join(` ${operator} `)})`;
  }

  buildRelationCondition(
    relation: RelationInfo,
    operation: string,
    subquery: string
  ): string {
    switch (operation) {
      case "some":
        return `EXISTS (SELECT 1 FROM ${
          relation.targetTable
        } WHERE ${this.buildJoinCondition(relation)} AND ${subquery})`;
      case "every":
        return `NOT EXISTS (SELECT 1 FROM ${
          relation.targetTable
        } WHERE ${this.buildJoinCondition(relation)} AND NOT (${subquery}))`;
      case "none":
        return `NOT EXISTS (SELECT 1 FROM ${
          relation.targetTable
        } WHERE ${this.buildJoinCondition(relation)} AND ${subquery})`;
      default:
        throw new Error(`Unsupported relation operation: ${operation}`);
    }
  }

  formatValue(value: any, type: string): string {
    if (value === null || value === undefined) {
      return "NULL";
    }

    switch (type) {
      case "string":
        return `'${this.escapeString(value)}'`;
      case "int":
      case "float":
      case "bigInt":
        return String(value);
      case "boolean":
        return value ? "TRUE" : "FALSE";
      case "dateTime":
        return `'${value.toISOString()}'`;
      case "json":
        return `'${JSON.stringify(value)}'::jsonb`;
      case "array":
        const arrayValues = value.map((v: any) =>
          this.formatValue(v, "string")
        ); // Simplified
        return `ARRAY[${arrayValues.join(", ")}]`;
      default:
        return `'${this.escapeString(String(value))}'`;
    }
  }

  formatIdentifier(identifier: string): string {
    return `"${identifier}"`; // PostgreSQL identifier quoting
  }

  formatTableName(table: string): string {
    return `"${table}"`;
  }

  buildLimitOffset(limit?: number, offset?: number): string {
    let result = "";
    if (limit) result += `LIMIT ${limit}`;
    if (offset) result += ` OFFSET ${offset}`;
    return result.trim();
  }

  buildCursorPagination(
    field: string,
    value: string,
    direction: "forward" | "backward"
  ): string {
    const operator = direction === "forward" ? ">" : "<";
    return `${field} ${operator} ${value}`;
  }

  // ... implement other required methods

  private escapeString(str: string): string {
    return str.replace(/'/g, "''");
  }

  private formatLikeValue(
    value: string,
    prefix: string,
    suffix: string
  ): string {
    const escaped = this.escapeString(value);
    return `'${prefix}${escaped}${suffix}'`;
  }

  private buildJoinCondition(relation: RelationInfo): string {
    // Build JOIN condition based on relation metadata
    return `${relation.sourceTable}.id = ${relation.targetTable}.${relation.relationName}_id`;
  }
}
```

### MySQL Adapter Differences

```typescript
class MySQLAdapter extends PostgreSQLAdapter {
  formatIdentifier(identifier: string): string {
    return `\`${identifier}\``; // MySQL uses backticks
  }

  formatTableName(table: string): string {
    return `\`${table}\``;
  }

  formatValue(value: any, type: string): string {
    if (type === "boolean") {
      return value ? "1" : "0"; // MySQL uses 1/0 for boolean
    }
    if (type === "json") {
      return `'${JSON.stringify(value)}'`; // No ::jsonb cast
    }
    return super.formatValue(value, type);
  }

  buildFieldCondition(field: string, operator: string, value: string): string {
    // MySQL uses LIKE instead of ILIKE (case-insensitive)
    if (
      operator === "contains" ||
      operator === "startsWith" ||
      operator === "endsWith"
    ) {
      return super
        .buildFieldCondition(field, operator, value)
        .replace("ILIKE", "LIKE");
    }
    return super.buildFieldCondition(field, operator, value);
  }
}
```

## Working with Nested Queries

The visitor automatically handles nesting by recursively calling methods. **Relations are handled via JSON subqueries instead of JOINs** for better performance and cleaner data structure.

### JSON Subquery Architecture

When a query includes nested relations, BaseORM:

1. **Generates subqueries** for each relation
2. **Wraps results in JSON functions** (JSON_OBJECT, JSON_ARRAYAGG, etc.)
3. **Handles nested filtering, ordering, and pagination** within subqueries
4. **Returns structured JSON data** that matches the query shape

```typescript
// Example: Complex nested query with relations
const ast = parser.parse("user", "findMany", {
  select: {
    id: true,
    name: true,
    posts: {
      select: {
        title: true,
        content: true,
        _count: { comments: true },
      },
      where: { published: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    },
  },
});

// Visitor handles this by:
// 1. Processing main user fields (id, name)
// 2. Detecting nested posts relation
// 3. Building JSON subquery for posts with:
//    - Nested select (title, content, comment count)
//    - Nested where (published = true)
//    - Nested orderBy (createdAt DESC)
//    - Nested limit (5)
// 4. Wrapping posts subquery in JSON_ARRAYAGG()
```

### JSON Aggregation Methods

Your adapter must implement these methods for handling JSON subqueries:

```typescript
interface DatabaseAdapter {
  // Build JSON object from key-value pairs
  buildJsonObject(keyValuePairs: Array<{ key: string; value: string }>): string;
  // Example: buildJsonObject([{key: "id", value: "u.id"}, {key: "name", value: "u.name"}])
  // Result: JSON_OBJECT('id', u.id, 'name', u.name)

  // Build JSON array from elements
  buildJsonArray(elements: string[]): string;
  // Example: buildJsonArray(["'first'", "'second'", "'third'"])
  // Result: JSON_ARRAY('first', 'second', 'third')

  // Build JSON array aggregation (for one-to-many relations)
  buildJsonArrayAgg(expression: string): string;
  // Example: buildJsonArrayAgg("JSON_OBJECT('title', p.title, 'content', p.content)")
  // Result: JSON_ARRAYAGG(JSON_OBJECT('title', p.title, 'content', p.content))

  // Build complete subquery for nested relation
  buildNestedRelationSubquery(
    relation: RelationInfo,
    selectClause: string,
    whereClause?: string,
    orderByClause?: string,
    limitClause?: string
  ): string;
  // Example: Builds complete SELECT subquery for the relation

  // Build the final relation field select (wraps subquery in JSON aggregation)
  buildRelationFieldSelect(
    relation: RelationInfo,
    subquery: string,
    alias: string
  ): string;
  // Example: Wraps subquery in appropriate JSON function based on relation type
}
```

### Example Adapter Implementation

```typescript
class YourDatabaseAdapter implements DatabaseAdapter {
  buildJsonObject(
    keyValuePairs: Array<{ key: string; value: string }>
  ): string {
    const pairs = keyValuePairs
      .map((pair) => sql`${pair.key}, ${sql.raw(pair.value)}`)
      .join(", ");
    return sql`JSON_OBJECT(${sql.raw(pairs)})`.sql;
  }

  buildJsonArrayAgg(expression: string): string {
    return sql`JSON_ARRAYAGG(${sql.raw(expression)})`.sql;
  }

  buildNestedRelationSubquery(
    relation: RelationInfo,
    selectClause: string,
    whereClause?: string,
    orderByClause?: string,
    limitClause?: string
  ): string {
    let query = sql`SELECT ${sql.raw(selectClause)} FROM ${sql.raw(
      this.formatTableName(relation.targetTable)
    )}`;

    // Build foreign key condition
    const foreignKeyCondition = this.buildForeignKeyCondition(relation);

    if (whereClause) {
      query = sql`${query} WHERE ${sql.raw(foreignKeyCondition)} AND (${sql.raw(
        whereClause
      )})`;
    } else {
      query = sql`${query} WHERE ${sql.raw(foreignKeyCondition)}`;
    }

    if (orderByClause) {
      query = sql`${query} ORDER BY ${sql.raw(orderByClause)}`;
    }

    if (limitClause) {
      query = sql`${query} ${sql.raw(limitClause)}`;
    }

    return query.sql;
  }

  buildRelationFieldSelect(
    relation: RelationInfo,
    subquery: string,
    alias: string
  ): string {
    if (
      relation.relationType === "one-to-many" ||
      relation.relationType === "many-to-many"
    ) {
      // Use JSON_ARRAYAGG for to-many relations
      return sql`(${sql.raw(this.buildJsonArrayAgg(subquery))}) AS ${sql.raw(
        this.formatIdentifier(alias)
      )}`.sql;
    } else {
      // Use JSON_OBJECT for to-one relations
      return sql`(${sql.raw(subquery)}) AS ${sql.raw(
        this.formatIdentifier(alias)
      )}`.sql;
    }
  }

  private buildForeignKeyCondition(relation: RelationInfo): string {
    // This would be determined by relation metadata
    // Example for user -> posts relation:
    return sql`${sql.raw(this.formatTableName(relation.targetTable))}.${sql.raw(
      this.formatIdentifier(relation.relationName + "_id")
    )} = ${sql.raw(this.formatTableName(relation.sourceTable))}.id`.sql;
  }
}
```

## Examples

### Complete Usage Example

```typescript
// 1. Parse query to AST
const ast = parser.parse("user", "findMany", {
  select: {
    id: true,
    name: true,
    posts: {
      select: { title: true, content: true },
      where: { published: true },
    },
  },
  where: { age: { gte: 18 } },
  orderBy: { createdAt: "desc" },
  take: 10,
});

// 2. Create adapter
const adapter = new YourDatabaseAdapter(database);

// 3. Create visitor
const visitor = new SQLASTVisitor(adapter);

// 4. Generate SQL
const sql = visitor.visit(ast);
// Result: Database-specific SQL with JSON subqueries for relations

// 5. Execute
const result = await database.query(sql);
```

### Upsert Operations Example

```typescript
// Upsert with field-based conflict resolution
const upsertAst = parser.parse("user", "upsert", {
  where: { email: "john@example.com" },
  create: {
    email: "john@example.com",
    name: "John Doe",
    age: 30,
  },
  update: {
    name: "John Updated",
    age: 31,
  },
  conflictTarget: ["email"], // or "email" for single field
});

// Upsert with index-based conflict resolution
const upsertWithIndex = parser.parse("user", "upsert", {
  create: {
    /* data */
  },
  update: {
    /* data */
  },
  conflictTarget: { index: "user_email_unique_idx" },
});

// Upsert with constraint-based conflict resolution
const upsertWithConstraint = parser.parse("user", "upsert", {
  create: {
    /* data */
  },
  update: {
    /* data */
  },
  conflictTarget: { constraint: "user_email_key" },
});
```

### JSON Path Operations Example

```typescript
// Query with JSON filter operations (matching JsonFilter structure)
const jsonQuery = parser.parse("user", "findMany", {
  where: {
    metadata: {
      equals: { theme: "dark" },
      path: ["preferences", "theme"],
    },
  },
});

// JSON string operations
const stringJsonQuery = parser.parse("user", "findMany", {
  where: {
    metadata: {
      string_contains: "premium",
      path: ["subscription", "type"],
    },
  },
});

// JSON array operations
const arrayJsonQuery = parser.parse("order", "findMany", {
  where: {
    items: {
      array_contains: { id: 123 },
      array_starts_with: { category: "electronics" },
    },
  },
});
```

### Array Operations Example

```typescript
// Array operations (only set and push are supported)
const arrayUpdate = parser.parse("user", "update", {
  where: { id: 1 },
  data: {
    tags: {
      set: ["new-tag", "another-tag"], // Replace entire array
    },
    favorites: {
      push: "new-favorite", // Append to array
    },
  },
});

// Numeric operations
const numericUpdate = parser.parse("user", "update", {
  where: { id: 1 },
  data: {
    score: {
      increment: 10,
    },
    balance: {
      multiply: 1.05,
    },
  },
});
```

### Expected SQL Output Example

For the above query, the generated SQL might look like:

```sql
SELECT
  u.id,
  u.name,
  (
    SELECT JSON_ARRAYAGG(
      JSON_OBJECT(
        'title', p.title,
        'content', p.content
      )
    )
    FROM posts p
    WHERE p.user_id = u.id
    AND p.published = true
  ) as posts
FROM users u
WHERE u.age >= 18
ORDER BY u.created_at DESC
LIMIT 10;
```

For upsert operations:

```sql
INSERT INTO users (email, name, age)
VALUES ('john@example.com', 'John Doe', 30)
ON CONFLICT (email)
DO UPDATE SET
  name = 'John Updated',
  age = 31;
```

For JSON path operations:

```sql
SELECT * FROM users
WHERE JSON_EXTRACT(metadata, '$.preferences.theme') = 'dark';

SELECT * FROM users
WHERE JSON_SEARCH(metadata, 'one', '%premium%') IS NOT NULL;

SELECT * FROM orders
WHERE JSON_CONTAINS(items, '{"id": 123}');
```

For array operations:

```sql
-- Array set operation (replace entire array)
UPDATE users
SET tags = JSON_ARRAY('new-tag', 'another-tag')
WHERE id = 1;

-- Array push operation (append to existing array)
UPDATE users
SET favorites = JSON_ARRAY_APPEND(favorites, '$', 'new-favorite')
WHERE id = 1;

-- Numeric operations
UPDATE users
SET score = score + 10,
    balance = balance * 1.05
WHERE id = 1;
```

## Best Practices

### 1. Use the SQL Template System

Always use the `sql` template literal system from `src/sql/sql.ts` for building queries safely:

```typescript
import { sql } from '../sql/sql';

buildFieldCondition(field: string, operator: string, value: string): string {
  switch (operator) {
    case "equals":
      return sql`${sql.raw(field)} = ${value}`.sql;
    case "in":
      return sql`${sql.raw(field)} IN (${sql.join(values)})`.sql;
  }
}
```

### 2. Database-Specific Optimizations

Implement database-specific optimizations in adapter methods:

```typescript
// PostgreSQL adapter
buildJsonObject(keyValuePairs: Array<{ key: string; value: string }>): string {
  const pairs = keyValuePairs.map(({ key, value }) =>
    sql`${key}, ${value}`.sql
  ).join(', ');
  return sql`json_build_object(${sql.raw(pairs)})`.sql;
}

// MySQL adapter
buildJsonObject(keyValuePairs: Array<{ key: string; value: string }>): string {
  const pairs = keyValuePairs.map(({ key, value }) =>
    sql`${key}, ${value}`.sql
  ).join(', ');
  return sql`JSON_OBJECT(${sql.raw(pairs)})`.sql;
}
```

### 3. JSON Operations Best Practices

- **Validation**: Always validate JSON paths before executing operations
- **Performance**: Index frequently queried JSON paths
- **Compatibility**: Use database-specific JSON functions for optimal performance

```typescript
buildJsonPathOperation(field: string, path: string, operation: string): string {
  // Validate JSON path format
  if (!this.isValidJsonPath(path)) {
    throw new Error(`Invalid JSON path: ${path}`);
  }

  switch (this.databaseType) {
    case 'postgres':
      return sql`${sql.raw(field)} #> ${path}`.sql;
    case 'mysql':
      return sql`JSON_EXTRACT(${sql.raw(field)}, ${path})`.sql;
  }
}
```

### 4. Array Operations Best Practices

- **Type Safety**: Ensure array operations match field types
- **Performance**: Consider array indexes for frequently queried arrays
- **Database Support**: Check database-specific array function availability

```typescript
buildArrayOperation(field: string, operation: string, value: any): string {
  switch (operation) {
    case 'contains':
      if (this.databaseType === 'postgres') {
        return sql`${value} = ANY(${sql.raw(field)})`.sql;
      } else {
        return sql`JSON_CONTAINS(${sql.raw(field)}, ${value})`.sql;
      }
  }
}
```

### 5. Upsert Operations Best Practices

- **Conflict Targets**: Always specify explicit conflict targets for production
- **Performance**: Use appropriate indexes on conflict target fields
- **Data Integrity**: Validate both create and update data

```typescript
buildUpsertQuery(
  table: string,
  insertFields: string[],
  insertValues: string[],
  conflictTarget: string,
  updateClauses: string[],
  whereClause?: string
): string {
  // Ensure conflict target is properly indexed
  if (!this.hasIndex(table, conflictTarget)) {
    console.warn(`No index found for upsert conflict target: ${conflictTarget}`);
  }

  return sql`
    INSERT INTO ${sql.raw(table)} (${sql.raw(insertFields.join(', '))})
    VALUES (${sql.join(insertValues)})
    ON CONFLICT ${sql.raw(conflictTarget)}
    DO UPDATE SET ${sql.raw(updateClauses.join(', '))}
    ${whereClause ? sql`WHERE ${sql.raw(whereClause)}` : sql``}
  `.sql;
}
```

### 6. Error Handling

- **Graceful Degradation**: Handle unsupported operations gracefully
- **Clear Messages**: Provide clear error messages for debugging
- **Fallbacks**: Implement fallbacks for complex operations

```typescript
buildAdvancedOperation(operation: string, ...args: any[]): string {
  try {
    return this.buildNativeOperation(operation, ...args);
  } catch (error) {
    if (this.supportsOperation(operation)) {
      throw error;
    }

    // Fallback to basic implementation
    console.warn(`Advanced operation ${operation} not supported, using fallback`);
    return this.buildBasicOperation(operation, ...args);
  }
}
```

### 7. Testing

- **Unit Tests**: Test each adapter method independently
- **Integration Tests**: Test complete query flows
- **Database Compatibility**: Test across supported database versions

```typescript
describe("DatabaseAdapter", () => {
  test("should handle upsert operations", () => {
    const sql = adapter.buildUpsertQuery(
      "users",
      ["email", "name"],
      ['"john@example.com"', '"John"'],
      "(email)",
      ['name = "John Updated"']
    );

    expect(sql).toContain("ON CONFLICT (email)");
    expect(sql).toContain("DO UPDATE SET");
  });
});
```

## Key Features

- **Type Safety**: All AST nodes are fully typed
- **JSON Subqueries**: Relations handled via JSON functions instead of JOINs
- **Conflict Resolution**: Full upsert support with multiple conflict target types
- **JSON Filter Operations**: JsonFilter-compatible JSON querying (path, string_contains, array_contains, etc.)
- **Array Operations**: Array set and push operations for data updates
- **Numeric Operations**: Field increment, decrement, multiply, divide operations
- **SQL Template Literals**: Safe query building using the `sql` template system
