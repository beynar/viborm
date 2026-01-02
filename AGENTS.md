# AGENTS.md - VibORM Coding Agent Guide

## Project Overview

VibORM is a type-safe ORM for PostgreSQL, MySQL, and SQLite with zero codegen. Types are inferred from validation schemas, not generated. See `FEATURE_IMPLEMENTATION_TEMPLATE.md` for detailed layer-by-layer implementation guidance.

## Build/Lint/Test Commands

```bash
# Build
pnpm build                    # Compile TypeScript
pnpm type-check               # Type check without emitting

# Testing
pnpm test                     # Run all tests
pnpm test:watch               # Watch mode
pnpm vitest run tests/validation/string.test.ts   # Run single test file
pnpm vitest run tests/model/                      # Run tests in directory
pnpm vitest run -t "validates strings"            # Run tests matching pattern

# Database
pnpm db:run                   # Start PostgreSQL in Docker
pnpm db:push                  # Push Prisma schema to DB
pnpm db:generate              # Generate Prisma client
```

## Architecture (9 Layers)

```
src/
├── schema/           # L2: Schema definition (fields, model, relation)
│   ├── fields/       # Field types with State generic pattern
│   ├── model/        # Model class + L3: query schemas in model/schemas/
│   ├── relation/     # Relation classes + nested schemas
│   └── validation/   # L5: Definition-time validation rules
├── validation/       # L4: v.* primitives (like Zod/Valibot)
├── query-engine/     # L6: SQL builders, operations, result hydration
├── adapters/         # L7: Database-specific SQL (postgres, mysql, sqlite)
├── drivers/          # L8: Connection and query execution
├── client/           # L9: ORM client and result types
└── sql/              # SQL template tag utilities
```

## The Golden Rule: Natural Type Inference

**Never use type assertions.** Types must flow naturally from schemas:
```ts
// BAD: Type assertion breaks inference chain
const schema = v.object({ name: v.string() }) as SomeType;

// GOOD: Let TypeScript infer from the schema
const schema = v.object({ name: v.string() });
type Input = InferInput<typeof schema>; // Always correct
```

## Code Style Guidelines

### Imports
- Use path aliases: `@schema`, `@client`, `@validation`, `@query-engine`, `@adapters`, `@drivers`, `@sql`
- Aliases support both direct (`@schema`) and deep imports (`@schema/fields`)
- Group: external libraries → internal modules → types
- Prefer named exports over default exports

### TypeScript
- Strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- NO decorators anywhere
- Use `[T] extends [X]` for non-distributive conditionals
- Never use `.infer` from ArkType - use `helpers.ts` utilities

### Naming Conventions
- Field factories: lowercase (`string()`, `int()`, `dateTime()`)
- Field classes: PascalCase + Field suffix (`StringField`, `IntField`)
- Types: PascalCase (`FieldState`, `ModelState`)
- Private/internal: underscore prefix (`_names`, `_schemas`)

### Internal API: `~` Property
All internals exposed via `["~"]`:
```ts
field["~"].state      // FieldState
field["~"].schemas    // Validation schemas  
model["~"].fields     // Field definitions
model["~"].schemas    // Lazy-built runtime schemas
relation["~"].targetModel  // Related model getter
```

### Chainable API Pattern
Every modifier returns NEW instance with updated state:
```ts
nullable(): StringField<UpdateState<State, { nullable: true }>> {
  return new StringField({ ...this.state, nullable: true }, this._nativeType);
}
```

### Lazy Evaluation (Thunks)
Use for circular references between models:
```ts
s.oneToMany(() => post)  // Defer evaluation

// In schema factories, return thunks for recursive schemas
return v.object({
  author: () => getAuthorSchema(),  // Lazy
  posts: () => v.array(getPostSchema()),
});
```

## Testing Conventions

Vitest with globals. No imports needed for `describe`, `test`, `expect`, `expectTypeOf`.

```ts
// Runtime tests
describe("feature", () => {
  test("does X", () => expect(result).toBe(expected));
});

// Type tests  
test("infers correct type", () => {
  expectTypeOf(value).toEqualTypeOf<ExpectedType>();
});

// Standard Schema validation
test("validates input", () => {
  const result = schema["~standard"].validate(input);
  expect(result.issues).toBeUndefined();
});
```

## Adding New Field Type

1. Create folder: `src/schema/fields/{type}/`
2. Create `schemas.ts` with base/filter/create/update schemas
3. Create `field.ts` with State generic and chainable methods
4. Create `index.ts` with re-exports
5. Update `src/schema/fields/base.ts` - add to `Field` union
6. Update `src/schema/index.ts` - add to `s` builder
7. Add tests in `tests/fields/{type}-field-schemas.test.ts`

## Common Pitfalls

1. **Don't use `schema.infer`** - causes slow type inference
2. **Always return NEW instance** from chainable methods
3. **Update `Field` union** when adding field types
4. **Runtime + Types must match** - change both together
5. **Use cached schemas** - `model["~"].schemas.where` not `buildWhereSchema()`
6. **No module-level state** - breaks serverless (Cloudflare Workers)
7. **Never cast with `as`** - only natural inference

## Cursor Rules

From `.cursor/rules/writter.mdc`:
- Create files without asking permission when instructed
- Challenge ideas if appropriate - don't be sycophantic
- Log significant changes to `AI-CHANGELOG.md` (new entries at top)
- TypeScript types go in `/types` directories
- All components must have comprehensive unit tests

## File Quick Reference

| Purpose | Location |
|---------|----------|
| Field union type | `src/schema/fields/base.ts` |
| Model class | `src/schema/model/model.ts` |
| Relation classes | `src/schema/relation/relation.ts` |
| Schema builder `s` | `src/schema/index.ts` |
| Query schemas | `src/schema/model/schemas/` |
| Validation primitives | `src/validation/schemas/` |
| SQL builders | `src/query-engine/builders/` |
| Database adapters | `src/adapters/databases/` |
| Client types | `src/client/types.ts` |

## Example Usage

```ts
import { s } from "viborm";

const user = s.model("user", {
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.oneToMany(() => post),
});

const post = s.model("post", {
  id: s.string().id().ulid(),
  authorId: s.string(),
  author: s.manyToOne(() => user).fields("authorId").references("id"),
}).map("posts");

// Query - fully typed
const users = await orm.user.findMany({
  where: { email: { contains: "@company.com" } },
  include: { posts: { where: { published: true } } }
});
```
