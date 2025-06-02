# Identifier Escaping Architecture Guide

## Problem Analysis

**Issue**: QueryParser hardcodes PostgreSQL-style double quotes (`"`) for identifier escaping, which breaks MySQL compatibility.

**Database Differences**:

- **PostgreSQL**: Uses double quotes (`"table"."column"`)
- **MySQL**: Uses backticks (`` `table`.`column` ``)
- **SQLite**: Supports both double quotes and square brackets
- **SQL Server**: Uses square brackets (`[table].[column]`)

## Current Problems

### 1. Hardcoded PostgreSQL Identifiers in QueryParser

```typescript
// ❌ PostgreSQL-specific (breaks MySQL)
sql.raw`"${alias}"."${fieldName}"`;
sql.raw`"${tableName}" AS "${alias}"`;
sql.raw`COUNT("${alias}"."${field}") AS "_count_${field}"`;
```

### 2. Database Adapter Column Method Also Hardcoded

```typescript
// ❌ PostgreSQL-specific in adapter
private column(ctx: BuilderContext): Sql {
  return sql.raw`"${ctx.alias}"."${ctx.fieldName}"`;
}
```

### 3. No Database-Agnostic Identifier Generation

The QueryParser directly generates database-specific SQL instead of delegating identifier escaping to adapters.

## Solution Architecture

### Phase 1: Move Identifier Escaping to Adapters

**1. Add Identifier Methods to DatabaseAdapter Interface**

```typescript
export interface DatabaseAdapter {
  // ... existing methods

  identifiers: {
    // Escape a single identifier (table, column, alias)
    escape: (identifier: string) => Sql;
    // Create a qualified column reference
    column: (alias: string, field: string) => Sql;
    // Create a table reference with alias
    table: (tableName: string, alias: string) => Sql;
    // Create an aliased expression
    aliased: (expression: Sql, alias: string) => Sql;
  };
}
```

**2. Implement in PostgreSQL Adapter**

```typescript
identifiers = {
  escape: (identifier: string): Sql => sql.raw`"${identifier}"`,
  column: (alias: string, field: string): Sql => sql.raw`"${alias}"."${field}"`,
  table: (tableName: string, alias: string): Sql =>
    sql.raw`"${tableName}" AS "${alias}"`,
  aliased: (expression: Sql, alias: string): Sql =>
    sql`${expression} AS "${alias}"`,
};
```

**3. Implement in MySQL Adapter**

```typescript
identifiers = {
  escape: (identifier: string): Sql => sql.raw`\`${identifier}\``,
  column: (alias: string, field: string): Sql =>
    sql.raw`\`${alias}\`.\`${field}\``,
  table: (tableName: string, alias: string): Sql =>
    sql.raw`\`${tableName}\` AS \`${alias}\``,
  aliased: (expression: Sql, alias: string): Sql =>
    sql`${expression} AS \`${alias}\``,
};
```

### Phase 2: Update QueryParser to Use Adapter Identifiers

**1. Replace Hardcoded Identifiers**

```typescript
// ❌ Before (PostgreSQL-specific)
fields.push(sql.raw`"${alias}"."${fieldName}"`);

// ✅ After (database-agnostic)
fields.push(this.adapter.identifiers.column(alias, fieldName));
```

**2. Update All QueryParser Methods**

```typescript
private buildSelectStatement(model: Model<any>, select: any, alias: string): Sql {
  const fields: Sql[] = [];

  if (select === null || select === undefined) {
    for (const [fieldName] of model.fields) {
      fields.push(this.adapter.identifiers.column(alias, fieldName));
    }
  } else {
    for (const [fieldName, include] of Object.entries(select)) {
      if (include === true && model.fields.has(fieldName)) {
        fields.push(this.adapter.identifiers.column(alias, fieldName));
      }
    }
  }

  return sql.join(fields, ", ");
}

private buildFromStatement(model: Model<any>, alias: string): Sql {
  const tableName = model.tableName || model.name;
  return this.adapter.identifiers.table(tableName, alias);
}
```

**3. Update Abstract Condition Handlers**

```typescript
private buildRelationLinkSQL(condition: any, alias: string): Sql {
  const { parentAlias, childAlias, relationType, onField, refField } = condition;

  if (onField && refField) {
    const childCol = this.adapter.identifiers.column(childAlias || alias, refField);
    const parentCol = this.adapter.identifiers.column(parentAlias, onField);
    return sql`${childCol} = ${parentCol}`;
  }

  throw new ValidationError(
    `Unable to generate relation link SQL for relation type: ${relationType}`
  );
}

private buildParentRefSQL(condition: any, alias: string): Sql {
  const [parentAlias, parentField] = condition.split('.');
  return this.adapter.identifiers.column(parentAlias, parentField);
}
```

### Phase 3: Update Column Accessor in Adapters

**1. Remove Database-Specific Column Method**

```typescript
// ❌ Remove this from PostgresAdapter
private column(ctx: BuilderContext): Sql {
  return sql.raw`"${ctx.alias}"."${ctx.fieldName}"`;
}
```

**2. Use Adapter Identifiers Instead**

```typescript
// ✅ In filter methods
equals: (ctx: BuilderContext, value: any): Sql =>
  sql`${this.identifiers.column(ctx.alias, ctx.fieldName!)} = ${value}`,
```

## Implementation Plan

### Step 1: Add Identifier Interface (Immediate)

1. **Update DatabaseAdapter interface** with `identifiers` section
2. **Implement identifiers in PostgresAdapter**
3. **Create MySQLAdapter with proper backtick escaping**

### Step 2: Update QueryParser (Core Fix)

1. **Replace all hardcoded `sql.raw` identifiers** with adapter calls
2. **Update abstract condition handlers** to use adapter identifiers
3. **Update aggregate and group by methods**

### Step 3: Update Existing Adapters (Cleanup)

1. **Remove hardcoded column methods** from adapters
2. **Update all filter methods** to use `identifiers.column()`
3. **Test with both PostgreSQL and MySQL**

## Database-Specific Examples

### PostgreSQL Output

```sql
SELECT "users"."id", "users"."name"
FROM "users" AS "t0"
WHERE "t0"."active" = true
```

### MySQL Output

```sql
SELECT `users`.`id`, `users`.`name`
FROM `users` AS `t0`
WHERE `t0`.`active` = true
```

### Same BaseORM Code

```typescript
orm.users.findMany({
  select: { id: true, name: true },
  where: { active: true },
});
```

## Migration Strategy

### Phase 1: Interface Addition (Non-Breaking)

- Add `identifiers` to DatabaseAdapter interface
- Implement in PostgresAdapter (maintaining current behavior)
- All existing code continues to work

### Phase 2: QueryParser Updates (Breaking for Adapters)

- Update QueryParser to use `adapter.identifiers`
- Existing adapters will need to implement identifiers interface
- BUT - QueryParser becomes database-agnostic

### Phase 3: MySQL Support (New Feature)

- Add MySQLAdapter with backtick escaping
- Full multi-database support achieved
- Clean, maintainable codebase

## Benefits

1. **Database Agnostic**: QueryParser no longer tied to PostgreSQL
2. **Extensible**: Easy to add new database adapters
3. **Maintainable**: Identifier logic centralized in adapters
4. **Type Safe**: Proper TypeScript interfaces for all databases
5. **Consistent**: Same BaseORM API works across databases

## Conclusion

Moving identifier escaping to database adapters solves the MySQL compatibility issue while making the architecture more robust and extensible. The QueryParser becomes truly database-agnostic, and adding new database support becomes straightforward.
