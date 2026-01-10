# Bug Report: Type Issues in Relation Query Results

This document covers multiple bugs related to field types when accessed through relations.

---

# Bug 1: Enum Literal Types Widened to `string` Through Relations

**Type:** Type inference bug (compile-time only, runtime correct)

## Summary

When querying a model through a relation (via `include`), enum field types are incorrectly widened from their literal union type (e.g., `"ACTIVE" | "INACTIVE" | "PENDING"`) to `string`.

## Reproduction

```typescript
const parentModel = s.model({
  id: s.string().id(),
  status: s.enum(["ACTIVE", "INACTIVE", "PENDING"]),
  children: s.oneToMany(() => childModel),
});

const childModel = s.model({
  id: s.string().id(),
  parentId: s.string(),
  parent: s.manyToOne(() => parentModel).fields("parentId").references("id"),
});

// Direct query - WORKS ✅
const parent = await client.parentModel.findUnique({ where: { id: "1" } });
// parent.status is typed as: "ACTIVE" | "INACTIVE" | "PENDING"

// Query through relation - BUG ❌
const child = await client.childModel.findUnique({
  where: { id: "1" },
  include: { parent: true },
});
// child.parent.status is typed as: string  <-- Should be "ACTIVE" | "INACTIVE" | "PENDING"
```

## Root Cause Analysis

The type inference chain breaks at the `ModelState` interface definition:

### Location: `src/schema/model/model.ts`

```typescript
export interface ModelState {
  fields: FieldRecord;
  scalars: Record<string, Field>;  // ❌ Field union loses specific EnumField<Values>
  relations: Record<string, AnyRelation>;
  // ...
}
```

The `scalars` property is typed as `Record<string, Field>`, where `Field` is the union of all field types. This causes the specific `EnumField<["ACTIVE", "INACTIVE", "PENDING"]>` to be widened to just `Field`.

### Type Flow Breakdown

1. **Relation result inference** (`src/client/result-types.ts`):
   ```typescript
   export type InferRelationResult<R extends AnyRelation> = 
     InferModelOutput<GetTargetModelState<R>>[];
   ```

2. **Target model state extraction**:
   ```typescript
   export type GetTargetModelState<R extends AnyRelation> =
     R["~"]["state"]["getter"] extends () => infer T
       ? T extends Model<infer S> ? S : never
       : never;
   ```

3. **Model output inference** iterates over `S["scalars"]`:
   ```typescript
   export type InferModelOutput<S extends ModelState> = {
     [K in keyof S["scalars"]]: S["scalars"][K] extends Field
       ? InferScalarOutput<S["scalars"][K]>
       : never;
   };
   ```

4. **Enum type extraction** in `GetScalarResultType`:
   ```typescript
   : S["type"] extends "enum"
     ? F extends EnumField<infer Values, any>  // ❌ F is Field, not EnumField<specific>
       ? Values[number]
       : never
   ```

At step 4, `F` is `Field` (the union type), not the specific `EnumField<["ACTIVE", "INACTIVE", "PENDING"]>`. The `infer Values` fails to extract the literal values, falling through to `never` or defaulting to `string`.

## Why Direct Queries Work

Direct queries preserve types because the Model generic parameter `State` carries the exact field types through the type system:

```typescript
// In client.ts - direct model access
type ModelProxy<M extends Model<any>> = {
  findUnique: <Args>(args: Args) => InferSelectInclude<M["~"]["state"], Args>;
};
```

The `M["~"]["state"]` preserves the specific field types because it's directly accessing the model's state generic parameter.

## Potential Fix Approaches

### Option 1: Preserve Field Types in ModelState

Change `ModelState.scalars` to preserve specific field types:

```typescript
export interface ModelState<
  Scalars extends Record<string, Field> = Record<string, Field>
> {
  scalars: Scalars;  // Preserves specific EnumField<Values> types
  // ...
}
```

**Pros:** Clean fix at the source
**Cons:** Requires updating all ModelState usages to carry the generic parameter

### Option 2: Store Enum Values in FieldState

Add enum values to the FieldState itself:

```typescript
// In common.ts
export interface FieldState<T extends ScalarFieldType = ScalarFieldType> {
  type: T;
  enumValues?: readonly string[];  // Store enum values in state
  // ...
}

// In GetScalarResultType
: S["type"] extends "enum"
  ? S["enumValues"] extends readonly (infer V)[]
    ? V
    : string
```

**Pros:** Doesn't require generic parameter changes
**Cons:** Duplicates data (values in both EnumField and FieldState)

### Option 3: Use Type Branding for Enum Values

Store enum values as a branded type in FieldState:

```typescript
type EnumValues<V extends readonly string[]> = V & { __brand: "enumValues" };

export interface FieldState<T extends ScalarFieldType = ScalarFieldType> {
  type: T;
  values?: T extends "enum" ? EnumValues<readonly string[]> : undefined;
}
```

## Affected Areas

1. **All relation queries with `include`** - enum fields return `string` type
2. **Nested includes** - same issue at any nesting depth
3. **Select queries on relations** - enum fields in selected relations

## Runtime Behavior

Runtime behavior is **correct** - enum values are properly returned as their literal values. Only the TypeScript type inference is affected.

## Workaround

Users can cast the result or use type assertions:

```typescript
const child = await client.childModel.findUnique({
  where: { id: "1" },
  include: { parent: true },
});

// Workaround: type assertion
const status = child.parent.status as "ACTIVE" | "INACTIVE" | "PENDING";
```

## Priority

**Medium** - Type safety is degraded but runtime behavior is correct. This affects developer experience and IDE autocomplete for enum fields through relations.

## Related Files

- `src/schema/model/model.ts` - ModelState interface
- `src/client/result-types.ts` - GetScalarResultType, InferModelOutput
- `src/schema/fields/enum/field.ts` - EnumField class
- `src/schema/fields/common.ts` - FieldState interface

---

# Bug 2: DateTime/Date Fields Returned as Strings Through Relations

**Type:** Runtime bug (data incorrectly deserialized)

**Priority:** High

## Summary

When querying through relations, `datetime` and `date` fields are returned as ISO strings instead of `Date` objects. Direct queries correctly return `Date` objects.

## Evidence

```
DateTime through relation - actual type: string
DateTime through relation - instanceof Date: false
DateTime through relation - value: 2024-06-15T14:30:00+00:00
```

## Reproduction

```typescript
const parent = s.model({
  id: s.string().id(),
  createdAt: s.dateTime(),
  children: s.oneToMany(() => child),
});

const child = s.model({
  id: s.string().id(),
  parentId: s.string(),
  parent: s.manyToOne(() => parent).fields("parentId").references("id"),
});

// Direct query - WORKS ✅
const p = await client.parent.findUnique({ where: { id: "1" } });
console.log(p.createdAt instanceof Date);  // true

// Through relation - BUG ❌
const c = await client.child.findUnique({
  where: { id: "1" },
  include: { parent: true },
});
console.log(c.parent.createdAt instanceof Date);  // false - it's a string!
console.log(typeof c.parent.createdAt);            // "string"
```

## Impact

- Code expecting `Date` objects will fail (e.g., `date.getFullYear()`)
- Type says `Date` but runtime is `string` - breaks type safety contract
- Users must manually parse dates from relations: `new Date(c.parent.createdAt)`

## Likely Root Cause

The relation result parser is not applying the same date deserialization that direct queries use. The raw PostgreSQL/JSON response contains ISO strings, and the deserializer needs to convert them to `Date` objects.

**Investigation areas:**
- `src/client/` - Result parsing/deserialization
- `src/query-engine/` - Relation query result processing
- `src/drivers/` - How relation data is fetched and parsed

---

# Bug 3: BigInt Fields Returned as Numbers Through Relations

**Type:** Runtime bug (data incorrectly deserialized)

**Priority:** High

## Summary

When querying through relations, `bigint` fields are returned as JavaScript `number` instead of `bigint`. This can cause precision loss for large values.

## Evidence

```
BigInt through relation - actual type: number
BigInt through relation - value: 9007199254740991
BigInt through relation - is bigint: false
```

## Reproduction

```typescript
const parent = s.model({
  id: s.string().id(),
  bigValue: s.bigInt(),
  children: s.oneToMany(() => child),
});

const child = s.model({
  id: s.string().id(),
  parentId: s.string(),
  parent: s.manyToOne(() => parent).fields("parentId").references("id"),
});

// Direct query - WORKS ✅
const p = await client.parent.findUnique({ where: { id: "1" } });
console.log(typeof p.bigValue);  // "bigint"

// Through relation - BUG ❌
const c = await client.child.findUnique({
  where: { id: "1" },
  include: { parent: true },
});
console.log(typeof c.parent.bigValue);  // "number" - should be "bigint"!
```

## Impact

- **Precision loss:** Numbers larger than `Number.MAX_SAFE_INTEGER` (9007199254740991) will lose precision
- **Type mismatch:** Type says `bigint` but runtime is `number`
- **Arithmetic issues:** `bigValue + 1n` will throw "Cannot mix BigInt and other types"

## Likely Root Cause

Same as Bug 2 - the relation result parser is not applying bigint conversion. JSON doesn't have a native bigint type, so the deserializer must convert string/number representations to `BigInt()`.

---

# Summary Table

| Bug | Type | Field | Expected | Actual | Status |
|-----|------|-------|----------|--------|--------|
| 1 | Type inference | enum | `"A" \| "B"` | `string` | **Open** (Medium) |
| 2 | Runtime | datetime/date | `Date` | `string` | **FIXED** |
| 3 | Runtime | bigint | `bigint` | `number` | **FIXED** |

## Fix Applied

Bugs 2 and 3 were fixed in `src/query-engine/result/result-parser.ts` by making the result parser schema-aware. The parser now:
1. Uses the model schema to identify field types
2. Converts ISO strings to `Date` objects for datetime/date fields
3. Converts numbers to `bigint` for bigint fields
4. Recursively handles nested relations using target model schema

## Common Root Cause Hypothesis

All three bugs stem from the relation query result processing not applying the same field-type-aware deserialization that direct queries use.

**Direct query flow:**
```
Database → Driver → Deserializer (type-aware) → Client
                         ↓
              Date strings → Date objects
              BigInt strings → bigint
```

**Relation query flow:**
```
Database → Driver → JSON aggregation → Client
                         ↓
              No type-aware deserialization!
              Dates stay as strings
              BigInts become numbers
```

The fix likely involves ensuring relation results pass through the same deserialization pipeline as direct query results.

