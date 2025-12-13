# Field Implementation Guide

This guide explains how to implement schema and field classes inside the `fields/` folder. It follows the patterns established in the string field implementation.

## Directory Structure

Each field type has its own folder with three files:

```
fields/
├── [type]/
│   ├── index.ts      # Re-exports from field.ts and schemas.ts
│   ├── field.ts      # Field class (lean, no schema logic)
│   └── schemas.ts    # All Zod schemas and type inference
├── common.ts         # Shared utilities (FieldState, shorthand helpers, etc.)
├── base.ts           # Field union type and type guards
├── types.ts          # Legacy types (being phased out)
└── index.ts          # Main exports
```

## Core Principles

1. **Separation of Concerns**: The field class (`field.ts`) is lean and delegates all schema logic to `schemas.ts`
2. **Consistent Naming**: Use `[Type]`, `[Type]Nullable`, `[Type]List`, `[Type]ListNullable`
3. **Shorthand Normalization**: All filter and update schemas pipe shorthands to normalized objects (`{equals: v}` or `{set: v}`)
4. **Type Inference**: Build type helpers that infer schema types from `FieldState`

## Naming Convention

### Base Types
- `[type]Base` - Non-nullable single value (e.g., `stringBase`)
- `[type]Nullable` - Nullable single value (e.g., `stringNullable`)
- `[type]List` - Non-nullable array (e.g., `stringList`)
- `[type]ListNullable` - Nullable array (the array itself is nullable, not elements)

### Filter Schemas
- `[type]Filter` - Filter for non-nullable single value
- `[type]NullableFilter` - Filter for nullable single value
- `[type]ListFilter` - Filter for non-nullable array
- `[type]ListNullableFilter` - Filter for nullable array

### Create Schemas
- `[type]Create` - Required non-nullable create
- `[type]NullableCreate` - Required nullable create
- `[type]OptionalCreate` - Optional non-nullable create (has default)
- `[type]OptionalNullableCreate` - Optional nullable create
- `[type]ListCreate` - Required non-nullable array create
- `[type]ListNullableCreate` - Required nullable array create
- `[type]OptionalListCreate` - Optional non-nullable array create
- `[type]OptionalListNullableCreate` - Optional nullable array create

### Update Schemas
- `[type]Update` - Update for non-nullable single value
- `[type]NullableUpdate` - Update for nullable single value
- `[type]ListUpdate` - Update for non-nullable array
- `[type]ListNullableUpdate` - Update for nullable array

## Implementation Steps

### Step 1: Define Base Types in `schemas.ts`

```typescript
import {
  array,
  boolean,
  literal,
  nullable,
  object,
  optional,
  partial,
  string, // or number, bigint, etc.
  union,
  extend,
  type input as Input,
} from "zod/v4-mini";
import {
  FieldState,
  isOptional,
  shorthandFilter,
  shorthandUpdate,
} from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

export const [type]Base = string(); // Replace with appropriate Zod type
export const [type]Nullable = nullable([type]Base);
export const [type]List = array([type]Base);
export const [type]ListNullable = nullable([type]List);
```

### Step 2: Define Filter Base Schemas (without `not`)

These are used for recursive `not` definitions:

```typescript
// =============================================================================
// FILTER BASE SCHEMAS (without `not` - used for recursion)
// =============================================================================

const [type]FilterBase = partial(
  object({
    equals: [type]Base,
    in: array([type]Base),
    notIn: array([type]Base),
    // Add type-specific filters (e.g., contains, startsWith for strings)
    lt: [type]Base,
    lte: [type]Base,
    gt: [type]Base,
    gte: [type]Base,
  })
);

const [type]NullableFilterBase = partial(
  object({
    equals: [type]Nullable,
    in: array([type]Base),
    notIn: array([type]Base),
    lt: [type]Nullable,
    lte: [type]Nullable,
    gt: [type]Nullable,
    gte: [type]Nullable,
  })
);

const [type]ListFilterBase = partial(
  object({
    equals: [type]List,
    has: [type]Base,
    hasEvery: array([type]Base),
    hasSome: array([type]Base),
    isEmpty: boolean(),
  })
);

const [type]ListNullableFilterBase = partial(
  object({
    equals: [type]ListNullable,
    has: [type]Base,
    hasEvery: array([type]Base),
    hasSome: array([type]Base),
    isEmpty: boolean(),
  })
);
```

### Step 3: Define Complete Filter Schemas (with `not` and shorthand)

```typescript
// =============================================================================
// FILTER SCHEMAS (with `not` and shorthand normalization)
// =============================================================================

const [type]Filter = union([
  extend([type]FilterBase, {
    not: optional(union([[type]FilterBase, shorthandFilter([type]Base)])),
  }),
  shorthandFilter([type]Base),
]);

const [type]NullableFilter = union([
  extend([type]NullableFilterBase, {
    not: optional(union([[type]NullableFilterBase, [type]Nullable])),
  }),
  shorthandFilter([type]Nullable),
]);

const [type]ListFilter = union([
  extend([type]ListFilterBase, {
    not: optional(union([[type]ListFilterBase, shorthandFilter([type]List)])),
  }),
  shorthandFilter([type]List),
]);

const [type]ListNullableFilter = union([
  extend([type]ListNullableFilterBase, {
    not: optional(
      union([[type]ListNullableFilterBase, shorthandFilter([type]ListNullable)])
    ),
  }),
  shorthandFilter([type]ListNullable),
]);
```

### Step 4: Define Create Schemas

```typescript
// =============================================================================
// CREATE SCHEMAS
// =============================================================================

export const [type]Create = [type]Base;
export const [type]NullableCreate = _default(optional([type]Nullable), null);
export const [type]OptionalCreate = optional([type]Base);
export const [type]OptionalNullableCreate = _default(
  optional([type]Nullable),
  null
);

// List creates
export const [type]ListCreate = [type]List;
export const [type]ListNullableCreate = _default(
  optional([type]ListNullable),
  null
);
export const [type]OptionalListCreate = optional([type]List);
export const [type]OptionalListNullableCreate = _default(
  optional([type]ListNullable),
  null
);
```

### Step 5: Define Update Schemas (with shorthand normalization)

```typescript
// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

export const [type]Update = union([
  partial(object({ set: [type]Base })),
  shorthandUpdate([type]Base),
]);

export const [type]NullableUpdate = union([
  partial(object({ set: [type]Nullable })),
  shorthandUpdate([type]Nullable),
]);

export const [type]ListUpdate = union([
  partial(
    object({
      set: array([type]Base),
      push: union([[type]Base, array([type]Base)]),
      unshift: union([[type]Base, array([type]Base)]), // VibORM extension
    })
  ),
  shorthandUpdate([type]List),
]);

export const [type]ListNullableUpdate = union([
  partial(
    object({
      set: [type]ListNullable,
      push: union([[type]Base, [type]List]),
      unshift: union([[type]Base, [type]List]), // VibORM extension
    })
  ),
  shorthandUpdate([type]ListNullable),
]);
```

### Step 6: Build Schema Factory Functions

These functions return the appropriate schemas based on field configuration:

```typescript
// =============================================================================
// SCHEMA FACTORY FUNCTIONS
// =============================================================================

export const [type]Schemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: [type]Base,
    filter: [type]Filter,
    create: (o === true
      ? [type]OptionalCreate
      : [type]Create) as Optional extends true
      ? typeof [type]OptionalCreate
      : typeof [type]Create,
    update: [type]Update,
  };
};

export const [type]NullableSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: [type]Nullable,
    filter: [type]NullableFilter,
    create: (o === true
      ? [type]OptionalNullableCreate
      : [type]NullableCreate) as Optional extends true
      ? typeof [type]OptionalNullableCreate
      : typeof [type]NullableCreate,
    update: [type]NullableUpdate,
  };
};

export const [type]ListSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: [type]List,
    filter: [type]ListFilter,
    create: (o === true
      ? [type]OptionalListCreate
      : [type]ListCreate) as Optional extends true
      ? typeof [type]OptionalListCreate
      : typeof [type]ListCreate,
    update: [type]ListUpdate,
  };
};

export const [type]ListNullableSchemas = <Optional extends boolean>(o: Optional) => {
  return {
    base: [type]ListNullable,
    filter: [type]ListNullableFilter,
    create: (o === true
      ? [type]OptionalListNullableCreate
      : [type]ListNullableCreate) as Optional extends true
      ? typeof [type]OptionalListNullableCreate
      : typeof [type]ListNullableCreate,
    update: [type]ListNullableUpdate,
  };
};
```

### Step 7: Define Type Helpers

```typescript
// =============================================================================
// TYPE HELPERS
// =============================================================================

export type [Type]ListNullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof [type]ListNullableSchemas<Optional>>;

export type [Type]ListSchemas<Optional extends boolean = false> = 
  ReturnType<typeof [type]ListSchemas<Optional>>;

export type [Type]NullableSchemas<Optional extends boolean = false> =
  ReturnType<typeof [type]NullableSchemas<Optional>>;

export type [Type]Schemas<Optional extends boolean = false> = 
  ReturnType<typeof [type]Schemas<Optional>>;

export type Infer[Type]Schemas<F extends FieldState<"[type]">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? [Type]ListNullableSchemas<isOptional<F>>
      : [Type]ListSchemas<isOptional<F>>
    : F["nullable"] extends true
    ? [Type]NullableSchemas<isOptional<F>>
    : [Type]Schemas<isOptional<F>>;
```

### Step 8: Build the Main Schema Getter

```typescript
// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getField[Type]Schemas = <F extends FieldState<"[type]">>(f: F) => {
  const isOpt = f.hasDefault || f.nullable;
  const isArr = f.array;
  return (
    isArr
      ? isOpt
        ? [type]ListNullableSchemas(isOpt)
        : [type]ListSchemas(isOpt)
      : isOpt
      ? [type]NullableSchemas(isOpt)
      : [type]Schemas(isOpt)
  ) as Infer[Type]Schemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type Infer[Type]Input<
  F extends FieldState<"[type]">,
  Type extends "create" | "update" | "filter"
> = Input<Infer[Type]Schemas<F>[Type]>;
```

### Step 9: Implement the Field Class in `field.ts`

The field class should be lean, delegating schema logic to `schemas.ts`:

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import { getField[Type]Schemas } from "./schemas";

export class [Type]Field<State extends FieldState<"[type]">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  // Chainable modifiers - return new instance with updated state
  nullable(): [Type]Field<UpdateState<State, { nullable: true }>> {
    return new [Type]Field({ ...this.state, nullable: true }, this._nativeType);
  }

  array(): [Type]Field<UpdateState<State, { array: true }>> {
    return new [Type]Field({ ...this.state, array: true }, this._nativeType);
  }

  id(): [Type]Field<UpdateState<State, { isId: true; isUnique: true }>> {
    return new [Type]Field(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): [Type]Field<UpdateState<State, { isUnique: true }>> {
    return new [Type]Field({ ...this.state, isUnique: true }, this._nativeType);
  }

  default(
    value: DefaultValue<[BaseType], State["array"], State["nullable"]>
  ): [Type]Field<UpdateState<State, { hasDefault: true }>> {
    return new [Type]Field(
      { ...this.state, hasDefault: true, defaultValue: value },
      this._nativeType
    );
  }

  schema(
    s: StandardSchemaV1
  ): [Type]Field<UpdateState<State, { schema: StandardSchemaV1 }>> {
    return new [Type]Field(
      { ...this.state, schema: s },
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new [Type]Field(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // Internal accessor - returns state and computed schemas
  get ["~"]() {
    return {
      state: this.state,
      schemas: getField[Type]Schemas(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// Factory function
export const [type] = (nativeType?: NativeType) =>
  new [Type]Field(createDefaultState("[type]"), nativeType);
```

## Shorthand Normalization

The `shorthandFilter` and `shorthandUpdate` helpers in `common.ts` ensure that:

1. **Filters**: A direct value like `{ name: "Alice" }` is normalized to `{ name: { equals: "Alice" } }`
2. **Updates**: A direct value like `{ name: "Bob" }` is normalized to `{ name: { set: "Bob" } }`

This simplifies query engine logic by guaranteeing a consistent shape.

```typescript
// From common.ts
export const shorthandFilter = <Z extends ZodMiniType>(
  schema: Z
): ZodMiniType<{ equals: output<Z> }, Z["_zod"]["input"]> =>
  pipe(schema, transform((v) => ({ equals: v })));

export const shorthandUpdate = <Z extends ZodMiniType>(
  schema: Z
): ZodMiniType<{ set: output<Z> }, Z["_zod"]["input"]> =>
  pipe(schema, transform((v) => ({ set: v })));
```

## Type-Specific Filter & Update Operations (Prisma Parity + Extensions)

Filter and update schemas vary significantly by type. We aim for **feature parity with Prisma**, plus additional **VibORM extensions** marked with *(VibORM extension)*.

### VibORM Extensions Beyond Prisma
- `unshift` for array updates (prepend to array)

---

### String Fields

**Filter Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `equals` | `string` | Exact match |
| `not` | `string \| Filter` | Negation (value or nested filter) |
| `in` | `string[]` | Value in array |
| `notIn` | `string[]` | Value not in array |
| `lt` | `string` | Less than (lexicographic) |
| `lte` | `string` | Less than or equal |
| `gt` | `string` | Greater than |
| `gte` | `string` | Greater than or equal |
| `contains` | `string` | Contains substring |
| `startsWith` | `string` | Starts with prefix |
| `endsWith` | `string` | Ends with suffix |
| `mode` | `"default" \| "insensitive"` | Case sensitivity mode |

**List Filter Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `equals` | `string[]` | Exact array match |
| `has` | `string` | Array contains element |
| `hasEvery` | `string[]` | Array contains all elements |
| `hasSome` | `string[]` | Array contains any element |
| `isEmpty` | `boolean` | Array is empty |

**Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `string` | Set value |

**List Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `string[]` | Replace entire array |
| `push` | `string \| string[]` | Append to array |
| `unshift` | `string \| string[]` | Prepend to array *(VibORM extension)* |

---

### Int / Float / Decimal Fields

**Filter Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `equals` | `number` | Exact match |
| `not` | `number \| Filter` | Negation |
| `in` | `number[]` | Value in array |
| `notIn` | `number[]` | Value not in array |
| `lt` | `number` | Less than |
| `lte` | `number` | Less than or equal |
| `gt` | `number` | Greater than |
| `gte` | `number` | Greater than or equal |

**List Filter Operations:** Same as string list filters.

**Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `number` | Set value |
| `increment` | `number` | Add to current value |
| `decrement` | `number` | Subtract from current value |
| `multiply` | `number` | Multiply current value |
| `divide` | `number` | Divide current value |

**List Update Operations:** Same as string list updates (`set`, `push`, `unshift`).

**Note:** For `int`, use `refine(Number.isInteger, "must be an integer")` to validate integers.

---

### BigInt Fields

**Filter Operations:** Same as Int/Float fields, but with `bigint` type.

**Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `bigint` | Set value |
| `increment` | `bigint` | Add to current value |
| `decrement` | `bigint` | Subtract from current value |
| `multiply` | `bigint` | Multiply current value |
| `divide` | `bigint` | Divide current value |

---

### Boolean Fields

**Filter Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `equals` | `boolean` | Exact match |
| `not` | `boolean \| Filter` | Negation |

**List Filter Operations:** Same as string list filters.

**Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `boolean` | Set value |

**Create defaulting (all field types):** Any nullable create schema (single or list) should be optional and defaulted to `null` using `_default(optional(nullableSchema), null)` so callers can omit the key entirely. No separate `OptionalNullable*` variants are needed.

---

### DateTime Fields

**Base Type:** Accept both `Date` objects and ISO 8601 strings. Use `iso.datetime()` from zod/v4-mini.

**Filter Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `equals` | `Date \| string` | Exact match |
| `not` | `Date \| string \| Filter` | Negation |
| `in` | `(Date \| string)[]` | Value in array |
| `notIn` | `(Date \| string)[]` | Value not in array |
| `lt` | `Date \| string` | Before |
| `lte` | `Date \| string` | Before or equal |
| `gt` | `Date \| string` | After |
| `gte` | `Date \| string` | After or equal |

**List Filter Operations:** Same as string list filters.

**Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `Date \| string` | Set value |

---

### Enum Fields

**Base Type:** Use `_enum()` from zod/v4-mini. Schema builders take enum values as parameter.

**Filter Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `equals` | `EnumValue` | Exact match |
| `not` | `EnumValue \| Filter` | Negation |
| `in` | `EnumValue[]` | Value in array |
| `notIn` | `EnumValue[]` | Value not in array |

**Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `EnumValue` | Set value |

---

### JSON Fields

**Base Type:** `unknown()`. Optionally supports typed JSON via `StandardSchema`.

**Filter Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `equals` | `JsonValue` | Deep equality |
| `not` | `JsonValue` | Not equal |
| `path` | `string[]` | JSON path for nested access |
| `string_contains` | `string` | String at path contains |
| `string_starts_with` | `string` | String at path starts with |
| `string_ends_with` | `string` | String at path ends with |
| `array_contains` | `JsonValue` | Array at path contains |
| `array_starts_with` | `JsonValue` | Array at path starts with |
| `array_ends_with` | `JsonValue` | Array at path ends with |

**Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `JsonValue` | Replace entire JSON value |

**Note:** JSON fields don't have list variants (JSON itself can be an array).

---

### Bytes / Blob Fields

**Base Type:** `instanceof(Uint8Array)`. Also accept `Buffer` for Node.js compatibility.

**Filter Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `equals` | `Uint8Array \| Buffer` | Exact match |
| `not` | `Uint8Array \| Buffer` | Not equal |

**Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `Uint8Array \| Buffer` | Set value |

**Note:** Binary fields have limited filter operations - no comparison or pattern matching.

---

### Vector Fields (PostgreSQL pgvector)

**Base Type:** `array(number())` with optional dimension constraint.

**Filter Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `equals` | `number[]` | Exact match |
| `not` | `number[]` | Not equal |

**Update Operations:**
| Operation | Type | Description |
|-----------|------|-------------|
| `set` | `number[]` | Set value |

**Note:** Similarity search operations (`l2_distance`, `cosine_distance`, etc.) are handled at the query level, not field level.

---

## Summary Table

| Field Type | Comparison (`lt`/`gt`) | Pattern (`contains`) | Arithmetic (`increment`) | List ops |
|------------|------------------------|----------------------|--------------------------|----------|
| String     | ✅                     | ✅                   | ❌                       | ✅       |
| Int/Float  | ✅                     | ❌                   | ✅                       | ✅       |
| BigInt     | ✅                     | ❌                   | ✅                       | ✅       |
| Boolean    | ❌                     | ❌                   | ❌                       | ✅       |
| DateTime   | ✅                     | ❌                   | ❌                       | ✅       |
| Enum       | ❌                     | ❌                   | ❌                       | ✅       |
| JSON       | ❌                     | ✅ (path-based)      | ❌                       | ❌       |
| Bytes      | ❌                     | ❌                   | ❌                       | ❌       |
| Vector     | ❌                     | ❌                   | ❌                       | ❌       |

## Checklist for New Field Implementation

- [ ] Create `fields/[type]/` directory
- [ ] Define base types: `[type]Base`, `[type]Nullable`, `[type]List`, `[type]ListNullable`
- [ ] Define filter base schemas (without `not`) - **check Prisma parity table above**
- [ ] Define complete filter schemas (with `not` and shorthand) - **include all type-specific operations**
- [ ] Define create schemas (8 variants: required/optional × nullable/non-nullable × single/list)
- [ ] Define update schemas (4 variants) - **include type-specific ops like `increment` for numbers**
- [ ] Build schema factory functions (4 functions)
- [ ] Define type helpers (`[Type]Schemas`, `Infer[Type]Schemas`, `Infer[Type]Input`)
- [ ] Build `getField[Type]Schemas` function
- [ ] Implement lean field class
- [ ] Add to `fields/index.ts` exports
- [ ] Update `fields/base.ts` Field union type
- [ ] **Verify Prisma parity** - cross-check against Prisma docs for the field type
