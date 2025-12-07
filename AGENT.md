# AGENT.md - VibORM Developer Guide

## Goal

Type-safe ORM for PG/MySQL/SQLite. Zero codegen. Prisma-like API. Types inferred from schema.

## Architecture

```
src/
├── schema/           # 🎯 ACTIVE - Schema definition system
│   ├── fields/       # Field types (string, int, etc.)
│   ├── model/        # Model class + runtime schemas
│   ├── relation/     # Relation classes
│   └── validation/   # Schema validation rules
├── client/           # 🎯 ACTIVE - Query client types
├── adapters/         # Database adapters (PG, MySQL, SQLite)
├── query-parser/     # 🗑️ LEGACY - Will rewrite
└── types/            # 🗑️ LEGACY - Moving to schema/
```

## Core Pattern: State Generics

Every field/model uses single `State` generic to track configuration:

```ts
// Field state captures all modifiers
interface FieldState<T extends ScalarFieldType = ScalarFieldType> {
  type: T;
  nullable: boolean;
  array: boolean;
  hasDefault: boolean;
  isId: boolean;
  isUnique: boolean;
  defaultValue: any;
  autoGenerate: "uuid" | "ulid" | "cuid" | "nanoid" | "increment" | undefined;
  customValidator: StandardSchemaV1 | undefined;
  columnName: string | undefined;
}

// Chainable methods return new instance with updated state
nullable(): StringField<UpdateState<State, { nullable: true }>>
```

**Why**: Adding new state props doesn't break `Model<any>` or require migration.

## Internal API Convention: `~`

All internals exposed via `~` property:

```ts
field["~"].state      // FieldState
field["~"].schemas    // ArkType schemas (base, filter, create, update)
field["~"].nativeType // DB type override

model["~"].fields     // Field definitions
model["~"].fieldMap   // Map<string, Field>
model["~"].relations  // Map<string, Relation>
model["~"].schemas    // Lazy-built runtime schemas
model["~"].infer      // Inferred TS type
```

## Adding New Field Type

1. **Create folder**: `src/schema/fields/{type}/`

2. **schemas.ts** - ArkType schemas for all variants:
```ts
// Base schemas (result type)
export const {type}Base = type("string");
export const {type}Nullable = type("string | null");
export const {type}Array = type("string[]");
export const {type}NullableArray = type("(string | null)[]");

// Filter schemas (where clause)
export const {type}Filter = type({ ... });
export const {type}NullableFilter = type({ ... });
export const {type}ListFilter = type({ ... });

// Create schemas (optional if hasDefault)
export const {type}Create = type("string");
export const {type}OptionalCreate = type("string | undefined");
export const {type}NullableCreate = type("string | null");
export const {type}OptionalNullableCreate = type("string | null | undefined");
// ...array variants

// Update schemas (with operations)
export const {type}Update = type({ set?: "string" });
export const {type}NullableUpdate = type({ set?: "string | null" });
// ...array variants with push/unshift
```

3. **field.ts** - Field class:
```ts
export class {Type}Field<State extends FieldState<"{type}">> {
  constructor(private state: State, private _nativeType?: NativeType) {}

  // Chainable modifiers - each returns NEW instance with updated type
  nullable(): {Type}Field<UpdateState<State, { nullable: true }>> {
    return new {Type}Field({ ...this.state, nullable: true }, this._nativeType);
  }

  // Schema getter - runtime picks based on state
  get schemas(): {Type}FieldSchemas<State> {
    // Select correct schemas based on nullable/array/hasDefault
    return { base, filter, create, update };
  }

  // Internal accessor
  get ["~"]() {
    return { state: this.state, schemas: this.schemas, nativeType: this._nativeType };
  }
}

// Factory
export const {type} = (nativeType?: NativeType) =>
  new {Type}Field(createDefaultState("{type}"), nativeType);
```

4. **index.ts** - Re-exports:
```ts
export { {Type}Field, {type} } from "./field";
export * from "./schemas";
```

5. **Update exports**:
   - `src/schema/fields/index.ts` - Export field
   - `src/schema/fields/base.ts` - Add to `Field` union type
   - `src/schema/index.ts` - Add to `s` builder

6. **Add native types** (if applicable):
   - `src/schema/fields/native-types.ts` - Add PG/MYSQL/SQLITE constants

7. **Update type helpers**:
   - `src/schema/model/types/helpers.ts` - Add to `ScalarResultTypeMap` and `ScalarInputTypeMap`

## Type System Contract

**TypeScript types** (`src/schema/model/types/`) and **ArkType schemas** (`src/schema/model/runtime/`) must match:

| File | Purpose |
|------|---------|
| `helpers.ts` | Extract field info, infer types WITHOUT ArkType `.infer` |
| `input-types.ts` | Where/WhereUnique/Filter types |
| `result-types.ts` | Query result types (SelectResult, IncludeResult) |
| `args-types.ts` | Operation argument types (FindManyArgs, etc.) |
| `core-schemas.ts` | Runtime ArkType schemas for where/select/include |
| `args-schemas.ts` | Runtime ArkType schemas for operation args |
| `mutation-schemas.ts` | Runtime ArkType schemas for create/update |

**Key rule**: Use `helpers.ts` type utilities, NOT `schema.infer`. ArkType `.infer` causes slow/deep type inference.

## Validation Rules

Rules in `src/schema/validation/rules/`:

| File | Purpose |
|------|---------|
| `model.ts` | Field/ID checks, single-pass validation |
| `relation.ts` | Relation target exists, inverse relations |
| `fk.ts` | FK field exists, type match, cardinality |
| `database.ts` | DB-specific constraints |

**Rule signature**:
```ts
type ValidationRule = (
  schema: Schema,
  modelName: string,
  model: Model<any>,
  ctx: ValidationContext
) => ValidationError[];
```

**Add rule**: Create in appropriate file, add to `allRules` in `rules/index.ts`.

## Key Files Quick Reference

| Purpose | Location |
|---------|----------|
| Field union type | `src/schema/fields/base.ts` → `Field` |
| Model class | `src/schema/model/model.ts` |
| Relation classes | `src/schema/relation/relation.ts` |
| Schema builder `s` | `src/schema/index.ts` |
| Type helpers | `src/schema/model/types/helpers.ts` |
| Runtime schemas | `src/schema/model/runtime/` |
| Validation | `src/schema/validation/` |
| Client types | `src/client/types.ts` |

## Testing

```bash
pnpm vitest run tests/{file}
```

Structure:
- `tests/schema/` - Schema validation tests
- `tests/types/` - Type inference tests (use `expectTypeOf`)

Test patterns:
```ts
// Runtime
describe("feature", () => {
  test("does X", () => {
    expect(result).toBe(expected);
  });
});

// Types
test("infers correct type", () => {
  expectTypeOf(value).toEqualTypeOf<ExpectedType>();
});
```

## Common Pitfalls

1. **Don't use `schema.infer`** - Use `helpers.ts` type utilities instead
2. **Always return NEW instance** from chainable methods
3. **Update `Field` union** when adding field types
4. **Runtime + Types must match** - Change both together
5. **Use `[T] extends [X]`** for non-distributive conditionals (prevents union explosion)
6. **Lazy schema building** - Model schemas built on first access, use caching
7. **Use cached schemas for relations** - `targetModel["~"].schemas.where` not `buildWhereSchema(targetModel)`
8. **NO module-level state** - No `let cache = ...` or `WeakMap` at module scope. Bad for serverless (Cloudflare Workers). Use `model._schemas` for per-model caching instead.

## Schema Caching Architecture

```
model["~"].schemas (lazy, cached per model)
    ├── Core schemas (built first)
    │   ├── where, whereUnique, create, update, orderBy
    │   ├── select, include, selectNested, includeNested
    │   └── uncheckedCreate, uncheckedUpdate
    └── Args schemas (built second, use core schemas)
        ├── findMany, findFirst, findUnique, count, exist, aggregate, groupBy
        └── createArgs, updateArgs, deleteArgs, upsertArgs, etc.
```

**Two-phase build** in `runtime/index.ts`:
1. Build core schemas → stored in `CoreSchemas` object
2. Build args schemas using `CoreSchemas` (no rebuilding)

**Cross-model references** (e.g., relation filters):
```ts
// ✓ Use cached schema from target model
shape[name + "?"] = type({
  "is?": () => getTargetModel()["~"].schemas.where,
});

// ✗ Don't rebuild
shape[name + "?"] = type({
  "is?": () => buildWhereSchema(getTargetModel()),
});
```

## Code Style

- No decorators
- Chainable API everywhere
- Types in `/types` folders
- Schemas in `/schemas.ts` or `/runtime/`
- Test each rule individually
- Prefer composition over inheritance

