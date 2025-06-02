# Field Introspection - Direct Property Access

## Overview

All field, model, and relation properties are now directly accessible as public properties, eliminating the need for getter functions with `~` prefixes.

## Field Properties

### BaseField Properties

All field types inherit these common properties:

```typescript
import { s } from "viborm";

const field = s.string().nullable().unique().default("hello");

// Direct property access
console.log(field.fieldType); // "string"
console.log(field.isOptional); // true (due to nullable())
console.log(field.isUnique); // true (due to unique())
console.log(field.isId); // false
console.log(field.isList); // false
console.log(field.defaultValue); // "hello"
console.log(field.autoGenerate); // undefined

// ID field with auto-generation
const idField = s.string().id().auto.uuid();
console.log(idField.isId); // true
console.log(idField.autoGenerate); // "uuid"

// List field
const listField = s.string().list();
console.log(listField.isList); // true
```

### String Field Properties

String fields only have the common base properties:

```typescript
const stringField = s.string();
console.log(stringField.fieldType); // "string"
```

### Number Field Properties

Number fields only have the common base properties:

```typescript
const intField = s.int();
const floatField = s.float();
const decimalField = s.decimal();

console.log(intField.fieldType); // "int"
console.log(floatField.fieldType); // "float"
console.log(decimalField.fieldType); // "decimal"
```

### Enum Field Properties

Enum fields have an additional `enumValues` property:

```typescript
const statusField = s.enum(["active", "inactive", "pending"]);

console.log(statusField.fieldType); // "enum"
console.log(statusField.enumValues); // ["active", "inactive", "pending"]
```

## Model Properties

Model instances expose their internal structure:

```typescript
const userModel = s.model("user", {
  id: s.string().id().auto.uuid(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.relation.many(() => postModel),
});

// Direct property access
console.log(userModel.name); // "user"
console.log(userModel.tableName); // undefined (until .map() is called)
console.log(userModel.fields); // Map of field definitions
console.log(userModel.relations); // Map of relation definitions
console.log(userModel.indexes); // Array of index definitions
console.log(userModel.uniqueConstraints); // Array of unique constraint definitions

// After mapping to a table
userModel.map("users");
console.log(userModel.tableName); // "users"

// Accessing individual fields
const nameField = userModel.fields.get("name");
console.log(nameField?.fieldType); // "string"
console.log(nameField?.isOptional); // false

// Accessing relations
const postsRelation = userModel.relations.get("posts");
console.log(postsRelation?.relationType); // "many"
```

## Relation Properties

Relation instances expose their configuration:

```typescript
const userRelation = s.relation
  .one(() => User)
  .on("userId")
  .ref("id")
  .cascade({ delete: "CASCADE" });

// Direct property access
console.log(userRelation.relationType); // "one"
console.log(userRelation.targetModel); // Function that returns User
console.log(userRelation.onField); // "userId"
console.log(userRelation.refField); // "id"
console.log(userRelation.cascadeOptions); // { delete: "CASCADE" }
console.log(userRelation.junctionTableName); // undefined (for one-to-one/one-to-many)
console.log(userRelation.junctionFieldName); // undefined
```

## Type Safety

All properties maintain full type safety:

```typescript
// TypeScript knows the exact types
const field = s.string().nullable();
const fieldType: "string" | undefined = field.fieldType;
const isOptional: boolean = field.isOptional;
const defaultValue: string | (() => string) | undefined = field.defaultValue;

// Enum values are strongly typed
const statusEnum = ["active", "inactive"] as const;
const statusField = s.enum(statusEnum);
const enumValues: readonly ["active", "inactive"] = statusField.enumValues;
```

## Introspection Patterns

### Field Analysis

```typescript
function analyzeField(field: BaseField<any>) {
  console.log(`Field type: ${field.fieldType}`);
  console.log(`Optional: ${field.isOptional}`);
  console.log(`Unique: ${field.isUnique}`);
  console.log(`ID field: ${field.isId}`);
  console.log(`List field: ${field.isList}`);

  if (field.defaultValue !== undefined) {
    console.log(`Default value: ${field.defaultValue}`);
  }

  if (field.autoGenerate) {
    console.log(`Auto-generate: ${field.autoGenerate}`);
  }
}
```

### Model Analysis

```typescript
function analyzeModel(model: Model<any>) {
  console.log(`Model name: ${model.name}`);
  console.log(`Table name: ${model.tableName || "not mapped"}`);
  console.log(`Fields: ${model.fields.size}`);
  console.log(`Relations: ${model.relations.size}`);
  console.log(`Indexes: ${model.indexes.length}`);
  console.log(`Unique constraints: ${model.uniqueConstraints.length}`);

  // Analyze each field
  for (const [fieldName, field] of model.fields) {
    console.log(
      `  ${fieldName}: ${field.fieldType} ${
        field.isOptional ? "(optional)" : "(required)"
      }`
    );
  }

  // Analyze each relation
  for (const [relationName, relation] of model.relations) {
    console.log(`  ${relationName}: ${relation.relationType} relation`);
  }
}
```

## Migration from Getter Functions

### Before (❌ Removed)

```typescript
// These methods no longer exist
field["~getType"]();
field["~getIsOptional"]();
field["~getIsUnique"]();
model["~getFields"]();
model["~getName"]();
relation["~getRelationType"]();
```

### After (✅ Direct Access)

```typescript
// Use direct property access instead
field.fieldType;
field.isOptional;
field.isUnique;
model.fields;
model.name;
relation.relationType;
```

## Benefits

1. **Simpler API**: Direct property access is more intuitive than method calls
2. **Better Performance**: No function call overhead for property access
3. **Cleaner Autocompletion**: Properties appear naturally in IDE suggestions
4. **Type Safety**: Properties maintain exact TypeScript types
5. **Debugging**: Easier to inspect objects in debuggers and logs

This approach provides direct, efficient access to all field and model metadata while maintaining full type safety.
