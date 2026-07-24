# Schema Registry Migration Plan

## Purpose

This document was the execution plan for finishing the `fix-nested-create`
branch. At the time this plan was written, operation schemas were hoisted onto
scalar definitions, relation definitions, and models through `["~"].schemas`, which prevented nested
create from using full schema graph context to omit inverse foreign key fields
correctly.

The target architecture is a runtime-created schema registry:

```ts
const registry = createSchemaRegistry(schema);
registry.proxy.user.args.create;
registry.proxy.user.relations.posts.create;
```

The registry owns operation schemas. The schema layer owns database structure:
models, fields (scalars and relations), names, constraints, and static metadata. This
separation lets relation schemas know the source model, target model, and inverse
foreign key relation at the same time.

> Status: this is migration history. References below to `model["~"].schemas`
> describe the old path or phase targets; current runtime validation uses
> `SchemaRegistry` model schemas (`core.*` and `args.*`). The imperative phase
> language below is preserved as archival execution context, not as current
> implementation guidance.

## Historical Baseline

At the time of the investigation that produced this plan:

- Branch: `fix-nested-create`.
- The working tree was clean.
- The active path was `QueryEngine -> validate() -> model["~"].schemas`.
- The new registry existed in `src/validation/builder.ts`, but was not yet wired
  into the client or query engine.
- `src/validation/model/index.ts` was incomplete and blocked the new registry
  from type-checking.
- Old schema files under `src/schema/**/schemas` still existed and conflicted
  with the reorganized validation exports.

The existing architecture context is in
`docs/architecture/validation-layer-refactoring.md`. Read that document before
starting this plan.

## Non-Negotiable Invariant

Nested create through a relation must validate against the target model create
schema with inverse foreign key fields omitted.

Example:

```ts
await orm.user.create({
  data: {
    posts: {
      create: [{ title: "First post" }],
    },
  },
});
```

If `post.authorId` is the inverse FK, `posts.create` must not require
`authorId`. The query engine derives it from the parent `user` row. The schema
registry exists because relation-local schemas cannot infer that safely.

## Systematic Verification Loop

Use this loop for every phase. Do not move to the next phase because an error
"looks unrelated"; classify it first.

1. Start from a known diff:

   ```bash
   git status --short
   ```

2. Make only the edits described by the current phase.

3. Run a source-focused type check:

   ```bash
   pnpm type-check 2>&1 | rg "^src/.*error TS"
   ```

   `rg` exiting with no matches means there are no `src/` TypeScript errors.
   If there are errors, either fix them in the phase or explicitly record why the
   error belongs to a later phase.

4. Run the full type check:

   ```bash
   pnpm type-check
   ```

   Early phases may still fail in tests. That is acceptable only when all `src/`
   errors are gone or the phase explicitly says otherwise.

5. Run focused tests once the relevant code compiles:

   ```bash
   pnpm vitest run tests/relations/create.test.ts
   pnpm vitest run tests/model/create/relation-create.test.ts
   pnpm vitest run tests/model/args/nested-args.test.ts
   pnpm vitest run tests/query-engine/nested-create-many.test.ts
   pnpm vitest run tests/query-engine/nested-writes.test.ts
   ```

6. Run broader checks before deleting old code or declaring the branch complete:

   ```bash
   pnpm vitest run tests/model/create/scalar-create.test.ts
   pnpm vitest run tests/model/combined/create.test.ts
   pnpm vitest run tests/model/filter/relation-filter.test.ts
   pnpm vitest run tests/model/update/relation-update.test.ts
   pnpm vitest run tests/query-engine/nested-relation-filter.test.ts
   pnpm test
   ```

7. At the end of each phase, inspect the diff:

   ```bash
   git diff --stat
   git diff --check
   ```

Phase pass criteria always include: no unrelated refactors, no fake defaults, no
silent validation fallbacks, and no new type assertions unless the phase
explicitly calls out a temporary compatibility bridge.

## Phase 0: Baseline and Error Inventory

### Goal

Record the current failure shape before changing code. This avoids "fixing" stale
test failures while the source architecture is still incomplete.

### Files to inspect

- `docs/architecture/validation-layer-refactoring.md`
- `src/validation/builder.ts`
- `src/validation/model/index.ts`
- `src/validation/model/args/index.ts`
- `src/validation/relations/create.ts`
- `src/query-engine/validator.ts`
- `src/client/client.ts`
- `src/client/types.ts`
- `src/schema/model/model.ts`
- `src/query-engine/types.ts`

### Commands

```bash
pnpm install
pnpm type-check 2>&1 | rg "^src/.*error TS" > /tmp/viborm-src-errors.txt
pnpm type-check 2>&1 | rg "^tests/.*error TS" > /tmp/viborm-test-errors.txt
```

### Expected findings

- `src/validation/model/index.ts` references missing names such as
  `FieldSchemas`, `CoreSchemas`, `ArgsSchemas`, `getCoreSchemas`, and
  `getArgsSchemas`.
- `src/validation/model/args/index.ts` uses generic arg schema types without the
  required type parameter.
- Old schema files still import validation symbols that no longer exist from
  `@validation`.
- Test errors largely come from the Standard Schema return type being
  `Result<T> | Promise<Result<T>>`, while tests access `.issues` directly.

### Pass criteria

- Current errors are classified into `new validation source`, `old hoisted source`,
  and `stale tests`.
- No production code has been changed.

## Phase 1: Make the New Validation Registry Type-Coherent

### Goal

Get the new validation layer compiling on its own. Do not wire it into the
runtime yet.

### Context

`src/validation/builder.ts` already contains the right central idea:

- `SchemaRegistry` caches schemas by `Model` object.
- Relation schemas receive a `createSchemasGetter` thunk.
- Target schemas are resolved from `state.getter()`.

The broken part is the model schema bundle. `src/validation/model/index.ts` is a
partial stub, and the `args`/`core` types are not consistently parameterized.

### Files to modify

- `src/validation/model/index.ts`
- `src/validation/model/core/index.ts`
- `src/validation/model/core/create.ts`
- `src/validation/model/core/filter.ts`
- `src/validation/model/core/orderby.ts`
- `src/validation/model/core/select.ts`
- `src/validation/model/core/update.ts`
- `src/validation/model/core/where.ts`
- `src/validation/model/args/index.ts`
- `src/validation/model/args/find.ts`
- `src/validation/model/args/mutation.ts`
- `src/validation/model/args/aggregate.ts`
- `src/validation/relations/create.ts`
- `src/validation/relations/update.ts`
- `src/validation/relations/helpers.ts`
- `src/validation/scalars/index.ts`
- `src/validation/builder.ts`

### Work

1. Define the model schema bundle shape in `src/validation/model/index.ts`.

   The registry should be able to call:

   ```ts
   const { core, args } = getModelSchemas(model, { scalars, relations });
   ```

   The return type should preserve the model type:

   ```ts
   export type ModelSchemas<
     M extends AnyModel,
     F extends FieldSchemas<M> = FieldSchemas<M>,
   > = {
     core: CoreSchemas<M, F>;
     args: ArgsSchemas<M, F>;
     scalars: F["scalars"];
     relations: F["relations"];
   };
   ```

   Use the actual local type names if they differ, but keep the shape: field
   schemas are built first, then core schemas, then args schemas.

2. Implement or rename the missing factories:

   - `getCoreSchemas(model, fieldSchemas)`
   - `getArgsSchemas(model, fieldSchemas, coreSchemas)`
   - `getModelSchemas(model, fieldSchemas)`

   Avoid a `ModelSchemas` class here. Registry laziness should come from
   `v.lazy()` and the registry cache.

3. Fix every generic schema type in `src/validation/model/args/index.ts`.

   If `FindUniqueArgs` now requires `<M, F>` or `<S>`, the aggregate
   `ArgsSchemas` type must pass that parameter everywhere. Do not erase it to
   `VibSchema` unless a boundary is intentionally runtime-only.

4. Make core schema factories consume `fieldSchemas`, not hoisted per-scalar/per-relation schemas.

   New code should prefer:

   ```ts
   fieldSchemas.scalars.email.filter;
   fieldSchemas.relations.posts.create;
   ```

   over:

   ```ts
   model["~"].state.scalars.email["~"].schemas.filter;
   ```

5. Keep `CreateWithOmittedFk` intact in `src/validation/relations/create.ts`.

   This is the branch's core fix. It must still use target core create schemas
   plus `GetInverseRelationMap<S, Source>`.

6. Remove or quarantine scratch code in `src/validation/builder.ts`.

   Delete the module-scope `user`, `post`, `schema`, `registry`, `include`, and
   test-only type aliases. The builder file must not create models at import
   time.

### Verification

```bash
pnpm type-check 2>&1 | rg "^src/validation/.*error TS"
pnpm type-check 2>&1 | rg "^src/.*error TS"
```

Early in this phase, `src/schema/**/schemas` may still fail because those files
belong to the old system. The phase passes only when all errors from
`src/validation/**` are gone.

### Pass criteria

- `src/validation/**` has zero TypeScript errors.
- `src/validation/builder.ts` has no module-scope demo models or runtime side
  effects.
- `createSchemaRegistry(schema)` can be imported without constructing any user
  models.
- The nested-create relation schema type still omits inverse FK fields.

## Phase 2: Define the Registry Public Contract

### Goal

Make the schema registry a stable internal API that the client and query engine
can consume.

### Files to modify

- `src/validation/builder.ts`
- `src/validation/index.ts`
- `src/validation/types.ts`
- `src/client/client.ts`
- `src/client/types.ts`
- `src/query-engine/types.ts`

### Work

1. Export only the intended registry surface:

   - `createSchemaRegistry`
   - `SchemaRegistry`
   - `ModelSchemas`
   - `CoreSchemas`
   - `ArgsSchemas`
   - `FieldSchemas`

2. Decide and encode the runtime lookup contract.

   Recommended shape:

   ```ts
   interface SchemaRegistryLookup {
     getModelSchemas(model: AnyModel): ModelSchemas;
     validate(modelName: string, operation: keyof ArgsSchemas, payload: unknown): unknown;
   }
   ```

   The proxy is useful for typed access, but runtime query execution should not
   depend on property proxy traps for hot-path validation. Keep direct lookup
   methods.

3. Extend the query-engine registry context.

   Current `ModelRegistry` only resolves models:

   ```ts
   interface ModelRegistry {
     get(name: string): Model<any> | undefined;
     getByTableName(tableName: string): Model<any> | undefined;
   }
   ```

   Add schema access either by extending this interface or by passing a separate
   schema registry to `QueryEngine`. Prefer explicit separation if the diff stays
   small:

   ```ts
   new QueryEngine(driver, modelRegistry, schemaRegistry, instrumentation);
   ```

4. Keep client type inference separate from runtime lookup.

   Runtime validation can use `SchemaRegistry`. Compile-time client payload types
   may need a separate type helper until `model["~"].schemas` is fully removed.
   Do not block runtime integration on perfect public type ergonomics.

### Verification

```bash
pnpm type-check 2>&1 | rg "^src/(validation|client|query-engine)/.*error TS"
```

### Pass criteria

- The registry API is exported from `@validation`.
- `QueryEngine` can receive or access registry schemas without reaching into
  `model["~"].schemas`.
- No new model construction happens inside validation module imports.
- The API does not expose mutable registry cache internals.

## Phase 3: Wire Runtime Validation to the Registry

### Goal

Move actual operation validation from `model["~"].schemas.args.*` to the runtime
schema registry.

### Files to modify

- `src/client/client.ts`
- `src/query-engine/query-engine.ts`
- `src/query-engine/validator.ts`
- `src/query-engine/types.ts`
- `src/query-engine/context.ts`
- `src/query-engine/builders/select-builder.ts`
- `src/schema/hydration.ts`

### Work

1. Create the schema registry at client initialization.

   The client already calls `hydrateSchemaNames(schema)`. Build the registry at
   the same lifecycle boundary, after schema names and relation sources are
   hydrated:

   ```ts
   hydrateSchemaNames(schema);
   const schemaRegistry = createSchemaRegistry(schema);
   ```

2. Pass the schema registry into `QueryEngine`.

   Do not rebuild it per operation. It should be one registry per client.

3. Replace `src/query-engine/validator.ts`.

   Current behavior:

   ```ts
   const schemas = model["~"].schemas;
   return schemas.args?.create;
   ```

   Target behavior:

   ```ts
   const schemas = schemaRegistry.getModelSchemas(model);
   return schemas.args.create;
   ```

4. Update `QueryEngine.build()` and `QueryEngine.prepare()`.

   Every call to `validate()` must pass the registry or use a validator instance
   created with the registry.

5. Update query context where nested builders need validation schemas.

   `src/query-engine/builders/select-builder.ts` currently reads:

   ```ts
   relationInfo.targetModel["~"].schemas.where;
   ```

   Replace this with registry access through `QueryContext`.

6. Keep `hydrateSchemaNames()` focused on names and source relation binding.

   Do not add operation schema construction to `src/schema/hydration.ts`.

### Verification

```bash
pnpm type-check 2>&1 | rg "^src/(client|query-engine|validation)/.*error TS"
pnpm vitest run tests/relations/create.test.ts
pnpm vitest run tests/model/create/relation-create.test.ts
pnpm vitest run tests/model/args/nested-args.test.ts
pnpm vitest run tests/query-engine/nested-create-many.test.ts
```

Add one focused runtime assertion if missing:

- parent `create` with `children.create` succeeds without requiring the child FK.
- direct child `create` still requires the FK unless provided through relation
  data.

### Pass criteria

- No production validation path uses `model["~"].schemas.args`.
- Nested create validation accepts parent-derived FK omission.
- Direct create validation still enforces required non-derived scalar fields.
- Registry is constructed once per client, not once per operation.

## Phase 4: Move Client Payload Types off Hoisted Schemas

### Goal

Preserve the typed Prisma-like client while removing compile-time dependency on
`model["~"].schemas`.

### Files to modify

- `src/client/types.ts`
- `src/client/result-types.ts`
- `src/validation/builder.ts`
- `src/validation/model/index.ts`
- `src/schema/model/model.ts`
- `src/schema/schemas.ts`

### Work

1. Identify every type-level use of `M["~"]["schemas"]`.

   Use:

   ```bash
   rg "\\[\"~\"\\]\\[\"schemas\"\\]|\\[\"~\"\\]\\.schemas|schemas\\.args" src
   ```

2. Introduce type helpers based on the new validation model schema builders.

   The client needs equivalents for:

   - operation input payloads
   - select/include result shaping
   - relation nested args

   The helper should derive from model state and validation model schema types,
   not from runtime registry object values.

3. Keep result types anchored to model state.

   `src/client/result-types.ts` should continue to infer scalar outputs from
   `ModelState["scalars"]` and relation target thunks. This is separate from
   input validation.

4. Decide the fate of `src/schema/schemas.ts`.

   If it exists only to expose `model["~"].schemas`, replace it with a registry
   helper or delete it. Do not keep a second operation schema accessor alive.

5. Remove `schemas` from `ModelInternal` only after client payload types compile.

   This is the hard cut. Before this point, a temporary compatibility bridge is
   acceptable. After this point, `Model["~"]` should expose state/name metadata,
   not operation schemas.

### Verification

```bash
pnpm type-check 2>&1 | rg "^src/(client|schema|validation)/.*error TS"
pnpm vitest run tests/model/args/find-args.test.ts
pnpm vitest run tests/model/args/mutation-args.test.ts
pnpm vitest run tests/model/args/nested-args.test.ts
pnpm vitest run tests/client/relation-types.test.ts
```

### Pass criteria

- `src/client/**` has no type dependency on `model["~"].schemas`.
- Client operation args remain inferred from schema definitions.
- Select/include result inference still works through relations.
- Enum literal relation result inference remains fixed.

## Phase 5: Delete Old Hoisted Operation Schemas

### Goal

Remove the old duplicate schema system from `src/schema/`.

### Files to delete or reduce

- `src/schema/model/schemas/`
- `src/schema/relation/schemas/`
- `src/schema/scalars/*/schemas.ts`

### Files to modify

- `src/schema/model/model.ts`
- `src/schema/relation/to-one.ts`
- `src/schema/relation/to-many.ts`
- `src/schema/relation/many-to-many.ts`
- `src/schema/scalars/*/scalar.ts`
- `src/schema/scalars/base.ts`
- `src/schema/scalars/common.ts`
- `src/schema/validation/rules/model.ts`
- `src/validation/constraints/id.ts`
- `src/validation/constraints/unique.ts`
- `src/validation/constraints/compound.ts`

### Work

1. Remove `schemas` from scalar internals.

   Scalars should keep:

   - state
   - base primitive schema in `ScalarState["base"]`
   - database metadata such as nullable, array, id, default, column name

   Scalars should not expose operation schemas such as `create`, `update`, or
   `filter`.

2. Remove `schemas` from relation internals.

   Relations should keep state and source binding. Relation operation schemas are
   registry-owned.

3. Remove `schemas` from model internals.

   Models should keep:

   - state
   - names
   - name registry
   - cached scalar/relation key metadata

4. Update definition-time validation and constraints.

   Files such as `src/validation/constraints/id.ts` currently read scalar base
   schemas through `scalar["~"].schemas.base`. Replace with `scalar["~"].state.base`.

5. Delete old files instead of maintaining compatibility shims.

   This branch is not shipped API. Keeping both systems alive would preserve the
   bug's cause.

### Verification

```bash
rg "\\[\"~\"\\]\\.schemas|\\[\"~\"\\]\\[\"schemas\"\\]|schemas\\.args" src
pnpm type-check 2>&1 | rg "^src/.*error TS"
pnpm vitest run tests/schema/shared-field.test.ts
pnpm vitest run tests/schema/relation/inverse-relation-fields.test.ts
pnpm vitest run tests/relations/create.test.ts
pnpm vitest run tests/model/create/relation-create.test.ts
```

The `rg` command should return no production uses except historical docs or
tests being deliberately updated in later phases.

### Pass criteria

- No operation schemas are exposed through `scalar["~"]`, `relation["~"]`, or
  `model["~"]`.
- Old schema directories are gone.
- Schema definition remains reusable: the same scalar instance can be reused in
  two models without name/schema leakage.
- Definition-time validation still works from state and base schemas.

## Phase 6: Restore Validation Tests and Standard Schema Result Ergonomics

### Goal

Bring the validation test suite back to green after the primitive/index
reorganization.

### Context

Many current test errors are not the nested-create bug. They come from directly
calling `schema["~standard"].validate()` and then accessing `.issues`, while the
Standard Schema interface allows a promise result.

### Files to modify

- `src/validation/index.ts`
- `src/validation/types.ts`
- `tests/validation/*.test.ts`
- `tests/relations/*.test.ts`
- `tests/model/**/*.test.ts`

### Work

1. Decide the official project-level parse helper.

   Recommended:

   ```ts
   const result = parse(schema, value);
   ```

   Since VibORM validation is synchronous by design, `parse()` should expose a
   synchronous return type for VibORM schemas and throw or fail explicitly if a
   foreign Standard Schema returns a promise.

2. Update tests to use `parse()` where they need synchronous result narrowing.

3. Do not weaken `VibSchema` to pretend all Standard Schema implementations are
   synchronous. VibORM schemas are synchronous; foreign schemas can still follow
   Standard Schema's broader contract.

4. Keep failure visibility.

   No helper should catch validation errors and return `{}` or `undefined`.

### Verification

```bash
pnpm vitest run tests/validation/string.test.ts
pnpm vitest run tests/validation/object.test.ts
pnpm vitest run tests/validation/union.test.ts
pnpm vitest run tests/relations/create.test.ts
pnpm type-check
```

### Pass criteria

- Full `pnpm type-check` has no errors.
- Validation tests assert real issues and values, not just truthiness.
- The project still rejects async validation during query execution with a clear
  `ValidationError`.

## Phase 7: Prove Nested Create Behavior End to End

### Goal

Verify the branch's original bug is fixed at both type and runtime levels.

### Files to inspect or modify

- `tests/query-engine/nested-create-many.test.ts`
- `tests/query-engine/nested-writes.test.ts`
- `tests/model/args/nested-args.test.ts`
- `tests/model/create/relation-create.test.ts`
- `tests/client/relation-types.test.ts`
- `src/query-engine/builders/relation-data-builder.ts`
- `src/query-engine/operations/nested-writes/create.ts`

### Required test cases

1. To-many nested `create` omits inverse FK.

   Parent create with child create should validate when child data omits the FK.

2. To-many nested `createMany` omits inverse FK.

   Parent create with child `createMany.data` should validate when each child row
   omits the FK.

3. Direct target create still requires FK.

   Creating `post` directly must require `authorId` unless relation data provides
   it.

4. Named inverse relations choose the correct FK.

   A model with two relations to the same target, such as `author` and
   `co_author`, must omit only the FK belonging to the matching relation name.

5. Select/include still validate through nested relation args.

   Nested include where/orderBy/select must use target registry schemas.

### Verification

```bash
pnpm vitest run tests/schema/relation/inverse-relation-fields.test.ts
pnpm vitest run tests/model/args/nested-args.test.ts
pnpm vitest run tests/model/create/relation-create.test.ts
pnpm vitest run tests/query-engine/nested-create-many.test.ts
pnpm vitest run tests/query-engine/nested-writes.test.ts
pnpm vitest run tests/query-engine/nested-relation-filter.test.ts
```

### Pass criteria

- Nested create accepts parent-derived FK omission.
- Wrong or missing non-derived required fields still fail validation.
- Multiple inverse relations do not cross-wire FK fields.
- Runtime SQL builders receive validated data in the expected shape.

## Phase 8: Full Regression Pass and Documentation Cleanup

### Goal

Remove stale references to the old architecture and make the branch mergeable.

### Files to modify

- `src/schema/AGENTS.md`
- `src/schema/scalars/AGENTS.md`
- `src/schema/model/schemas/AGENTS.md` or delete if directory is removed
- `src/query-engine/AGENTS.md`
- `src/client/AGENTS.md`
- `src/schema/README.md`
- `src/validation/README.md`
- `docs/architecture/validation-layer-refactoring.md`
- `PENDING_WORK.md` if it still claims nested create is complete without this fix

### Work

1. Replace documentation claims that say schemas live on `["~"].schemas`.

   New rule:

   - Schema layer owns structure and base scalar schemas.
   - Validation registry owns operation schemas.
   - Client/query-engine use the registry for operation validation.

2. Update examples that reference `model["~"].schemas.args.*`.

3. Remove obsolete docs for `src/schema/model/schemas` if the directory is gone.

4. Keep `docs/architecture/validation-layer-refactoring.md` as rationale and this
   document as execution history.

### Verification

```bash
rg "\\[\"~\"\\]\\.schemas|model\\[\"~\"\\]\\.schemas|field\\[\"~\"\\]\\.schemas" .
pnpm type-check
pnpm test
pnpm build
```

Historical mentions inside this plan and the original rationale doc are allowed
only if they clearly describe the old architecture.

### Pass criteria

- Full test suite passes.
- Build passes.
- No production code references operation schemas through `["~"]`.
- Documentation no longer teaches the removed schema-hoisting architecture as
  current behavior.

## Final Done Criteria

The branch is done when all of these are true:

- `pnpm type-check` passes.
- `pnpm test` passes.
- `pnpm build` passes.
- Runtime query validation uses `SchemaRegistry`, not `model["~"].schemas`.
- `rg "\\[\"~\"\\]\\.schemas|\\[\"~\"\\]\\[\"schemas\"\\]" src` returns no
  production operation-schema usage.
- Nested create and nested createMany validate without requiring parent-derived
  inverse FK fields.
- Direct create still requires non-derived required fields.
- Multiple named inverse relations resolve the correct FK.
- The schema layer no longer mixes database structure with operation validation.

## Risk Register

### Type Inference Blowups

The registry must not reintroduce slow `schema.infer` patterns. Keep branded
schema inference and avoid broad `any` erasure in client payload types.

### Circular Relations

Relations must continue to resolve through thunks. Do not eagerly evaluate target
models during module import.

### Temporary Compatibility Bridges

A short-lived bridge from `model["~"].schemas` to registry schemas is acceptable
only before Phase 5. It must be deleted before completion.

### Old Tests Masking New Behavior

Do not update tests merely to match implementation. The core nested create
invariant above is the truth source.

### False Defaults

Never make missing FK fields validate by returning `{}` or silently marking all
fields optional. Only inverse FK fields derived from the parent relation may be
omitted.
