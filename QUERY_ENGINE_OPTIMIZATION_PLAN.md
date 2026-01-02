# Query Engine Optimization Plan

**Status:** Planning
**Overall Code Quality:** Good - production-ready with optimization opportunities

---

## Executive Summary

The query engine is well-architected. This plan identifies **one high-value refactor** to reduce code duplication by ~150 lines and improve maintainability.

**Scope:** Only the many-to-many junction logic consolidation is recommended for immediate implementation. Other items are documented for future consideration.

---

## Prerequisites: Establish Baseline Metrics

Before any refactoring, establish measurable baselines:

### 1. Create Benchmark Suite

```bash
# Add to package.json scripts
"bench": "vitest bench"
```

Create `benchmarks/query-engine.bench.ts`:

```typescript
import { bench, describe } from "vitest";
// Import your query engine and test models

describe("Query Building", () => {
  bench("simple findMany", () => {
    // Build a simple query
  });

  bench("findMany with manyToMany include", () => {
    // Build query with M2M relation
  });

  bench("manyToMany filter (some/every/none)", () => {
    // Build query with M2M filter
  });
});
```

### 2. Record Current Metrics

Before refactoring, document:

| Metric | Current Value |
|--------|---------------|
| Lines in select-builder.ts | 410 |
| Lines in relation-filter-builder.ts | 411 |
| Lines in include-builder.ts | 293 |
| Total M2M-related code | ~250 lines (duplicated across 3 files) |
| Benchmark: M2M include build | TBD μs |
| Benchmark: M2M filter build | TBD μs |

### 3. Test Coverage Check

```bash
pnpm vitest run --coverage
```

Ensure existing tests cover:
- [x] `buildManyToManyCount` in select-builder.ts
- [x] `buildManyToManySubquery` in relation-filter-builder.ts  
- [x] `buildManyToManyInclude` in include-builder.ts

---

## Priority 1: Many-to-Many Junction Logic Consolidation

### Problem

The same junction table setup logic appears in 3 files (~80 lines each = ~240 lines total):

**File 1: `select-builder.ts` lines 325-409** (`buildManyToManyCount`)
```typescript
const sourceModelName = ctx.model["~"].names.ts ?? "unknown";
const targetModelName = relationInfo.targetModel["~"].names.ts ?? "unknown";
const junctionTableName = getJunctionTableName(...);
const [sourceFieldName, targetFieldName] = getJunctionFieldNames(...);
const sourcePkField = getPrimaryKeyField(ctx.model);
const targetPkField = getPrimaryKeyField(relationInfo.targetModel);
// ... build correlation, join condition, from clause
```

**File 2: `relation-filter-builder.ts` lines 329-410** (`buildManyToManySubquery`)
```typescript
// Identical pattern
```

**File 3: `include-builder.ts` lines 175-292** (`buildManyToManyInclude`)
```typescript
// Identical pattern
```

### Solution

Create `src/query-engine/builders/many-to-many-utils.ts`:

```typescript
/**
 * Many-to-Many Junction Utilities
 * 
 * Shared logic for building M2M join conditions across:
 * - select-builder (COUNT)
 * - relation-filter-builder (EXISTS)
 * - include-builder (JSON aggregation)
 */

import { sql, Sql } from "@sql";
import type { QueryContext, RelationInfo } from "../types";
import { getTableName } from "../context";
import { getPrimaryKeyField } from "./correlation-utils";
import {
  getJunctionTableName,
  getJunctionFieldNames,
} from "@schema/relation/relation";

export interface ManyToManyJoinInfo {
  junctionTableName: string;
  sourceFieldName: string;
  targetFieldName: string;
  sourcePkField: string;
  targetPkField: string;
  targetTableName: string;
}

/**
 * Get junction table metadata for a many-to-many relation
 */
export function getManyToManyJoinInfo(
  ctx: QueryContext,
  relationInfo: RelationInfo
): ManyToManyJoinInfo {
  const sourceModelName = ctx.model["~"].names.ts ?? "unknown";
  const targetModelName = relationInfo.targetModel["~"].names.ts ?? "unknown";

  const junctionTableName = getJunctionTableName(
    relationInfo.relation,
    sourceModelName,
    targetModelName
  );
  const [sourceFieldName, targetFieldName] = getJunctionFieldNames(
    relationInfo.relation,
    sourceModelName,
    targetModelName
  );

  const sourcePkField = getPrimaryKeyField(ctx.model);
  const targetPkField = getPrimaryKeyField(relationInfo.targetModel);
  const targetTableName = getTableName(relationInfo.targetModel);

  return {
    junctionTableName,
    sourceFieldName,
    targetFieldName,
    sourcePkField,
    targetPkField,
    targetTableName,
  };
}

/**
 * Build the standard M2M join conditions
 * 
 * Returns:
 * - correlationCondition: jt.sourceId = parent.id
 * - joinCondition: target.id = jt.targetId
 * - fromClause: junction_table jt, target_table t
 */
export function buildManyToManyJoinParts(
  ctx: QueryContext,
  joinInfo: ManyToManyJoinInfo,
  parentAlias: string,
  junctionAlias: string,
  targetAlias: string
): {
  correlationCondition: Sql;
  joinCondition: Sql;
  fromClause: Sql;
} {
  const { adapter } = ctx;
  const {
    junctionTableName,
    sourceFieldName,
    targetFieldName,
    sourcePkField,
    targetPkField,
    targetTableName,
  } = joinInfo;

  // 1. Correlation: jt.sourceId = parent.id
  const junctionSourceCol = adapter.identifiers.column(junctionAlias, sourceFieldName);
  const parentPkCol = adapter.identifiers.column(parentAlias, sourcePkField);
  const correlationCondition = adapter.operators.eq(junctionSourceCol, parentPkCol);

  // 2. Join: target.id = jt.targetId
  const targetPkCol = adapter.identifiers.column(targetAlias, targetPkField);
  const junctionTargetCol = adapter.identifiers.column(junctionAlias, targetFieldName);
  const joinCondition = adapter.operators.eq(targetPkCol, junctionTargetCol);

  // 3. FROM clause
  const fromClause = sql`${adapter.identifiers.table(junctionTableName, junctionAlias)}, ${adapter.identifiers.table(targetTableName, targetAlias)}`;

  return { correlationCondition, joinCondition, fromClause };
}
```

### Files to Update

**1. `select-builder.ts`** - Replace `buildManyToManyCount` (lines 325-409):

```typescript
import { getManyToManyJoinInfo, buildManyToManyJoinParts } from "./many-to-many-utils";

function buildManyToManyCount(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  config: unknown,
  parentAlias: string
): Sql {
  const { adapter } = ctx;
  
  const junctionAlias = ctx.nextAlias();
  const targetAlias = ctx.nextAlias();
  
  const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
  const { correlationCondition, joinCondition, fromClause } = buildManyToManyJoinParts(
    ctx, joinInfo, parentAlias, junctionAlias, targetAlias
  );

  const conditions: Sql[] = [correlationCondition, joinCondition];

  // Add inner where if provided
  if (typeof config === "object" && config !== null && "where" in config) {
    const childCtx = createChildContext(ctx, relationInfo.targetModel, targetAlias);
    const rawWhere = (config as { where: Record<string, unknown> }).where;
    const whereSchema = relationInfo.targetModel["~"].schemas.where;
    const normalizedWhere = whereSchema
      ? (parse(whereSchema, rawWhere).value as Record<string, unknown>)
      : rawWhere;
    const innerWhere = buildWhere(childCtx, normalizedWhere, targetAlias);
    if (innerWhere) {
      conditions.push(innerWhere);
    }
  }

  const whereCondition = adapter.operators.and(...conditions);
  return adapter.subqueries.scalar(
    sql`SELECT COUNT(*) FROM ${fromClause} WHERE ${whereCondition}`
  );
}
```

**2. `relation-filter-builder.ts`** - Replace `buildManyToManySubquery` (lines 329-410):

```typescript
import { getManyToManyJoinInfo, buildManyToManyJoinParts } from "./many-to-many-utils";

function buildManyToManySubquery(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  innerWhere: Record<string, unknown> | undefined,
  parentAlias: string,
  negateInner: boolean
): Sql {
  const { adapter } = ctx;

  const junctionAlias = ctx.nextAlias();
  const targetAlias = ctx.nextAlias();

  const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
  const { correlationCondition, joinCondition, fromClause } = buildManyToManyJoinParts(
    ctx, joinInfo, parentAlias, junctionAlias, targetAlias
  );

  // Build inner where on target
  const childCtx = createChildContext(ctx, relationInfo.targetModel, targetAlias);
  let innerCondition = buildWhere(childCtx, innerWhere, targetAlias);

  if (negateInner && innerCondition) {
    innerCondition = adapter.operators.not(innerCondition);
  }

  const conditions: Sql[] = [correlationCondition, joinCondition];
  if (innerCondition) {
    conditions.push(innerCondition);
  }

  const whereClause = adapter.operators.and(...conditions);
  return sql`SELECT 1 FROM ${fromClause} WHERE ${whereClause}`;
}
```

**3. `include-builder.ts`** - Replace `buildManyToManyInclude` (lines 175-292):

```typescript
import { getManyToManyJoinInfo, buildManyToManyJoinParts } from "./many-to-many-utils";

function buildManyToManyInclude(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  includeValue: Record<string, unknown>,
  parentAlias: string
): Sql {
  const { adapter } = ctx;

  const junctionAlias = ctx.nextAlias();
  const targetAlias = ctx.nextAlias();

  const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
  const { correlationCondition, joinCondition, fromClause } = buildManyToManyJoinParts(
    ctx, joinInfo, parentAlias, junctionAlias, targetAlias
  );

  // Create child context for target
  const childCtx = createChildContext(ctx, relationInfo.targetModel, targetAlias);

  // Extract include options
  const { select, include, where, orderBy, take, skip } = includeValue as {
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Record<string, unknown>[];
    take?: number;
    skip?: number;
  };

  // Build JSON object for selected fields
  const jsonExpr = buildSelect(childCtx, select, include, targetAlias, { asJson: true });

  // Build inner where
  const innerWhere = buildWhere(childCtx, where, targetAlias);

  const conditions: Sql[] = [correlationCondition, joinCondition];
  if (innerWhere) {
    conditions.push(innerWhere);
  }
  const whereCondition = adapter.operators.and(...conditions);

  // Build ORDER BY
  const orderBySql = buildOrderBy(childCtx, orderBy, targetAlias);

  // Build inner query
  const innerParts: Sql[] = [
    sql`SELECT ${jsonExpr}`,
    sql`FROM ${fromClause}`,
    sql`WHERE ${whereCondition}`,
  ];

  if (orderBySql) {
    innerParts.push(sql`ORDER BY ${orderBySql}`);
  }
  if (take !== undefined) {
    innerParts.push(sql`LIMIT ${adapter.literals.value(take)}`);
  }
  if (skip !== undefined) {
    innerParts.push(sql`OFFSET ${adapter.literals.value(skip)}`);
  }

  const innerQuery = sql.join(innerParts, " ");

  // Wrap with aggregation
  const subAlias = ctx.nextAlias();
  return adapter.subqueries.scalar(
    sql`SELECT ${adapter.json.agg(adapter.identifiers.escape(subAlias))} FROM (${innerQuery}) ${adapter.identifiers.escape(subAlias)}`
  );
}
```

### Expected Impact

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Duplicated M2M code | ~240 lines | 0 lines | -240 |
| New utility file | 0 | ~80 lines | +80 |
| **Net reduction** | - | - | **-160 lines** |
| Files to modify for M2M changes | 3 | 1 | -66% |

### Estimated Effort

- Create utility file: 1 hour
- Update 3 builder files: 2 hours
- Test all M2M scenarios: 1 hour
- **Total: 4 hours**

---

## Deferred Items (Future Consideration)

These are NOT recommended for immediate implementation. Document for later:

### Low Priority: FK Assignment Consolidation

The FK helper functions in `nested-writes.ts` (lines 87-180) are used only within that file. Extracting them provides minimal benefit until other files need them.

**Recommendation:** Keep as-is. Revisit if FK logic is needed elsewhere.

### Low Priority: QueryContext Caching

Caching model metadata in QueryContext could improve performance, but:
- No benchmarks prove this is a bottleneck
- Adds complexity
- Risk of stale cache bugs

**Recommendation:** Run benchmarks first. Only implement if lookups show as >5% of query build time.

### Low Priority: Result Parser JSON Optimization

Schema-aware JSON parsing could help, but:
- Only matters for 1000+ row result sets
- Adds complexity
- Current heuristic works well

**Recommendation:** Benchmark with large result sets. Only optimize if parsing is >50% of total query time.

---

## Implementation Checklist

### Before Starting
- [ ] Create benchmark suite
- [ ] Record baseline metrics
- [ ] Verify test coverage for M2M operations

### Implementation
- [ ] Create `src/query-engine/builders/many-to-many-utils.ts`
- [ ] Update `select-builder.ts` - use new utility
- [ ] Update `relation-filter-builder.ts` - use new utility
- [ ] Update `include-builder.ts` - use new utility
- [ ] Run all tests
- [ ] Run benchmarks - verify no regression

### After Completion
- [ ] Record new metrics
- [ ] Update this document with actual results

---

## Success Criteria

1. All existing tests pass
2. No performance regression (benchmark within 5%)
3. ~150 lines of code removed
4. Single source of truth for M2M junction logic
