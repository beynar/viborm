# Prisma Type System Analysis

This document analyzes the Prisma client type system based on the generated models (`Example.ts`, `OneToOne.ts`, `OneToMany.ts`, `ManyToOne.ts`, `ManyToMany.ts`) and compares it with VibORM's current implementation.

---

## Table of Contents

1. [Scalar Field Types](#1-scalar-field-types)
2. [Relation Types](#2-relation-types)
3. [Input Types by Operation](#3-input-types-by-operation)
4. [Filters (Where Input)](#4-filters-where-input)
5. [Update Operations](#5-update-operations)
6. [Relation Nested Operations](#6-relation-nested-operations)
7. [VibORM Compatibility Analysis](#7-viborm-compatibility-analysis)

---

## 1. Scalar Field Types

### Field Optionality Rules

| Field Configuration | CreateInput | UpdateInput | WhereInput |
|---------------------|-------------|-------------|------------|
| Required (`string`) | **REQUIRED** | Optional | Optional |
| Nullable (`string?`) | Optional (`string \| null`) | Optional (`string \| null`) | Optional |
| With Default (`@default`) | Optional | Optional | Optional |
| Auto-generated ID (`@id @default(...)`) | Optional | Optional | Optional |
| Array (`string[]`) | Optional (`string[]`) | Optional (`string[]`) | Optional (ListFilter) |

### Prisma Examples

```typescript
// CreateInput - required field is REQUIRED
export type ExampleCreateInput = {
  string: string                          // Required - NO ?
  nullableString?: string | null          // Optional - has ?
  stringWithDefault?: string              // Optional - has default
  arrayOfStrings?: string[]               // Optional - arrays always optional in create
}

// UpdateInput - ALL fields are optional
export type ExampleUpdateInput = {
  string?: StringFieldUpdateOperationsInput | string
  nullableString?: NullableStringFieldUpdateOperationsInput | string | null
  // ...
}
```

### Field Update Operations

Prisma wraps scalar updates in operation objects for atomic operations:

```typescript
// String
export type StringFieldUpdateOperationsInput = {
  set?: string
}

export type NullableStringFieldUpdateOperationsInput = {
  set?: string | null
}

// Number - supports atomic operations
export type IntFieldUpdateOperationsInput = {
  set?: number
  increment?: number
  decrement?: number
  multiply?: number
  divide?: number
}

// Array - supports set and push
export type ExampleUpdatearrayOfStringsInput = {
  set?: string[]
  push?: string | string[]
}
```

---

## 2. Relation Types

### Relation Filter Types

| Relation Type | Filter Type | Operations |
|---------------|-------------|------------|
| To-One (`oneToOne`, `manyToOne`) | `ScalarRelationFilter` | `is`, `isNot` |
| To-Many (`oneToMany`, `manyToMany`) | `ListRelationFilter` | `some`, `every`, `none` |

```typescript
// To-One Filter
export type OneToOneScalarRelationFilter = {
  is?: OneToOneWhereInput
  isNot?: OneToOneWhereInput
}

// To-Many Filter  
export type ExampleListRelationFilter = {
  every?: ExampleWhereInput
  some?: ExampleWhereInput
  none?: ExampleWhereInput
}
```

### Nullable vs Required Relations

```typescript
// Nullable to-one relation
export type ExampleNullableScalarRelationFilter = {
  is?: ExampleWhereInput | null      // Can be null
  isNot?: ExampleWhereInput | null   // Can be null
}

// Required to-one relation (no null option in filter)
export type OneToOneScalarRelationFilter = {
  is?: OneToOneWhereInput            // Cannot be null
  isNot?: OneToOneWhereInput         // Cannot be null
}
```

---

## 3. Input Types by Operation

### WhereInput

All fields are **optional**. Supports logical operators.

```typescript
export type ExampleWhereInput = {
  // Logical operators
  AND?: ExampleWhereInput | ExampleWhereInput[]
  OR?: ExampleWhereInput[]
  NOT?: ExampleWhereInput | ExampleWhereInput[]
  
  // Scalar filters - all optional
  string?: StringFilter<"Example"> | string      // Filter OR direct value
  nullableString?: StringNullableFilter<"Example"> | string | null
  
  // Relation filters
  oneToOne?: XOR<OneToOneScalarRelationFilter, OneToOneWhereInput>  // To-one
  oneToMany?: OneToManyListRelationFilter                           // To-many
}
```

**Key insight**: Prisma allows both a filter object OR a direct value:
- `string?: StringFilter | string` - can pass `"hello"` or `{ equals: "hello", contains: "ell" }`

### WhereUniqueInput

Uses `AtLeast<T, Keys>` to require at least one unique field.

```typescript
export type ExampleWhereUniqueInput = Prisma.AtLeast<{
  stringAsId?: string
  // ... all other fields as filters (not just unique ones!)
  AND?: ExampleWhereInput | ExampleWhereInput[]
  OR?: ExampleWhereInput[]
  NOT?: ExampleWhereInput | ExampleWhereInput[]
}, "stringAsId">  // Must provide at least stringAsId
```

### CreateInput vs UncheckedCreateInput

Prisma generates TWO create input types:

```typescript
// CreateInput - uses nested relations
export type ExampleCreateInput = {
  string: string
  // Relations use nested create/connect
  oneToOne: OneToOneCreateNestedOneWithoutExamplesInput
  manyToOne: ManyToOneCreateNestedOneWithoutExamplesInput
}

// UncheckedCreateInput - uses raw foreign keys
export type ExampleUncheckedCreateInput = {
  string: string
  // Foreign keys directly exposed
  oneToOneId: string
  manyToOneId: string
}
```

### CreateManyInput

**NO nested relations** - only scalar fields + foreign keys.

```typescript
export type ExampleCreateManyInput = {
  string: string
  stringAsId: string
  // Only foreign keys, no nested relations
  oneToOneId: string
  manyToOneId: string
}
```

---

## 4. Filters (Where Input)

### Scalar Filters

```typescript
// String Filter
export type StringFilter<$PrismaModel = never> = {
  equals?: string
  in?: string[]
  notIn?: string[]
  lt?: string
  lte?: string
  gt?: string
  gte?: string
  contains?: string
  startsWith?: string
  endsWith?: string
  mode?: QueryMode        // 'default' | 'insensitive'
  not?: NestedStringFilter | string
}

// Nullable String Filter - adds null options
export type StringNullableFilter<$PrismaModel = never> = {
  // ... all StringFilter fields
  equals?: string | null
  not?: NestedStringNullableFilter | string | null
}

// Int Filter - adds numeric comparisons
export type IntFilter<$PrismaModel = never> = {
  equals?: number
  in?: number[]
  notIn?: number[]
  lt?: number
  lte?: number
  gt?: number
  gte?: number
  not?: NestedIntFilter | number
}

// DateTime Filter
export type DateTimeFilter<$PrismaModel = never> = {
  equals?: Date | string
  in?: Date[] | string[]
  notIn?: Date[] | string[]
  lt?: Date | string
  lte?: Date | string
  gt?: Date | string
  gte?: Date | string
  not?: NestedDateTimeFilter | Date | string
}
```

### Array/List Filters

```typescript
export type StringNullableListFilter<$PrismaModel = never> = {
  equals?: string[] | null
  has?: string | null
  hasEvery?: string[]
  hasSome?: string[]
  isEmpty?: boolean
}
```

### JSON Filters

```typescript
export type JsonFilter<$PrismaModel = never> = {
  equals?: InputJsonValue | JsonFieldRefInput<$PrismaModel>
  path?: string[]
  mode?: QueryMode
  string_contains?: string
  string_starts_with?: string
  string_ends_with?: string
  array_contains?: InputJsonValue | null
  array_starts_with?: InputJsonValue | null
  array_ends_with?: InputJsonValue | null
  lt?: InputJsonValue
  lte?: InputJsonValue
  gt?: InputJsonValue
  gte?: InputJsonValue
  not?: InputJsonValue
}
```

---

## 5. Update Operations

### Scalar Field Updates

```typescript
// Can pass direct value OR operation object
export type ExampleUpdateInput = {
  string?: StringFieldUpdateOperationsInput | string
  number?: IntFieldUpdateOperationsInput | number
  // ...
}

// Operations available per type
StringFieldUpdateOperationsInput = { set?: string }
IntFieldUpdateOperationsInput = { set?, increment?, decrement?, multiply?, divide? }
BigIntFieldUpdateOperationsInput = { set?, increment?, decrement?, multiply?, divide? }
BoolFieldUpdateOperationsInput = { set?: boolean }
DateTimeFieldUpdateOperationsInput = { set?: Date | string }
EnumFieldUpdateOperationsInput = { set?: EnumValue }

// Array updates
ExampleUpdatearrayOfStringsInput = { set?: string[], push?: string | string[] }
```

---

## 6. Relation Nested Operations

### To-One Create Nested Input

```typescript
// Required to-one relation
export type OneToOneCreateNestedOneWithoutExamplesInput = {
  create?: OneToOneCreateWithoutExamplesInput
  connectOrCreate?: OneToOneCreateOrConnectWithoutExamplesInput
  connect?: OneToOneWhereUniqueInput
}

// Optional to-one relation (can be null)
export type ExampleCreateNestedOneWithoutOneToManyInput = {
  create?: ExampleCreateWithoutOneToManyInput
  connectOrCreate?: ExampleCreateOrConnectWithoutOneToManyInput
  connect?: ExampleWhereUniqueInput
}
```

### To-Many Create Nested Input

```typescript
export type ExampleCreateNestedManyWithoutOneToOneInput = {
  create?: ExampleCreateWithoutOneToOneInput | ExampleCreateWithoutOneToOneInput[]
  connectOrCreate?: ExampleCreateOrConnectWithoutOneToOneInput | ExampleCreateOrConnectWithoutOneToOneInput[]
  createMany?: ExampleCreateManyOneToOneInputEnvelope
  connect?: ExampleWhereUniqueInput | ExampleWhereUniqueInput[]
}

// CreateMany envelope
export type ExampleCreateManyOneToOneInputEnvelope = {
  data: ExampleCreateManyOneToOneInput | ExampleCreateManyOneToOneInput[]
  skipDuplicates?: boolean
}
```

### To-One Update Nested Input

```typescript
// Required relation - NO disconnect/delete (would violate constraint)
export type OneToOneUpdateOneRequiredWithoutExamplesNestedInput = {
  create?: OneToOneCreateWithoutExamplesInput
  connectOrCreate?: OneToOneCreateOrConnectWithoutExamplesInput
  upsert?: OneToOneUpsertWithoutExamplesInput
  connect?: OneToOneWhereUniqueInput
  update?: OneToOneUpdateToOneWithWhereWithoutExamplesInput
}

// Optional relation - CAN disconnect/delete
export type ExampleUpdateOneWithoutOneToManyNestedInput = {
  create?: ExampleCreateWithoutOneToManyInput
  connectOrCreate?: ExampleCreateOrConnectWithoutOneToManyInput
  upsert?: ExampleUpsertWithoutOneToManyInput
  disconnect?: ExampleWhereInput | boolean   // Can disconnect
  delete?: ExampleWhereInput | boolean       // Can delete
  connect?: ExampleWhereUniqueInput
  update?: ExampleUpdateToOneWithWhereWithoutOneToManyInput
}
```

### To-Many Update Nested Input

```typescript
export type ExampleUpdateManyWithoutOneToOneNestedInput = {
  create?: ExampleCreateWithoutOneToOneInput | ExampleCreateWithoutOneToOneInput[]
  connectOrCreate?: ExampleCreateOrConnectWithoutOneToOneInput[]
  upsert?: ExampleUpsertWithWhereUniqueWithoutOneToOneInput[]
  createMany?: ExampleCreateManyOneToOneInputEnvelope
  set?: ExampleWhereUniqueInput | ExampleWhereUniqueInput[]    // Replace all
  disconnect?: ExampleWhereUniqueInput | ExampleWhereUniqueInput[]
  delete?: ExampleWhereUniqueInput | ExampleWhereUniqueInput[]
  connect?: ExampleWhereUniqueInput | ExampleWhereUniqueInput[]
  update?: ExampleUpdateWithWhereUniqueWithoutOneToOneInput[]
  updateMany?: ExampleUpdateManyWithWhereWithoutOneToOneInput[]
  deleteMany?: ExampleScalarWhereInput[]
}
```

### Nested Operation Shapes

```typescript
// ConnectOrCreate
export type ExampleCreateOrConnectWithoutOneToOneInput = {
  where: ExampleWhereUniqueInput
  create: ExampleCreateWithoutOneToOneInput
}

// Upsert for to-one
export type OneToOneUpsertWithoutExamplesInput = {
  update: OneToOneUpdateWithoutExamplesInput
  create: OneToOneCreateWithoutExamplesInput
  where?: OneToOneWhereInput
}

// Upsert for to-many
export type ExampleUpsertWithWhereUniqueWithoutOneToOneInput = {
  where: ExampleWhereUniqueInput
  update: ExampleUpdateWithoutOneToOneInput
  create: ExampleCreateWithoutOneToOneInput
}

// Update with where for to-many
export type ExampleUpdateWithWhereUniqueWithoutOneToOneInput = {
  where: ExampleWhereUniqueInput
  data: ExampleUpdateWithoutOneToOneInput
}

// UpdateMany with where
export type ExampleUpdateManyWithWhereWithoutOneToOneInput = {
  where: ExampleScalarWhereInput    // Note: ScalarWhereInput, not WhereInput
  data: ExampleUpdateManyMutationInput
}
```

---

## 7. VibORM Compatibility Analysis

### ✅ What We Have (Compatible)

| Feature | Status | Notes |
|---------|--------|-------|
| Basic scalar field types | ✅ | string, number, boolean, datetime, etc. |
| Nullable fields | ✅ | `T \| null` |
| Optional fields (with defaults) | ✅ | Using `T \| undefined` |
| Array fields | ✅ | `T[]` |
| WhereInput with AND/OR/NOT | ✅ | Type-level implementation |
| WhereUniqueInput | ⚠️ | Missing `AtLeast<>` constraint |
| ToOne relation create (create/connect/connectOrCreate) | ✅ | |
| ToMany relation create (create/connect/connectOrCreate) | ✅ | |
| ToOne relation update (create/connect/disconnect/delete/update/upsert) | ✅ | |
| ToMany relation update (all operations) | ✅ | |
| ToOne relation filter (is/isNot) | ✅ | |
| ToMany relation filter (some/every/none) | ✅ | |

### ⚠️ Partial Compatibility

| Feature | Status | What's Missing |
|---------|--------|----------------|
| Scalar filters | ⚠️ | Missing `mode`, `not` nesting |
| Filter shorthand | ⚠️ | Prisma allows `string?: Filter \| string` (direct value) |
| UncheckedCreateInput | ❌ | No foreign key direct access |
| CreateManyInput | ⚠️ | Currently same as CreateInput, should exclude relations |

### ❌ Missing Features

| Feature | Priority | Notes |
|---------|----------|-------|
| **AtLeast<T, Keys>** utility | High | WhereUnique should require at least one unique field |
| **Field Update Operations** | High | `{ set?, increment?, decrement? }` for numbers |
| **Array operations** | Medium | `push` operation for arrays |
| **UncheckedCreate/Update** | Medium | Direct FK access |
| **createMany envelope** | Medium | `{ data: [], skipDuplicates? }` |
| **ScalarWhereInput** | Medium | Separate type without relations for `deleteMany`/`updateMany` |
| **OrderBy with nulls** | Low | `{ nulls: 'first' \| 'last' }` |
| **OrderBy for relations** | Low | `{ _count: 'asc' }` |
| **Aggregations** | Low | `_count`, `_avg`, `_sum`, `_min`, `_max` |
| **GroupBy** | Low | Group by with having clause |
| **Cursor pagination** | Low | `cursor` in find args |
| **Distinct** | Low | `distinct: ['field1', 'field2']` |

### Detailed Gaps

#### 1. WhereUniqueInput needs AtLeast

```typescript
// Prisma
type ExampleWhereUniqueInput = AtLeast<{
  stringAsId?: string
  // ... other fields
}, "stringAsId">

// VibORM - missing the AtLeast constraint
type ModelWhereUniqueInput = {
  [K in keyof TFields as IsUnique<K>]?: InferFieldBase<TFields[K]>;
}
```

#### 2. Field Update Operations

```typescript
// Prisma
string?: StringFieldUpdateOperationsInput | string

// VibORM - only supports the value directly
string?: { set?: string }  // Should also support just `string`
```

#### 3. Filter Shorthand

```typescript
// Prisma allows:
where: { name: "Alice" }            // Shorthand
where: { name: { equals: "Alice" }} // Full filter

// VibORM only supports full filter
```

#### 4. CreateMany Should Exclude Relations

```typescript
// Prisma CreateManyInput - NO nested relations
export type ExampleCreateManyInput = {
  string: string
  oneToOneId: string  // Only FK, no nested create
}

// VibORM - currently includes relations
```

#### 5. Required vs Optional Relation Updates

```typescript
// Prisma - required relations can't disconnect/delete
type OneToOneUpdateOneRequiredNestedInput = {
  // NO disconnect, NO delete
}

// VibORM - doesn't distinguish required vs optional
```

---

## Summary: Priority Fixes

### High Priority (Core Prisma Compatibility)

1. **Add filter shorthand** - Allow `field: value` as shorthand for `field: { equals: value }`
2. **Add field update operations** - `{ set, increment, decrement, multiply, divide }` for numbers
3. **Add AtLeast for WhereUnique** - Type constraint for unique fields
4. **Separate CreateManyInput** - Exclude nested relations, only scalar + FKs

### Medium Priority (Enhanced Compatibility)

5. **Add array push operation** - `{ set?, push? }` for array updates
6. **Add UncheckedCreate/Update** - Direct FK access types
7. **Required vs optional relation handling** - No disconnect/delete for required relations
8. **Add createMany envelope** - `{ data: [], skipDuplicates? }`

### Low Priority (Advanced Features)

9. Aggregations (`_count`, `_avg`, etc.)
10. GroupBy with having
11. Cursor pagination
12. Distinct queries
13. OrderBy with nulls handling

