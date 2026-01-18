# Performance Optimizations: Schema & Validation

This document summarizes all identified performance optimization opportunities in the schema instantiation and validation systems.

---

## Executive Summary

| Area | Current Cost | Potential Savings | Difficulty |
|------|--------------|-------------------|------------|
| Per-operation lazy schema loading | 13 schemas built on first query | ~85% reduction | Medium |
| Lazy field extraction in `s.model()` | O(3N) eager loops | O(1) model definition | Easy |
| Optional field detection | 4 checks per field per validation | 1 boolean lookup | Easy |
| Closure chain flattening | 5+ deep closures | Better V8 inlining | Hard |
| Validator caching | Property lookup chain | Direct function call | Easy |
| `v.fromObject()` path splitting | O(N) string splits | 1 string split | Easy |

---

## Part 1: Schema Instantiation Optimizations

### 1.1 Per-Operation Lazy Schema Loading

**Location:** `src/schema/model/schemas/index.ts`

**Problem:**  
When `model["~"].schemas` is first accessed, `getModelSchemas()` builds ALL 13 operation schemas plus 16 core schemas at once:

```typescript
// Current: ALL schemas built eagerly
export const getModelSchemas = <T extends ModelState>(state: T): ModelSchemas<T> => {
  const core = getCoreSchemas(state);  // 16 schemas
  return {
    ...core,
    args: {
      findUnique: getFindUniqueArgs(core),
      findFirst: getFindFirstArgs(core),
      findMany: getFindManyArgs(state, core),
      create: getCreateArgs(core),
      createMany: getCreateManyArgs(core),
      update: getUpdateArgs(core),
      updateMany: getUpdateManyArgs(core),
      delete: getDeleteArgs(core),
      deleteMany: getDeleteManyArgs(core),
      upsert: getUpsertArgs(core),
      count: getCountArgs(state, core),
      aggregate: getAggregateArgs(state, core),
      groupBy: getGroupByArgs(state, core),
    },
  };
};
```

**Impact:** First query pays for 13 operation schemas when it only needs 1.

**Solution:**  
Replace eager `args` object with lazy proxy/getters:

```typescript
// Proposed: Only build schema when accessed
export const getModelSchemas = <T extends ModelState>(state: T): ModelSchemas<T> => {
  let _core: CoreSchemas<T> | undefined;
  const getCore = () => (_core ??= getCoreSchemas(state));
  
  // Cache for each operation schema
  const argsCache: Partial<ModelArgs<T>> = {};
  
  return {
    get scalarFilter() { return getCore().scalarFilter; },
    get where() { return getCore().where; },
    // ... other core schemas as getters
    
    args: {
      get findUnique() { return argsCache.findUnique ??= getFindUniqueArgs(getCore()); },
      get findFirst() { return argsCache.findFirst ??= getFindFirstArgs(getCore()); },
      get findMany() { return argsCache.findMany ??= getFindManyArgs(state, getCore()); },
      // ... etc
    },
  };
};
```

**Expected Savings:** ~85% reduction in first-query schema build time (1 schema vs 13).

---

### 1.2 Lazy Field Extraction in `s.model()`

**Location:** `src/schema/model/model.ts`, `src/schema/model/helper.ts`

**Problem:**  
`s.model(fields)` eagerly runs 3 reduce loops at model definition time:

```typescript
// Current: O(3N) at model definition
export const model = <TFields extends FieldRecord>(fields: TFields) =>
  new Model({
    // ...
    fields,
    scalars: extractScalarFields(fields),      // O(N) loop
    relations: extractRelationFields(fields),  // O(N) loop
    uniques: extractUniqueFields(fields),      // O(N) loop
  });
```

**Impact:** All models pay O(3N) cost at cold start, even if never queried.

**Solution:**  
Use lazy getters on ModelState:

```typescript
// Proposed: O(1) model definition, lazy extraction
export const model = <TFields extends FieldRecord>(fields: TFields) => {
  let _scalars: ScalarFields<TFields> | undefined;
  let _relations: RelationFields<TFields> | undefined;
  let _uniques: UniqueFields<TFields> | undefined;
  
  return new Model({
    fields,
    get scalars() { return _scalars ??= extractScalarFields(fields); },
    get relations() { return _relations ??= extractRelationFields(fields); },
    get uniques() { return _uniques ??= extractUniqueFields(fields); },
    // ...
  });
};
```

**Expected Savings:** Model definition becomes O(1). Fields categorized only when needed.

---

### 1.3 Lazy Core Schema Building

**Location:** `src/schema/model/schemas/core/index.ts`

**Problem:**  
`getCoreSchemas()` builds all 16 core schemas at once:

```typescript
// Current: All 16 built together
export const getCoreSchemas = <T extends ModelState>(state: T): CoreSchemas<T> => {
  return {
    scalarFilter: getScalarFilter(state),
    uniqueFilter: getUniqueFilter(state),
    relationFilter: getRelationFilter(state),
    // ... 13 more
  };
};
```

**Solution:**  
Make each core schema a lazy getter with memoization:

```typescript
// Proposed: Build on demand
export const getCoreSchemas = <T extends ModelState>(state: T): CoreSchemas<T> => {
  const cache: Partial<CoreSchemas<T>> = {};
  return {
    get scalarFilter() { return cache.scalarFilter ??= getScalarFilter(state); },
    get uniqueFilter() { return cache.uniqueFilter ??= getUniqueFilter(state); },
    // ... etc
  };
};
```

**Expected Savings:** Only schemas needed for the operation are built.

---

## Part 2: Validation Library Optimizations

### 2.1 Pre-compute Optional Field Flags

**Location:** `src/validation/schemas/object.ts` (lines 160-167)

**Problem:**  
During first validation, 4 separate runtime checks are performed per field:

```typescript
// Current: 4 checks per field during lazy resolution
const isOptionalWrapper = schemaAny.type === "optional";
const hasOptionalOption = schemaAny.options?.optional === true;
const hasDefaultOption = schemaAny.options?.default !== undefined;
const hasDefaultProp = schemaAny.default !== undefined;
acceptsUndefined[i] = isOptionalWrapper || hasOptionalOption || hasDefaultOption || hasDefaultProp;
```

**Impact:** First validation of any object schema has latency spike.

**Solution:**  
Add a standard flag to all schemas at creation time:

```typescript
// In buildSchema() or createSchema():
const schema = {
  type,
  options,
  // Pre-computed flags
  _acceptsUndefined: options?.optional === true || options?.default !== undefined,
  _isRequired: !(options?.optional === true) && options?.default === undefined,
  // ...
};

// In object validator:
acceptsUndefined[i] = schemaAny._acceptsUndefined ?? false;
```

**Expected Savings:** Eliminates 4 property accesses per field.

---

### 2.2 Cache Validate Function Directly

**Location:** `src/validation/helpers.ts`, throughout codebase

**Problem:**  
Every validation call goes through property lookup chain:

```typescript
// Current: Computed property access
const result = schema["~standard"].validate(value);
```

**Impact:** V8 cannot optimize computed property lookups as well as direct calls.

**Solution:**  
Cache validate function as direct property:

```typescript
// In createSchema():
const schema = {
  type,
  options,
  _validate: validate,  // Direct reference
  "~standard": {
    version: 1,
    vendor: "viborm",
    validate,
    // ...
  },
};

// Usage:
const result = schema._validate(value);  // or schema["~standard"].validate for StandardSchema compliance
```

**Expected Savings:** Faster property access, better V8 inline caching.

---

### 2.3 Pre-split Path in `v.fromObject()`

**Location:** `src/validation/schemas/from-object.ts` (lines 64-71)

**Problem:**  
Path string is split inside the loop for every key:

```typescript
// Current: O(N) string splits
function extractEntries(object: TObject, path: string) {
  for (const key in object) {
    const value = getNestedValue(object[key], path);  // path.split(".") inside!
  }
}
```

**Solution:**  
Split once outside the loop:

```typescript
// Proposed: Split once
function extractEntries(object: TObject, path: string) {
  const pathParts = path.split(".");  // Once
  for (const key in object) {
    const value = getNestedValueByParts(object[key], pathParts);
  }
}
```

**Expected Savings:** N-1 fewer string splits.

---

### 2.4 Avoid Union Error Array Allocation

**Location:** `src/validation/schemas/union.ts` (lines 38-48)

**Problem:**  
Error messages collected in array even when first option matches:

```typescript
// Current: Always allocates array
const errors: string[] = [];
for (const option of options) {
  const result = validateSchema(option, value);
  if (!result.issues) return ok(result.value);  // Early return
  errors.push(result.issues[0]!.message);  // Allocation even on success path
}
return fail(`Value did not match any union member: ${errors.join(", ")}`);
```

**Solution:**  
Only collect errors after all options fail:

```typescript
// Proposed: Lazy error collection
for (const option of options) {
  const result = validateSchema(option, value);
  if (!result.issues) return ok(result.value);
}
// Only now collect errors (second pass, only on failure)
const errors = options.map(o => validateSchema(o, value).issues?.[0]?.message).filter(Boolean);
return fail(`Value did not match any union member: ${errors.join(", ")}`);
```

**Expected Savings:** Zero allocations on success path.

---

### 2.5 Optimize Strict Mode Key Checking

**Location:** `src/validation/schemas/object.ts` (lines 188-193)

**Problem:**  
In strict mode, every input key is checked against the keySet:

```typescript
// Current: O(k) where k = input keys
for (const key in input) {
  if (!keySet.has(key)) {
    return fail(`Unknown key: ${key}`, [key]);
  }
}
```

**Impact:** Large objects with many unknown keys scale poorly.

**Solution:**  
Use size comparison first as fast path:

```typescript
// Proposed: Fast path for common case
const inputKeys = Object.keys(input);
if (inputKeys.length !== keyCount) {
  // Only check if counts differ
  for (const key of inputKeys) {
    if (!keySet.has(key)) {
      return fail(`Unknown key: ${key}`, [key]);
    }
  }
}
```

**Expected Savings:** Skip loop entirely when key counts match.

---

### 2.6 Flatten Closure Chains

**Location:** `src/validation/helpers.ts` (lines 118-140)

**Problem:**  
Each option (schema → transform → nullable → optional → array) wraps the validator in another closure:

```typescript
// Current: Deep closure chain
let validate = baseValidate;
if (hasSchema) {
  const prev = validate;
  validate = (v) => { const r = prev(v); /* ... */ };
}
if (hasTransform) {
  const prev = validate;
  validate = (v) => { const r = prev(v); /* ... */ };
}
// ... more wrapping
```

**Impact:** V8 cannot inline 5+ deep closure chains. Each validation has function call overhead.

**Solution Options:**

**Option A: Code generation**
```typescript
// Generate specialized validator function based on options
const code = generateValidatorCode(options);
const validate = new Function('baseValidate', 'transform', code)(baseValidate, transform);
```

**Option B: Class-based validators**
```typescript
class CompositeValidator {
  constructor(private steps: ValidatorStep[]) {}
  validate(value: unknown) {
    let current = value;
    for (const step of this.steps) {
      const result = step.validate(current);
      if (result.issues) return result;
      current = result.value;
    }
    return ok(current);
  }
}
```

**Option C: Flat switch-based validator**
```typescript
// Pre-compute which steps are needed, use flat function
const validate = (value: unknown) => {
  let result = baseValidate(value);
  if (result.issues) return result;
  
  if (hasSchema) {
    result = schemaValidate(result.value);
    if (result.issues) return result;
  }
  if (hasTransform) {
    result = ok(transform(result.value));
  }
  // ... flat structure, no closures
  return result;
};
```

**Expected Savings:** Better V8 optimization, reduced function call overhead.

**Difficulty:** Hard - requires significant refactoring.

---

### 2.7 Reduce Thunk Detection Overhead

**Location:** `src/validation/schemas/optional.ts` (lines 52-53)

**Problem:**  
Thunk detection happens on every access:

```typescript
// Current: Type check on every call
const isThunk = typeof wrapped === "function" && !("~standard" in wrapped);
```

**Solution:**  
Detect once at schema creation:

```typescript
// Proposed: Detect once
const isThunk = typeof wrapped === "function" && !("~standard" in wrapped);
const getValidate = isThunk
  ? () => (cachedValidate ??= (wrapped as () => VibSchema)()["~standard"].validate)
  : () => (cachedValidate ??= (wrapped as VibSchema)["~standard"].validate);
```

**Expected Savings:** Eliminates type check per validation.

---

### 2.8 Avoid Nested Error Path Array Allocation

**Location:** `src/validation/schemas/object.ts` (lines 224-225)

**Problem:**  
Path construction uses `.concat()` creating new arrays:

```typescript
// Current: New array on every nested error
return fail(issue.message, keyPaths[i]!.concat(issue.path));
```

**Solution:**  
Use mutable path array with push/pop:

```typescript
// Proposed: Reuse path array
const pathStack: PropertyKey[] = [];
// Before validating field:
pathStack.push(keys[i]);
const result = validates[i](value);
if (result.issues) {
  return fail(result.issues[0].message, [...pathStack, ...result.issues[0].path]);
}
pathStack.pop();
```

Or use lazy path building (only construct full path on error).

**Expected Savings:** Fewer array allocations.

---

## Part 3: Implementation Priority

### High Priority (Easy Wins)

| # | Optimization | File | Lines Changed | Impact |
|---|--------------|------|---------------|--------|
| 1 | Per-operation lazy schema loading | `schemas/index.ts` | ~50 | High |
| 2 | Pre-compute optional flags | `object.ts` | ~20 | High |
| 3 | Cache validate function directly | `helpers.ts` | ~10 | Medium |
| 4 | Pre-split path in fromObject | `from-object.ts` | ~10 | Low |

### Medium Priority

| # | Optimization | File | Lines Changed | Impact |
|---|--------------|------|---------------|--------|
| 5 | Lazy field extraction | `model.ts` | ~30 | Medium |
| 6 | Lazy core schema building | `core/index.ts` | ~40 | Medium |
| 7 | Union error allocation | `union.ts` | ~15 | Low |
| 8 | Strict mode optimization | `object.ts` | ~10 | Low |

### Lower Priority (Complex)

| # | Optimization | File | Lines Changed | Impact |
|---|--------------|------|---------------|--------|
| 9 | Flatten closure chains | `helpers.ts` | ~100+ | High |
| 10 | Error path allocation | `object.ts` | ~30 | Low |

---

## Part 4: Benchmarking Strategy

To validate optimizations, measure these scenarios:

### Cold Start (Serverless)
```typescript
// Measure time from import to first query
const start = performance.now();
const { createClient } = await import("viborm");
const client = createClient({ schema, driver });
await client.user.findFirst();
console.log("Cold start:", performance.now() - start);
```

### First Query (Schema Build)
```typescript
// Measure first query after client creation
const client = createClient({ schema, driver });
const start = performance.now();
await client.user.findFirst();
console.log("First query:", performance.now() - start);
```

### Warm Query (Validation Only)
```typescript
// Measure subsequent queries
await client.user.findFirst(); // warm up
const start = performance.now();
for (let i = 0; i < 1000; i++) {
  await client.user.findFirst();
}
console.log("Avg warm query:", (performance.now() - start) / 1000);
```

### Validation Microbenchmark
```typescript
// Measure pure validation cost
const schema = model["~"].schemas.args.findMany;
const input = { where: { id: 1 }, select: { id: true } };
const start = performance.now();
for (let i = 0; i < 10000; i++) {
  parse(schema, input);
}
console.log("Avg validation:", (performance.now() - start) / 10000);
```

---

## Part 5: Compatibility Notes

### Breaking Changes: None Expected

All optimizations are internal implementation details. Public API remains unchanged:
- `s.model()` still returns `Model<State>`
- `v.object()` still returns `ObjectSchema`
- `model["~"].schemas` still returns `ModelSchemas`
- StandardSchema compliance maintained

### Testing Requirements

After implementing optimizations:
1. Run full test suite to ensure behavior unchanged
2. Run type tests to ensure inference unchanged
3. Run benchmarks to validate performance improvements
4. Test circular reference handling still works
5. Test error messages unchanged

---

## Appendix: Current Performance Baseline

From perf-test.ts results:

```
=== Client Instantiation ===
schema.define:           0.12ms
client.pglite.create:    1.23ms
client.driver.create:    0.08ms
client.hydrateSchemas:   0.15ms
client.createRegistry:   0.02ms
client.createQueryEngine: 0.01ms
Total instantiation:     ~2ms

=== First Query (Cold) ===
validate:                0.71ms (27%)
  validate.getSchema:    0.65ms (schema building)
  validate.parse:        0.06ms
createContext:           0.02ms
build:                   0.08ms
execute:                 1.75ms
parse:                   0.04ms
Total:                   ~2.6ms

=== Subsequent Queries (Warm) ===
validate:                0.03ms
execute:                 0.52ms (89%)
parse:                   0.02ms
Total:                   ~0.59ms
```

**Target after optimizations:**
- First query: < 1ms (vs 2.6ms currently)
- Schema build: < 0.1ms (vs 0.65ms currently)
- Warm query: unchanged (~0.59ms, bottleneck is driver)
