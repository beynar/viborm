# Polymorphic Relations in VibORM

## Overview

This document explores the design and implementation of polymorphic relations in VibORM, inspired by Active Record's approach but adapted for TypeScript's type system.

---

## 1. Proposed API Design

### Polymorphic "Belongs To" Side

```typescript
const comment = s.model("comment", {
  id: s.string().id().auto.ulid(),
  body: s.string(),
  
  // Polymorphic relation definition
  commentable: s.relation.polymorphic(() => ({
    post: Post,
    video: Video,
    photo: Photo,
  })),
});
```

**Why this shape?**

| Aspect | Rationale |
|--------|-----------|
| **Arrow function wrapper** | Prevents circular dependency issues (lazy evaluation) |
| **Object with named keys** | Keys become the discriminator values (`commentable_type: "post" \| "video" \| "photo"`) |
| **Type inference** | TypeScript can infer the union type from the object keys and model types |

**What gets generated in the database:**

```sql
-- Two columns are auto-generated:
commentable_type VARCHAR(255) NOT NULL, -- "post" | "video" | "photo"
commentable_id   VARCHAR(26) NOT NULL,  -- ULID or whatever the target's PK type is

-- Composite index for efficient lookups
INDEX idx_commentable (commentable_type, commentable_id)
```

### Inverse Side ("Has Many" through polymorphic)

```typescript
const post = s.model("post", {
  id: s.string().id().auto.ulid(),
  title: s.string(),
  
  // No explicit name needed - VibORM infers from polymorphic key
  comments: s.relation.many(() => Comment),
});
```

**Inference Logic:**

When defining `s.relation.many(() => Comment)` on `Post`, VibORM:

1. Inspects the `Comment` model
2. Finds polymorphic relations
3. Looks for a key matching `"post"` (the current model's name)
4. If found → automatically links to that polymorphic relation

```typescript
// This just works - "post" key exists in commentable's polymorphic definition
comments: s.relation.many(() => Comment),
```

**When is `name` required?**

Only when there's **ambiguity** - i.e., multiple polymorphic relations on the same model that reference the current model:

```typescript
const comment = s.model("comment", {
  // Two polymorphic relations, BOTH include Post
  subject: s.relation.polymorphic(() => ({
    post: Post,
    video: Video,
  })),
  mentionedIn: s.relation.polymorphic(() => ({
    post: Post,      // Also references Post!
    article: Article,
  })),
});

const post = s.model("post", {
  // ❌ Ambiguous: which polymorphic? Error without name
  // comments: s.relation.many(() => Comment),
  
  // ✅ Explicit: specify which polymorphic relation
  subjectComments: s.relation.many(() => Comment, { name: "subject" }),
  mentionedComments: s.relation.many(() => Comment, { name: "mentionedIn" }),
});
```

**Error handling:**

| Scenario | Behavior |
|----------|----------|
| One polymorphic with matching key | ✅ Auto-infer |
| Multiple polymorphic with matching key | ❌ Error: "Ambiguous relation, specify `name`" |
| No polymorphic with matching key | ❌ Error: "No polymorphic relation found for 'post'" |

This matches how Prisma handles regular relations - explicit naming only when ambiguous.

---

## 2. Return Type Shape

### The Discriminated Union Pattern

When including a polymorphic relation, the return type should be a **discriminated union**:

```typescript
type CommentableResult = 
  | { type: "post"; data: Post }
  | { type: "video"; data: Video }
  | { type: "photo"; data: Photo };
```

**Why this shape?**

1. **Type narrowing**: TypeScript can narrow the type based on `type` field
2. **Explicit discrimination**: Clear which variant you're dealing with
3. **Consistent with JSON APIs**: Common pattern in REST/GraphQL responses
4. **Runtime type information**: The `type` field is useful for rendering logic

```typescript
const comments = await orm.comment.findMany({
  include: { commentable: true }
});

for (const comment of comments) {
  switch (comment.commentable.type) {
    case "post":
      console.log(comment.commentable.data.title); // TypeScript knows this is Post
      break;
    case "photo":
      console.log(comment.commentable.data.url); // TypeScript knows this is Photo
      break;
    case "video":
      console.log(comment.commentable.data.duration); // TypeScript knows this is Video
      break;
  }
}
```

### Type Inference Flow

```typescript
// From the polymorphic definition:
s.relation.polymorphic(() => ({
  post: Post,    // key: "post", model: Post
  video: Video,  // key: "video", model: Video
  photo: Photo,  // key: "photo", model: Photo
}))

// Infer:
type PolymorphicKeys = "post" | "video" | "photo";
type PolymorphicResult<K extends PolymorphicKeys> = 
  K extends "post" ? { type: "post"; data: InferModelOutput<typeof Post> } :
  K extends "video" ? { type: "video"; data: InferModelOutput<typeof Video> } :
  K extends "photo" ? { type: "photo"; data: InferModelOutput<typeof Photo> } :
  never;

// Final result type:
type CommentWithCommentable = {
  id: string;
  body: string;
  commentable: PolymorphicResult<PolymorphicKeys>;
};
```

---

## 3. How Active Record Handles the Cons

### Con: No Database-Level Foreign Key Constraints

**Active Record's approach:** They don't solve this at the database level. Instead:

1. **Application-level validation**: `validates :commentable, presence: true`
2. **Dependent destruction**: `has_many :comments, as: :commentable, dependent: :destroy`
3. **Orphan cleanup**: Background jobs or callbacks to handle orphaned polymorphic records

**For VibORM:**
- We should provide validation at the schema level
- Consider a `cleanup` utility for orphaned records
- Document that referential integrity is application-enforced

### Con: Type Column Storage Overhead

**Active Record's approach:** 
- Uses `VARCHAR` by default (inefficient)
- Some gems offer `ENUM` or `TINYINT` mapping for production

**For VibORM:**
- Default to `VARCHAR` for simplicity
- Offer an option for `ENUM` type in PostgreSQL: `s.relation.polymorphic(..., { typeStorage: "enum" })`
- Consider integer mapping for high-volume tables

### Con: Complex Queries

**Active Record's approach:**
- Multiple queries by default (N+1 safe with `includes`)
- `eager_load` forces LEFT JOINs when needed
- Some use `UNION ALL` for complex polymorphic queries

**For VibORM:**
- Default to multi-query approach (simpler, works across databases)
- Optimize with batched queries per type
- Consider `UNION ALL` for advanced use cases

### Con: Indexing Challenges

**Active Record's approach:**
- Composite index on `(type, id)` is standard
- Some add partial indexes per type for high-traffic queries

**For VibORM:**
- Auto-generate composite index by default
- Document partial index patterns for optimization

---

## 4. Alternative Patterns: STI vs CTI

### Single Table Inheritance (STI)

**Concept:** All variants share ONE table with a `type` discriminator column.

```sql
-- One table for all "content" types
CREATE TABLE contents (
  id BIGINT PRIMARY KEY,
  type VARCHAR(255) NOT NULL,  -- "Post", "Photo", "Video"
  
  -- Shared fields
  title VARCHAR(255),
  created_at TIMESTAMP,
  
  -- Post-specific
  body TEXT,
  
  -- Photo-specific  
  url VARCHAR(500),
  width INT,
  height INT,
  
  -- Video-specific
  duration INT,
  thumbnail_url VARCHAR(500)
);
```

**In VibORM (hypothetical API):**

```typescript
const content = s.model("content", {
  id: s.string().id().auto.ulid(),
  title: s.string(),
  createdAt: s.datetime().default.now(),
}).sti({
  discriminator: "type",
  variants: {
    post: {
      body: s.string(),
    },
    photo: {
      url: s.string(),
      width: s.number().optional(),
      height: s.number().optional(),
    },
    video: {
      duration: s.number(),
      thumbnailUrl: s.string().optional(),
    },
  },
});
```

**Pros of STI:**
- ✅ Simple queries (one table)
- ✅ Easy to query across all variants
- ✅ No JOINs needed
- ✅ Works well when variants share most fields

**Cons of STI:**
- ❌ Many nullable columns (sparse data)
- ❌ Wasted space for variant-specific fields
- ❌ Adding fields to one variant affects all
- ❌ Validation becomes complex (conditional required fields)
- ❌ Doesn't scale well with many variants or many variant-specific fields

**When to use STI:**
- Variants share 70%+ of fields
- Few variants (2-5)
- Variant-specific fields are small/few
- Frequent cross-variant queries

---

### Class Table Inheritance (CTI)

**Concept:** Shared base table + separate table per variant.

```sql
-- Base table with shared fields
CREATE TABLE contents (
  id BIGINT PRIMARY KEY,
  type VARCHAR(255) NOT NULL,
  title VARCHAR(255),
  created_at TIMESTAMP
);

-- Variant-specific tables (FK to base)
CREATE TABLE posts (
  id BIGINT PRIMARY KEY REFERENCES contents(id),
  body TEXT
);

CREATE TABLE photos (
  id BIGINT PRIMARY KEY REFERENCES contents(id),
  url VARCHAR(500),
  width INT,
  height INT
);

CREATE TABLE videos (
  id BIGINT PRIMARY KEY REFERENCES contents(id),
  duration INT,
  thumbnail_url VARCHAR(500)
);
```

**In VibORM (hypothetical API):**

```typescript
const content = s.model("content", {
  id: s.string().id().auto.ulid(),
  title: s.string(),
  createdAt: s.datetime().default.now(),
}).cti({
  discriminator: "type",
});

const post = content.extend("post", {
  body: s.string(),
});

const photo = content.extend("photo", {
  url: s.string(),
  width: s.number().optional(),
  height: s.number().optional(),
});

const video = content.extend("video", {
  duration: s.number(),
  thumbnailUrl: s.string().optional(),
});
```

**Pros of CTI:**
- ✅ No nullable columns for variant fields
- ✅ Proper normalization
- ✅ Can add variant fields independently
- ✅ Database constraints work properly
- ✅ Scales well with many variants

**Cons of CTI:**
- ❌ Requires JOINs for full record
- ❌ More complex queries
- ❌ Insert/update touches multiple tables
- ❌ Cross-variant queries need UNION

**When to use CTI:**
- Variants have many distinct fields
- Many variants expected
- Need strict data integrity
- Variant-specific fields are large/many

---

### Comparison Table

| Aspect | Polymorphic | STI | CTI |
|--------|-------------|-----|-----|
| **Use case** | Model belongs to many types | Variants of one concept | Variants of one concept |
| **Tables** | One per model | One for all | Base + one per variant |
| **FK constraints** | ❌ No | ✅ Yes | ✅ Yes |
| **Nullable columns** | Minimal | Many | None |
| **Query complexity** | Medium | Low | High |
| **Extensibility** | High | Medium | High |
| **Type safety** | Discriminated union | Discriminated union | Separate types |

---

## 5. Implementation Roadmap

### Phase 1: Schema Definition

**Goal:** Enable defining polymorphic relations in the schema.

#### Current Architecture Overview

The existing schema system has two layers:

1. **Model Schemas** (`src/schema/model/schemas/`)
   - `core/`: Building blocks (filter, create, update, select, where, orderby)
   - `args/`: Operation argument schemas (findMany, create, update, etc.)
   - Uses `forEachScalarField()` and `forEachRelation()` to iterate fields
   - Composes relation schemas via `v.fromObject(state.relations, "~.schemas.xxx")`

2. **Relation Schemas** (`src/schema/relation/schemas/`)
   - `filter.ts`: `toOneFilterFactory`, `toManyFilterFactory` → `{ is, isNot }` / `{ some, every, none }`
   - `create.ts`: `toOneCreateFactory`, `toManyCreateFactory` → `{ create, connect, connectOrCreate }`
   - `update.ts`: `toOneUpdateFactory`, `toManyUpdateFactory` → `{ create, connect, disconnect, ... }`
   - `select-include.ts`: `toOneSelectFactory`, `toManySelectFactory`, `toOneIncludeFactory`, `toManyIncludeFactory`
   - `helpers.ts`: `getTargetWhereSchema`, `getTargetCreateSchema`, etc. (lazy getters)

**Key insight:** The `RelationState` interface drives everything:

```typescript
interface RelationState {
  type: "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";
  fields?: string[];
  references?: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  optional?: boolean;
  through?: string;
  getter: () => Model;  // Single target model
}
```

For polymorphic, we need a **new relation type** with **multiple target models**.

---

#### New Files to Create

**1. `src/schema/relation/polymorphic-relation.ts`**

```typescript
// New relation class for polymorphic "belongs to"

// The getter returns an object mapping keys to models (not getters)
// This matches the API: s.relation.polymorphic(() => ({ post: Post, video: Video }))
export type PolymorphicModelsGetter<T extends Record<string, AnyModel>> = () => T;

export interface PolymorphicRelationState<
  T extends Record<string, AnyModel> = Record<string, AnyModel>
> {
  type: "polymorphic";
  getter: PolymorphicModelsGetter<T>;  // Lazy getter for circular dep handling
  optional?: boolean;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

export class PolymorphicRelation<
  T extends Record<string, AnyModel>
> {
  private _names: SchemaNames = {};
  
  constructor(private state: PolymorphicRelationState<T>) {}

  get "~"() {
    return {
      state: this.state,
      names: this._names,
      schemas: getPolymorphicRelationSchemas(this.state),
    };
  }

  // Helper methods - resolve the getter when needed
  getModels(): T { 
    return this.state.getter(); 
  }
  
  getKeys(): (keyof T & string)[] { 
    return Object.keys(this.getModels()) as (keyof T & string)[]; 
  }
  
  hasKey(key: string): key is keyof T & string { 
    return key in this.getModels(); 
  }
  
  getModel<K extends keyof T>(key: K): T[K] {
    return this.getModels()[key];
  }
}

// Factory function - matches the proposed API
export const polymorphic = <T extends Record<string, AnyModel>>(
  getter: () => T
) => {
  return new PolymorphicRelation<T>({ type: "polymorphic", getter });
};
```

**Usage matches the proposed API:**

```typescript
// The outer () => is for lazy evaluation
// Inside, models are direct references (not getters)
commentable: s.relation.polymorphic(() => ({
  post: Post,      // Direct model, not () => Post
  video: Video,
  photo: Photo,
}))
```

**2. `src/schema/relation/schemas/polymorphic/` (new directory)**

```
polymorphic/
├── index.ts          # Main export, getPolymorphicRelationSchemas()
├── types.ts          # Type helpers for polymorphic schemas
├── filter.ts         # polymorphicFilterFactory - { type?, is?, isNot? }
├── create.ts         # polymorphicCreateFactory - { connect, create }
├── update.ts         # polymorphicUpdateFactory - { connect, disconnect? }
├── select-include.ts # polymorphicSelectFactory, polymorphicIncludeFactory
└── helpers.ts        # getModelSchema() - get schema from resolved model
```

---

#### Files to Modify

**1. `src/schema/relation/relation.ts`**

Add `name` option to existing relation factories for polymorphic back-reference:

```typescript
// Current:
export const oneToMany = <G extends Getter>(
  getter: G,
  state?: Omit<RelationState, "type" | "through" | "A" | "B" | "getter">
) => { ... };

// Modified:
export interface RelationOptions {
  fields?: string[];
  references?: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  optional?: boolean;
  name?: string;  // NEW: For polymorphic back-reference disambiguation
}

export const oneToMany = <G extends Getter>(
  getter: G,
  state?: RelationOptions
) => { ... };
```

**2. `src/schema/model/model.ts`**

Update `ModelState` to include polymorphic relations:

```typescript
export interface ModelState {
  fields: FieldRecord;
  // ... existing fields ...
  scalars: Record<string, Field>;
  relations: Record<string, AnyRelation>;
  polymorphicRelations: Record<string, PolymorphicRelation<any>>;  // NEW
  uniques: Record<string, Field>;
}
```

Update `extractRelationFields()` helper to separate polymorphic from regular relations.

**3. `src/schema/model/schemas/utils.ts`**

Add iterator for polymorphic relations:

```typescript
// NEW
export const forEachPolymorphicRelation = (
  state: ModelState,
  fn: (name: string, relation: PolymorphicRelation<any>) => void
): void => {
  for (const [name, relation] of Object.entries(state.polymorphicRelations)) {
    fn(name, relation);
  }
};
```

**4. `src/schema/model/schemas/core/filter.ts`**

Add polymorphic filter schema:

```typescript
// NEW: Build filter schema for polymorphic relations
export const getPolymorphicFilter = <T extends ModelState>(state: T) => {
  return v.fromObject(state.polymorphicRelations, "~.schemas.filter");
};
```

**5. `src/schema/model/schemas/core/select.ts`**

Update `getSelectSchema` and `getIncludeSchema` to include polymorphic:

```typescript
export const getSelectSchema = <T extends ModelState>(state: T) => {
  const scalarEntries = v.fromKeys(...);
  const relationEntries = v.fromObject(state.relations, "~.schemas.select", ...);
  
  // NEW: Polymorphic entries
  const polymorphicEntries = v.fromObject(
    state.polymorphicRelations, 
    "~.schemas.select",
    { optional: true }
  );

  return v.object({
    ...scalarEntries.entries,
    ...relationEntries.entries,
    ...polymorphicEntries.entries,  // NEW
    _count: countSchema,
  });
};
```

**6. `src/schema/model/schemas/core/create.ts`**

Add polymorphic create entries:

```typescript
export const getPolymorphicCreate = <T extends ModelState>(state: T) => {
  return v.fromObject(state.polymorphicRelations, "~.schemas.create");
};

export const getCreateSchema = <T extends ModelState>(state: T) => {
  const scalarCreate = getScalarCreate(state);
  const relationCreate = getRelationCreate(state);
  const polymorphicCreate = getPolymorphicCreate(state);  // NEW
  
  return v.object({
    ...scalarCreate.entries,
    ...relationCreate.entries,
    ...polymorphicCreate.entries,  // NEW
  });
};
```

**7. `src/schema/model/schemas/core/where.ts`**

Add polymorphic where entries:

```typescript
export const getWhereSchema = <T extends ModelState>(state: T) => {
  // ... existing scalar and relation filter entries ...
  
  // NEW: Polymorphic filter entries
  const polymorphicEntries = v.fromObject(
    state.polymorphicRelations,
    "~.schemas.filter",
    { optional: true }
  );
  
  return v.object({
    ...scalarFilterEntries.entries,
    ...relationFilterEntries.entries,
    ...polymorphicEntries.entries,  // NEW
    AND: andOrNotSchema,
    OR: andOrNotSchema,
    NOT: andOrNotSchema,
  });
};
```

---

#### New Schema Types for Polymorphic (Properly Typed)

The polymorphic schema factories need rigorous generic typing to ensure type inference flows correctly. Key challenges:

1. **Mapped types over model keys** - Need to preserve literal types for discriminator
2. **Union of target schemas** - Each branch must be typed independently
3. **`v.fromObject()` generics** - Must specify `<ObjectType, SchemaPath, Options>` for inference

**`src/schema/relation/schemas/polymorphic/types.ts`**

```typescript
import type { AnyModel } from "@schema/model";
import type { VibSchema, InferInput, InferOutput } from "@validation";

// Models map is direct models, not getters
// Matches: () => ({ post: Post, video: Video })
export type PolymorphicModelsMap = Record<string, AnyModel>;

// Extract keys as literal union
export type PolymorphicKeys<T extends PolymorphicModelsMap> = keyof T & string;

// Get schema type for a specific key and schema path
type SchemaPath = "where" | "whereUnique" | "create" | "update" | "select" | "include" | "orderBy";

export type SchemaForKey<
  T extends PolymorphicModelsMap,
  K extends keyof T,
  P extends SchemaPath
> = T[K]["~"]["schemas"][P];

// Infer where schema for a specific key
export type PolymorphicWhereForKey<
  T extends PolymorphicModelsMap,
  K extends keyof T
> = SchemaForKey<T, K, "where">;

// Union of all where schemas (input types)
export type PolymorphicWhereUnion<T extends PolymorphicModelsMap> = {
  [K in keyof T]: InferInput<PolymorphicWhereForKey<T, K>>;
}[keyof T];

// Discriminated connect input per key: { type: K, ...whereUnique }
export type PolymorphicConnectForKey<
  T extends PolymorphicModelsMap,
  K extends keyof T
> = {
  type: K;
} & InferInput<SchemaForKey<T, K, "whereUnique">>;

// Union of all connect options
export type PolymorphicConnectUnion<T extends PolymorphicModelsMap> = {
  [K in keyof T]: PolymorphicConnectForKey<T, K>;
}[keyof T];

// Discriminated create input per key: { type: K, data: CreateInput }
export type PolymorphicCreateForKey<
  T extends PolymorphicModelsMap,
  K extends keyof T
> = {
  type: K;
  data: InferInput<SchemaForKey<T, K, "create">>;
};

// Union of all create options
export type PolymorphicCreateUnion<T extends PolymorphicModelsMap> = {
  [K in keyof T]: PolymorphicCreateForKey<T, K>;
}[keyof T];
```

**`src/schema/relation/schemas/polymorphic/filter.ts`**

```typescript
import type { PolymorphicRelationState } from "../../polymorphic-relation";
import type { PolymorphicKeys, PolymorphicWhereForKey, PolymorphicModelsMap } from "./types";
import v, { VibSchema, UnionSchema, ObjectSchema, EnumSchema } from "@validation";

/**
 * Polymorphic filter with full type inference
 * 
 * Input type: {
 *   type?: "post" | "video" | "photo";
 *   is?: PostWhere | VideoWhere | PhotoWhere;
 *   isNot?: PostWhere | VideoWhere | PhotoWhere;
 * }
 */
export const polymorphicFilterFactory = <
  T extends PolymorphicModelsMap,
  S extends PolymorphicRelationState<T>
>(state: S) => {
  type Keys = PolymorphicKeys<T>;
  
  // Resolve the getter to get actual models
  const getModels = () => state.getter() as T;
  
  // Build type enum schema with literal keys preserved
  const typeKeys = () => Object.keys(getModels()) as Keys[];
  const typeSchema = v.enum<Keys, Keys[]>(typeKeys());
  
  // Build union of where schemas with proper typing
  // Each model has its own where schema at model["~"].schemas.where
  type WhereSchemas = { [K in Keys]: PolymorphicWhereForKey<T, K> };
  
  const buildWhereUnion = (): UnionSchema<WhereSchemas[Keys][]> => {
    const models = getModels();
    const schemas = Object.values(models).map((model) => {
      // Get the where schema directly from the model
      return model["~"].schemas.where;
    }) as WhereSchemas[Keys][];
    
    return v.union(schemas);
  };
  
  // Return fully typed object schema
  return v.object({
    type: typeSchema,
    is: buildWhereUnion,  // Thunk for lazy evaluation
    isNot: buildWhereUnion,
  } as const);
};

// Infer the filter schema type
export type PolymorphicFilterSchema<S extends PolymorphicRelationState> = 
  ReturnType<typeof polymorphicFilterFactory<any, S>>;
```

**`src/schema/relation/schemas/polymorphic/create.ts`**

```typescript
import type { PolymorphicRelationState } from "../../polymorphic-relation";
import type { PolymorphicKeys, PolymorphicConnectForKey, ModelFromGetter } from "./types";
import v, { VibSchema, ObjectSchema, LiteralSchema } from "@validation";
import { getTargetWhereUniqueSchema, getTargetCreateSchema } from "../helpers";

/**
 * Polymorphic create with discriminated union types
 * 
 * Input type: {
 *   connect?: { type: "post", id: string } | { type: "video", id: string };
 *   create?: { type: "post", data: PostCreate } | { type: "video", data: VideoCreate };
 * }
 */
export const polymorphicCreateFactory = <
  S extends PolymorphicRelationState<infer T>
>(state: S) => {
  type T = S["models"];
  type Keys = PolymorphicKeys<T>;
  
  // Build connect union: each variant is { type: K, ...whereUnique }
  type ConnectVariant<K extends Keys> = ObjectSchema<{
    type: LiteralSchema<K>;
  }> & ReturnType<typeof getTargetWhereUniqueSchema>;
  
  const connectSchemas = (Object.entries(state.models) as [Keys, T[Keys]][]).map(
    ([key, getter]) => {
      const whereUnique = getTargetWhereUniqueSchema({ getter: getter as () => any })();
      // Merge type literal with whereUnique entries
      return v.object({
        type: v.literal(key),
        ...whereUnique.entries,
      }) as ConnectVariant<typeof key>;
    }
  );
  
  // Build create union: each variant is { type: K, data: CreateSchema }
  type CreateVariant<K extends Keys> = ObjectSchema<{
    type: LiteralSchema<K>;
    data: ModelFromGetter<T[K]>["~"]["schemas"]["create"];
  }>;
  
  const createSchemas = (Object.entries(state.models) as [Keys, T[Keys]][]).map(
    ([key, getter]) => {
      return v.object({
        type: v.literal(key),
        data: getTargetCreateSchema({ getter: getter as () => any }),
      }) as CreateVariant<typeof key>;
    }
  );
  
  return v.object({
    connect: v.union(connectSchemas),
    create: v.union(createSchemas),
  }, { optional: true });
};

export type PolymorphicCreateSchema<S extends PolymorphicRelationState> = 
  ReturnType<typeof polymorphicCreateFactory<S>>;
```

**`src/schema/relation/schemas/polymorphic/select-include.ts`**

```typescript
import type { PolymorphicRelationState } from "../../polymorphic-relation";
import type { PolymorphicKeys, ModelFromGetter } from "./types";
import v, { VibSchema, ObjectSchema } from "@validation";
import { getTargetSelectSchema, getTargetIncludeSchema } from "../helpers";

/**
 * Polymorphic include with per-type selection
 * 
 * Input type: 
 *   | true 
 *   | { post?: true | { select?, include? }; video?: ...; photo?: ... }
 */
export const polymorphicIncludeFactory = <
  S extends PolymorphicRelationState<infer T>
>(state: S) => {
  type T = S["models"];
  type Keys = PolymorphicKeys<T>;
  
  // Per-type include entry: true | { select, include }
  type IncludeEntryForKey<K extends Keys> = 
    | true
    | {
        select?: ModelFromGetter<T[K]>["~"]["schemas"]["select"];
        include?: ModelFromGetter<T[K]>["~"]["schemas"]["include"];
      };
  
  // Build typed entries object
  type TypeSpecificEntries = {
    [K in Keys]?: IncludeEntryForKey<K>;
  };
  
  const entries = {} as Record<Keys, VibSchema>;
  
  for (const [key, getter] of Object.entries(state.models) as [Keys, T[Keys]][]) {
    entries[key] = v.union([
      v.literal(true),
      v.object({
        select: getTargetSelectSchema({ getter: getter as () => any }),
        include: getTargetIncludeSchema({ getter: getter as () => any }),
      }),
    ]);
  }
  
  // Union of: true | { [K in Keys]?: ... }
  return v.union([
    v.literal(true),
    v.object(entries, { optional: true }),
  ]) as VibSchema<true | TypeSpecificEntries, /* output type */>;
};

export type PolymorphicIncludeSchema<S extends PolymorphicRelationState> = 
  ReturnType<typeof polymorphicIncludeFactory<S>>;
```

---

**Update `v.fromObject()` to support polymorphic:**

The existing `v.fromObject()` needs explicit generics for proper inference:

```typescript
// In src/schema/model/schemas/core/select.ts

export const getSelectSchema = <T extends ModelState>(state: T) => {
  // ... existing scalar and relation entries ...
  
  // NEW: Polymorphic entries with explicit generics
  const polymorphicEntries = v.fromObject<
    T["polymorphicRelations"],        // Object type
    "~.schemas.select",               // Schema path
    { optional: true }                // Options
  >(state.polymorphicRelations, "~.schemas.select", {
    optional: true,
  });

  return v.object({
    ...scalarEntries.entries,
    ...relationEntries.entries,
    ...polymorphicEntries.entries,
    _count: countSchema,
  });
};
```

**Type flow visualization:**

```
PolymorphicRelation<{ post: Post, video: Video }>
    │
    ├─► state.getter = () => ({ post: Post, video: Video })
    │
    ├─► state.getter() = { post: Post, video: Video }  // Direct models, NOT getters
    │
    ├─► polymorphicFilterFactory(state)
    │       │
    │       ├─► type T = ReturnType<S["getter"]>  // { post: Post, video: Video }
    │       │
    │       ├─► type Keys = "post" | "video"
    │       │
    │       ├─► typeSchema = EnumSchema<"post" | "video">
    │       │
    │       └─► whereUnion = UnionSchema<[PostWhere, VideoWhere]>
    │
    └─► Result: ObjectSchema<{
            type?: "post" | "video";
            is?: PostWhere | VideoWhere;
            isNot?: PostWhere | VideoWhere;
        }>
```

**Key typing patterns:**

1. **Preserve literal types** - Use `as const` and `[K in Keys]` mapped types
2. **Conditional schema per key** - `{ [K in Keys]: SchemaForModel<T[K]> }[Keys]`
3. **Lazy evaluation** - Return thunks `() => Schema` to avoid circular deps
4. **Generic constraints** - `<S extends PolymorphicRelationState<infer T>>` to extract T

---

#### New Validation Helper: `v.discriminatedUnion()`

To simplify polymorphic schema factories, we should add a new validation schema helper that automatically builds discriminated unions from an object of models.

**Proposed API:**

```typescript
// Build a discriminated union where each variant has { type: K, ...schemaFromPath }
const connectSchema = v.discriminatedUnion(
  state.models,                    // { post: () => Post, video: () => Video }
  "~.schemas.whereUnique",         // Path to schema on each model
  { discriminator: "type" }        // Field name for discriminator (default: "type")
);

// Result type:
// | { type: "post"; id: string; }
// | { type: "video"; id: string; }
```

**Implementation: `src/validation/schemas/discriminated-union.ts`**

```typescript
import type { VibSchema, InferInput, InferOutput, ObjectSchema, LiteralSchema } from "../types";
import type { AnyModel } from "@schema/model";

type SchemaPath = `~.schemas.${string}`;
type SchemaPathKey = "where" | "whereUnique" | "create" | "update" | "select" | "include" | "orderBy";

// Models are direct references, not getters
// Matches: () => ({ post: Post, video: Video })
type ModelsMap = Record<string, AnyModel>;

/**
 * Options for discriminated union
 */
interface DiscriminatedUnionOptions {
  /** Field name for the discriminator. Default: "type" */
  discriminator?: string;
  /** Whether the union is optional */
  optional?: boolean;
  /** Wrap each variant's schema in a "data" field instead of merging */
  wrapInData?: boolean;
}

/**
 * Extract schema path key from full path
 */
type ExtractPathKey<P extends SchemaPath> = P extends `~.schemas.${infer K}` ? K : never;

/**
 * Infer the discriminated union input type
 * 
 * For wrapInData: false (default):
 *   { type: "post", id: string, slug?: string } | { type: "video", id: string }
 * 
 * For wrapInData: true:
 *   { type: "post", data: PostCreate } | { type: "video", data: VideoCreate }
 */
type InferDiscriminatedUnionInput<
  T extends ModelsMap,
  Path extends SchemaPath,
  Disc extends string = "type",
  Wrap extends boolean = false
> = {
  [K in keyof T]: Wrap extends true
    ? { [D in Disc]: K } & { data: InferInput<T[K]["~"]["schemas"][ExtractPathKey<Path>]> }
    : { [D in Disc]: K } & InferInput<T[K]["~"]["schemas"][ExtractPathKey<Path>]>;
}[keyof T];

/**
 * Infer the discriminated union output type
 */
type InferDiscriminatedUnionOutput<
  T extends ModelsMap,
  Path extends SchemaPath,
  Disc extends string = "type",
  Wrap extends boolean = false
> = {
  [K in keyof T]: Wrap extends true
    ? { [D in Disc]: K } & { data: InferOutput<T[K]["~"]["schemas"][ExtractPathKey<Path>]> }
    : { [D in Disc]: K } & InferOutput<T[K]["~"]["schemas"][ExtractPathKey<Path>]>;
}[keyof T];

/**
 * Discriminated union schema class
 */
export class DiscriminatedUnionSchema<
  T extends ModelsMap,
  Path extends SchemaPath,
  Disc extends string = "type",
  Wrap extends boolean = false
> implements VibSchema<
  InferDiscriminatedUnionInput<T, Path, Disc, Wrap>,
  InferDiscriminatedUnionOutput<T, Path, Disc, Wrap>
> {
  readonly " vibInferred": [
    InferDiscriminatedUnionInput<T, Path, Disc, Wrap>,
    InferDiscriminatedUnionOutput<T, Path, Disc, Wrap>
  ] = undefined as any;
  
  constructor(
    private modelsGetter: () => T,  // Lazy getter for circular deps
    private path: Path,
    private options: DiscriminatedUnionOptions = {}
  ) {}
  
  get discriminator(): Disc {
    return (this.options.discriminator ?? "type") as Disc;
  }
  
  private get models(): T {
    return this.modelsGetter();
  }
  
  /**
   * Get all variant schemas
   */
  getVariants(): Array<{ key: keyof T & string; schema: VibSchema }> {
    const pathKey = this.path.replace("~.schemas.", "") as SchemaPathKey;
    
    return Object.entries(this.models).map(([key, model]) => {
      const targetSchema = model["~"].schemas[pathKey];
      return { key, schema: targetSchema };
    });
  }
  
  /**
   * Build the runtime union schema
   */
  build(): UnionSchema<VibSchema[]> {
    const disc = this.discriminator;
    const wrapInData = this.options.wrapInData ?? false;
    
    const variants = this.getVariants().map(({ key, schema }) => {
      if (wrapInData) {
        // { type: "post", data: { ...createSchema } }
        return v.object({
          [disc]: v.literal(key),
          data: schema,
        });
      } else {
        // { type: "post", ...whereUniqueSchema }
        return v.object({
          [disc]: v.literal(key),
          ...(schema as ObjectSchema<any>).entries,
        });
      }
    });
    
    return v.union(variants);
  }
  
  // Standard VibSchema methods delegate to built union
  parse(input: unknown) {
    return this.build().parse(input);
  }
  
  safeParse(input: unknown) {
    return this.build().safeParse(input);
  }
}

/**
 * Factory function for discriminated unions
 * 
 * @param modelsGetter - Lazy getter returning models map: () => ({ post: Post, video: Video })
 * @param path - Schema path to extract from each model: "~.schemas.whereUnique"
 * @param options - Configuration options
 */
export function discriminatedUnion<
  T extends ModelsMap,
  Path extends SchemaPath,
  Disc extends string = "type",
  Wrap extends boolean = false
>(
  modelsGetter: () => T,
  path: Path,
  options?: DiscriminatedUnionOptions & { discriminator?: Disc; wrapInData?: Wrap }
): DiscriminatedUnionSchema<T, Path, Disc, Wrap> {
  return new DiscriminatedUnionSchema(modelsGetter, path, options);
}
```

**Usage in polymorphic schemas (simplified):**

```typescript
// BEFORE (verbose manual union building)
export const polymorphicCreateFactory = <S extends PolymorphicRelationState>(state: S) => {
  const models = state.getter();  // Resolve the lazy getter
  
  const connectSchemas = Object.entries(models).map(([key, model]) => {
    const whereUnique = model["~"].schemas.whereUnique;
    return v.object({
      type: v.literal(key),
      ...whereUnique.entries,
    });
  });
  
  return v.object({
    connect: v.union(connectSchemas),
    // ... more manual union building
  });
};

// AFTER (clean with discriminatedUnion helper)
export const polymorphicCreateFactory = <S extends PolymorphicRelationState>(state: S) => {
  return v.object({
    // Connect: { type: "post", id: "..." } | { type: "video", id: "..." }
    connect: v.discriminatedUnion(
      state.getter,                    // Lazy getter: () => ({ post: Post, video: Video })
      "~.schemas.whereUnique"          // Merge whereUnique into each variant
    ),
    
    // Create: { type: "post", data: { title: "..." } } | { type: "video", data: { ... } }
    create: v.discriminatedUnion(
      state.getter,
      "~.schemas.create",
      { wrapInData: true }             // Wrap in "data" field instead of merging
    ),
  }, { optional: true });
};
```

**Type inference example:**

```typescript
// Schema definition
const commentable = s.relation.polymorphic(() => ({
  post: Post,
  video: Video,
  photo: Photo,
}));

// Using discriminatedUnion in the schema factory
const connectSchema = v.discriminatedUnion(
  commentable["~"].state.getter,  // () => ({ post: Post, video: Video, photo: Photo })
  "~.schemas.whereUnique"
);

// Inferred input type (merged):
type ConnectInput = 
  | { type: "post"; id: string; slug?: string }    // Post's whereUnique fields merged
  | { type: "video"; id: string }                   // Video's whereUnique fields merged
  | { type: "photo"; id: string; albumId: string }  // Photo's whereUnique fields merged

// With wrapInData: true
const createSchema = v.discriminatedUnion(
  commentable["~"].state.getter,
  "~.schemas.create",
  { wrapInData: true }
);

// Inferred input type (wrapped):
type CreateInput = 
  | { type: "post"; data: { title: string; body: string } }
  | { type: "video"; data: { url: string; duration: number } }
  | { type: "photo"; data: { url: string; albumId: string } }
```

**Variant: `v.discriminatedUnionFromSchemas()` for pre-built schemas:**

```typescript
// For cases where you have pre-built schemas directly (not from models)
const filterSchema = v.discriminatedUnionFromSchemas({
  post: postWhereSchema,
  video: videoWhereSchema,
  photo: photoWhereSchema,
}, { discriminator: "type" });

// This is a simpler variant that doesn't need path resolution
```

**Add to validation exports:**

```typescript
// src/validation/index.ts
export { discriminatedUnion, DiscriminatedUnionSchema } from "./schemas/discriminated-union";
```

**Files to create/modify:**

| File | Action | Description |
|------|--------|-------------|
| `src/validation/schemas/discriminated-union.ts` | **CREATE** | New `DiscriminatedUnionSchema` class and factory |
| `src/validation/index.ts` | **MODIFY** | Export `v.discriminatedUnion()` |
| `src/validation/types.ts` | **MODIFY** | Add discriminated union types if needed |

---

#### Type Definitions

**`src/schema/relation/polymorphic-types.ts`**

```typescript
import type { AnyModel } from "../model";
import type { InferModelOutput, InferIncludeResult } from "../../client/result-types";

// Map of type keys to DIRECT models (not getters)
// Matches: () => ({ post: Post, video: Video }) after resolution
export type PolymorphicModelsMap = Record<string, AnyModel>;

// Discriminated union result type
export type PolymorphicResult<T extends PolymorphicModelsMap> = {
  [K in keyof T]: {
    type: K;
    data: InferModelOutput<T[K]>;  // Direct model, not ReturnType
  };
}[keyof T];

// Type column values
export type PolymorphicTypeColumn<T extends PolymorphicModelsMap> = keyof T & string;

// For selective includes - result varies by type
export type PolymorphicSelectiveResult<
  T extends PolymorphicModelsMap,
  I extends Partial<Record<keyof T, any>>
> = {
  [K in keyof T]: K extends keyof I
    ? { type: K; data: InferIncludeResult<T[K], I[K]> }
    : { type: K; data: InferModelOutput<T[K]> };
}[keyof T];

// For optional polymorphic - result can be null
export type PolymorphicResultOptional<T extends PolymorphicModelsMap> = 
  PolymorphicResult<T> | null;
```

---

#### Summary: Schema Changes at a Glance

| File | Action | Description |
|------|--------|-------------|
| **Relation Layer** | | |
| `src/schema/relation/polymorphic-relation.ts` | **CREATE** | New `PolymorphicRelation` class and `polymorphic()` factory |
| `src/schema/relation/polymorphic-types.ts` | **CREATE** | Type definitions for polymorphic results |
| `src/schema/relation/schemas/polymorphic/` | **CREATE** | New directory with filter, create, update, select-include schemas |
| `src/schema/relation/relation.ts` | **MODIFY** | Add `name` option to relation factories |
| `src/schema/relation/schemas/index.ts` | **MODIFY** | Export polymorphic schema factories |
| **Model Layer** | | |
| `src/schema/model/model.ts` | **MODIFY** | Add `polymorphicRelations` to `ModelState` |
| `src/schema/model/helper.ts` | **MODIFY** | Add `extractPolymorphicFields()` helper |
| `src/schema/model/schemas/utils.ts` | **MODIFY** | Add `forEachPolymorphicRelation()` iterator |
| `src/schema/model/schemas/core/filter.ts` | **MODIFY** | Add `getPolymorphicFilter()` |
| `src/schema/model/schemas/core/create.ts` | **MODIFY** | Add `getPolymorphicCreate()` |
| `src/schema/model/schemas/core/update.ts` | **MODIFY** | Add `getPolymorphicUpdate()` |
| `src/schema/model/schemas/core/select.ts` | **MODIFY** | Include polymorphic in select/include schemas |
| `src/schema/model/schemas/core/where.ts` | **MODIFY** | Include polymorphic in where schema |
| **Validation Layer** | | |
| `src/schema/validation/rules/relation.ts` | **MODIFY** | Add P001-P007 polymorphic rules, update CM004 |
| `src/schema/validation/rules/index.ts` | **MODIFY** | Export `polymorphicRules` |
| `src/schema/validation/index.ts` | **MODIFY** | Re-export polymorphic rules |
| `src/schema/validation/types.ts` | **MODIFY** | Add `polymorphicTargets` to `ValidationContext` |
| **VibSchema Layer** | | |
| `src/validation/schemas/discriminated-union.ts` | **CREATE** | New `v.discriminatedUnion()` helper for polymorphic |
| `src/validation/index.ts` | **MODIFY** | Export `discriminatedUnion` |
| **Query Engine Layer** | | |
| `src/query-engine/builders/polymorphic-include-builder.ts` | **CREATE** | Build CASE expressions for polymorphic includes |
| `src/query-engine/types.ts` | **MODIFY** | Add `PolymorphicRelationInfo` interface |
| `src/query-engine/context/index.ts` | **MODIFY** | Add polymorphic to `QueryContext` |
| **Client Layer** | | |
| `src/client/result-types.ts` | **MODIFY** | Add `InferPolymorphicResult<T>` type |
| `src/client/types.ts` | **MODIFY** | Add polymorphic to operation arg types |
| **Database Adapter Layer** | | |
| `src/adapters/types.ts` | **MODIFY** | Add polymorphic JSON helpers to adapter interface |
| `src/adapters/databases/postgres.ts` | **MODIFY** | Implement `polymorphic.buildTypeCase()` |
| `src/adapters/databases/mysql.ts` | **MODIFY** | Implement `polymorphic.buildTypeCase()` |
| **Errors** | | |
| `src/query-engine/errors.ts` | **MODIFY** | Add `PolymorphicTypeError`, `PolymorphicOrphanError` |

---

#### Schema Validation Rules

The existing validation system (`src/schema/validation/`) needs new rules for polymorphic relations. Currently, there's a `polymorphicRelationWarning` (CM004) that warns about manual `*_type + *_id` patterns - this should be updated to recognize valid `s.relation.polymorphic()` usage.

**File to modify: `src/schema/validation/rules/relation.ts`**

**New rules to add:**

```typescript
// =============================================================================
// POLYMORPHIC RELATION RULES (P001-P007)
// =============================================================================

/**
 * P001: All polymorphic target models must exist in schema
 */
export function polymorphicTargetsExist(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [pname, polyRel] of model["~"].polymorphicRelations) {
    const models = polyRel["~"].state.models;
    for (const [key, getter] of Object.entries(models)) {
      const target = getter();
      if (!findModel(schema, target, ctx)) {
        errors.push({
          code: "P001",
          message: `Polymorphic '${pname}' in '${name}' has unregistered target '${key}'`,
          severity: "error",
          model: name,
          relation: pname,
        });
      }
    }
  }
  return errors;
}

/**
 * P002: All polymorphic targets must have compatible primary key types
 */
export function polymorphicPkTypesMatch(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [pname, polyRel] of model["~"].polymorphicRelations) {
    const models = polyRel["~"].state.models;
    const pkTypes: Map<string, string> = new Map();
    
    for (const [key, getter] of Object.entries(models)) {
      const target = getter();
      const pkField = findPrimaryKeyField(target);
      if (pkField) {
        const pkType = pkField["~"].state.type; // e.g., "string", "number"
        pkTypes.set(key, pkType);
      }
    }
    
    const uniqueTypes = new Set(pkTypes.values());
    if (uniqueTypes.size > 1) {
      const typeList = Array.from(pkTypes.entries())
        .map(([k, t]) => `${k}:${t}`)
        .join(", ");
      errors.push({
        code: "P002",
        message: `Polymorphic '${pname}' has mismatched PK types: ${typeList}`,
        severity: "error",
        model: name,
        relation: pname,
      });
    }
  }
  return errors;
}

/**
 * P003: Polymorphic keys must be valid identifiers
 */
export function polymorphicKeysValid(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const VALID_ID = /^[a-z][a-zA-Z0-9]*$/; // lowercase start, camelCase
  const errors: ValidationError[] = [];
  
  for (const [pname, polyRel] of model["~"].polymorphicRelations) {
    const models = polyRel["~"].state.models;
    for (const key of Object.keys(models)) {
      if (!VALID_ID.test(key)) {
        errors.push({
          code: "P003",
          message: `Polymorphic key '${key}' in '${pname}' must be lowercase camelCase`,
          severity: "error",
          model: name,
          relation: pname,
        });
      }
    }
  }
  return errors;
}

/**
 * P004: Polymorphic inverse relations must reference valid polymorphic
 */
export function polymorphicInverseValid(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  
  for (const [rname, rel] of model["~"].relations) {
    const polyName = rel["~"].state.name; // Explicit polymorphic back-reference
    if (!polyName) continue; // No explicit name, will use inference
    
    const target = rel["~"].getter();
    const polyRelations = target["~"].polymorphicRelations;
    
    if (!polyRelations.has(polyName)) {
      errors.push({
        code: "P004",
        message: `Relation '${rname}' references polymorphic '${polyName}' that doesn't exist on target`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/**
 * P005: Polymorphic inverse must be unambiguous or explicit
 */
export function polymorphicInverseUnambiguous(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  
  for (const [rname, rel] of model["~"].relations) {
    if (rel["~"].state.name) continue; // Explicit name provided
    
    const target = rel["~"].getter();
    const polyRelations = target["~"].polymorphicRelations;
    
    // Find polymorphic relations that include this model's name as a key
    const matches: string[] = [];
    for (const [polyName, polyRel] of polyRelations) {
      const modelKey = name.toLowerCase(); // Convention: model name as key
      if (polyRel.hasKey(modelKey) || polyRel.hasKey(name)) {
        matches.push(polyName);
      }
    }
    
    if (matches.length > 1) {
      errors.push({
        code: "P005",
        message: `Relation '${rname}' has ambiguous polymorphic inverse: ${matches.join(", ")}. Use { name: "..." } to disambiguate`,
        severity: "error",
        model: name,
        relation: rname,
      });
    }
  }
  return errors;
}

/**
 * P006: No self-referential polymorphic relations
 */
export function polymorphicNoSelfRef(
  schema: Schema,
  name: string,
  model: Model<any>,
  ctx?: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];
  
  for (const [pname, polyRel] of model["~"].polymorphicRelations) {
    const models = polyRel["~"].state.models;
    for (const [key, getter] of Object.entries(models)) {
      const target = getter();
      const targetName = findModel(schema, target, ctx);
      if (targetName === name) {
        errors.push({
          code: "P006",
          message: `Polymorphic '${pname}' cannot reference itself (key: '${key}')`,
          severity: "error",
          model: name,
          relation: pname,
        });
      }
    }
  }
  return errors;
}

/**
 * P007: Polymorphic relation should have at least 2 targets
 */
export function polymorphicMinTargets(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  
  for (const [pname, polyRel] of model["~"].polymorphicRelations) {
    const targetCount = Object.keys(polyRel["~"].state.models).length;
    if (targetCount < 2) {
      errors.push({
        code: "P007",
        message: `Polymorphic '${pname}' has only ${targetCount} target(s) - use regular relation instead`,
        severity: "warning",
        model: name,
        relation: pname,
      });
    }
  }
  return errors;
}

// Export all polymorphic rules
export const polymorphicRules = [
  polymorphicTargetsExist,
  polymorphicPkTypesMatch,
  polymorphicKeysValid,
  polymorphicInverseValid,
  polymorphicInverseUnambiguous,
  polymorphicNoSelfRef,
  polymorphicMinTargets,
];
```

**Update existing `polymorphicRelationWarning` (CM004):**

```typescript
/**
 * CM004: Polymorphic relation pattern warning
 * 
 * UPDATED: Now recognizes valid polymorphic relations from s.relation.polymorphic()
 * Only warns about MANUAL *_type + *_id patterns without proper polymorphic definition
 */
export function polymorphicRelationWarning(
  _s: Schema,
  name: string,
  model: Model<any>
): ValidationError[] {
  const errors: ValidationError[] = [];
  const fieldNames = Array.from(model["~"].fieldMap.keys());
  
  // Get field names used by proper polymorphic relations
  const validPolyFields = new Set<string>();
  for (const [pname, _] of model["~"].polymorphicRelations) {
    validPolyFields.add(`${pname}_type`);
    validPolyFields.add(`${pname}Type`);
    validPolyFields.add(`${pname}_id`);
    validPolyFields.add(`${pname}Id`);
  }

  // Find manual *_type fields not covered by proper polymorphic
  for (const fname of fieldNames) {
    if (!fname.endsWith("_type") && !fname.endsWith("Type")) continue;
    if (validPolyFields.has(fname)) continue; // Valid polymorphic, skip
    
    const base = fname.replace(/_type$|Type$/, "");
    const idField = fieldNames.find(
      (f) => f === `${base}_id` || f === `${base}Id`
    );

    if (idField && !validPolyFields.has(idField)) {
      errors.push({
        code: "CM004",
        message: `'${fname}' + '${idField}' looks like manual polymorphic pattern. Use s.relation.polymorphic() instead`,
        severity: "warning",
        model: name,
        field: fname,
      });
    }
  }
  return errors;
}
```

**Files to modify:**

| File | Action | Description |
|------|--------|-------------|
| `src/schema/validation/rules/relation.ts` | **MODIFY** | Add P001-P007 polymorphic rules, update CM004 |
| `src/schema/validation/rules/index.ts` | **MODIFY** | Export `polymorphicRules` |
| `src/schema/validation/index.ts` | **MODIFY** | Re-export polymorphic rules |
| `src/schema/validation/types.ts` | **MODIFY** | Update `ValidationContext` to include polymorphic lookup |

**Update `ValidationContext`:**

```typescript
export interface ValidationContext {
  schema: Schema;
  modelToName: Map<Model<any>, string>;
  tableToModels: Map<string, string[]>;
  // NEW: Track polymorphic relations for cross-model validation
  polymorphicTargets: Map<Model<any>, Set<string>>; // model → which polymorphic keys reference it
}
```

---

### Phase 2: Database Schema Generation

**Goal:** Generate correct SQL for polymorphic columns.

**Tasks:**

1. **Modify schema introspection**
   - Detect polymorphic relations during model analysis
   - Generate virtual columns: `${fieldName}_type`, `${fieldName}_id`

2. **SQL generation for columns**
   - `_type`: `VARCHAR(255)` or `ENUM` (PostgreSQL option)
   - `_id`: Match the primary key type of target models (must be consistent!)

3. **Index generation**
   - Auto-create composite index on `(type, id)`
   - Option for partial indexes

4. **Validation**
   - All target models must have compatible primary key types
   - Circular polymorphic references detection

---

### Phase 3: Query Builder Types

**Goal:** Type-safe query input types for polymorphic relations.

**Tasks:**

1. **Where clause types**
   ```typescript
   where: {
     commentable: {
       type: "post",  // Narrows the filter
       is: { title: { contains: "TypeScript" } }
     }
   }
   ```

2. **Connect/Create types**
   ```typescript
   data: {
     commentable: {
       connect: { type: "post", id: "post_123" }
       // OR
       create: { type: "post", data: { title: "New Post" } }
     }
   }
   ```

3. **Include types**
   ```typescript
   include: {
     // Simple: just include polymorphic data
     commentable: true,
     
     // Selective: type-specific nested includes
     commentable: {
       post: { include: { author: true } },
       video: { include: { channel: true, thumbnails: true } },
       photo: true,  // No nested includes for photo
     }
   }
   ```
   
   **Type definition:**
   ```typescript
   type PolymorphicInclude<T extends PolymorphicModels> = 
     | true  // Include all types with base fields only
     | {
         [K in keyof T]?: boolean | {
           include?: IncludeArgs<T[K]>;
           select?: SelectArgs<T[K]>;
         }
       };
   ```

4. **Select types**
   - Polymorphic fields in select should return the full discriminated union
   - Selective selection per type also supported:
   ```typescript
   select: {
     id: true,
     commentable: {
       post: { select: { title: true } },
       video: { select: { duration: true } },
     }
   }
   ```

---

### Phase 4: Query Parser Updates

**Goal:** Parse polymorphic queries into executable operations.

**Tasks:**

1. **Create operation parsing**
   - Handle `connect: { type, id }` format
   - Handle nested `create: { type, data }` format
   - Set both `_type` and `_id` columns appropriately

2. **Where clause parsing**
   - Filter by type: `commentable: { type: "post" }`
   - Filter by related data: `commentable: { is: { ... } }`
   - Combine type + data filters

3. **Include parsing**
   - Track which types need to be loaded
   - Generate grouped queries per type

---

### Phase 5: SQL Generation

**Goal:** Generate efficient SQL for polymorphic operations using VibORM's subquery + JSON aggregation pattern.

**Tasks:**

1. **Insert/Update**
   ```sql
   INSERT INTO comments (id, body, commentable_type, commentable_id)
   VALUES ('cmt_1', 'Great!', 'post', 'post_123');
   ```

2. **Select with polymorphic include (single query with CASE)**
   
   Following VibORM's pattern of correlated subqueries with JSON:
   
   ```sql
   SELECT
     c.id,
     c.body,
     CASE c.commentable_type
       WHEN 'post' THEN json_build_object(
         'type', 'post',
         'data', (
           SELECT json_build_object('id', p.id, 'title', p.title)
           FROM posts p WHERE p.id = c.commentable_id
         )
       )
       WHEN 'video' THEN json_build_object(
         'type', 'video',
         'data', (
           SELECT json_build_object('id', v.id, 'duration', v.duration)
           FROM videos v WHERE v.id = c.commentable_id
         )
       )
       WHEN 'photo' THEN json_build_object(
         'type', 'photo',
         'data', (
           SELECT json_build_object('id', ph.id, 'url', ph.url)
           FROM photos ph WHERE ph.id = c.commentable_id
         )
       )
     END AS commentable
   FROM comments c
   WHERE ...
   ```
   
   **With nested includes per type:**
   Each branch's subquery can itself contain nested subqueries for deeper relations.

3. **Filter by polymorphic relation**
   ```sql
   SELECT c.* FROM comments c
   WHERE c.commentable_type = 'post'
   AND c.commentable_id IN (
     SELECT id FROM posts WHERE title LIKE '%TypeScript%'
   );
   ```
   
4. **Build polymorphic include function**
   
   New builder: `buildPolymorphicInclude(ctx, polymorphicInfo, includeValue, parentAlias)`
   - Generates CASE expression over type column
   - Each WHEN branch builds a correlated subquery for that type
   - Supports selective includes: different nested includes per type
   - Returns `json_build_object('type', typeKey, 'data', subquery)`

---

### Phase 6: Result Hydration

**Goal:** Transform raw SQL results into discriminated union objects.

**Tasks:**

1. **Assemble polymorphic results**
   - Group fetched records by type
   - Match with parent records by `_type` and `_id`
   - Wrap in `{ type, data }` structure

2. **Handle null/missing**
   - If polymorphic target doesn't exist (orphaned), return `null` or error
   - Configurable behavior: `nullOnMissing` vs `errorOnMissing`

3. **Nested polymorphic includes**
   - Recursively handle polymorphic relations within included models

---

### Phase 7: Inverse Relations

**Goal:** Query from the "has many" side through polymorphic.

**Tasks:**

1. **Query generation**
   ```typescript
   // Get all comments for this post
   await orm.post.findUnique({
     where: { id: "post_123" },
     include: { comments: true }
   });
   ```
   
   ```sql
   SELECT * FROM comments
   WHERE commentable_type = 'post' AND commentable_id = 'post_123';
   ```

2. **Create through inverse**
   ```typescript
   await orm.post.update({
     where: { id: "post_123" },
     data: {
       comments: {
         create: [{ body: "New comment!" }]
       }
     }
   });
   ```
   
   Automatically sets `commentable_type = 'post'` and `commentable_id = 'post_123'`.

---

### Phase 8: Validation & Edge Cases

**Goal:** Ensure data integrity and handle edge cases.

**Tasks:**

1. **Schema validation**
   - All polymorphic targets must exist
   - Primary key types must be compatible
   - No self-referential polymorphic relations

2. **Runtime validation**
   - Validate `type` is one of the allowed values
   - Validate `id` exists in the target table (optional, configurable)

3. **Orphan handling**
   - Detect orphaned polymorphic records
   - Provide cleanup utilities
   - Consider cascade options: `onDelete: "cascade" | "setNull" | "restrict"`

4. **Migration considerations**
   - Adding a new type to polymorphic: no migration needed
   - Removing a type: migration to clean orphans
   - Renaming a type: data migration required

---

## 6. Design Decisions

### ✅ Polymorphic "Has One" - Supported

Polymorphic relations support both `many` and `one` cardinality:

```typescript
// Example: A model can have one featured image from different sources
const product = s.model("product", {
  featuredImage: s.relation.polymorphic(() => ({
    photo: Photo,
    generatedImage: GeneratedImage,
    stockImage: StockImage,
  })),
});

// Inverse side
const photo = s.model("photo", {
  featuredOn: s.relation.one(() => Product),  // Has one, not many
});
```

**Database constraint:** For "has one" polymorphic inverses, add a unique constraint on `(type, id)`:

```sql
-- Ensures each photo can only be featured on ONE product
ALTER TABLE products 
ADD CONSTRAINT unique_featured_image 
UNIQUE (featured_image_type, featured_image_id);
```

### ✅ Selective Includes Per Type - Supported

Deep selection with type-specific includes is a core feature:

```typescript
const comments = await orm.comment.findMany({
  include: {
    commentable: {
      post: { include: { author: true } },
      video: { include: { channel: true, thumbnails: true } },
      photo: { include: { album: true } },
    }
  }
});
```

**Return type with selective includes:**

```typescript
type CommentWithCommentable = {
  id: string;
  body: string;
  commentable: 
    | { type: "post"; data: Post & { author: User } }
    | { type: "video"; data: Video & { channel: Channel; thumbnails: Thumbnail[] } }
    | { type: "photo"; data: Photo & { album: Album } };
};
```

**Also supports simple boolean include:**

```typescript
// Just include the base polymorphic data, no nested relations
include: { commentable: true }
```

**Query generation for selective includes:**

VibORM uses correlated subqueries with JSON aggregation (no JOINs):

```sql
SELECT
  c.id,
  c.body,
  -- Polymorphic include as discriminated union JSON
  CASE c.commentable_type
    WHEN 'post' THEN json_build_object(
      'type', 'post',
      'data', (
        SELECT json_build_object(
          'id', p.id,
          'title', p.title,
          'author', (
            SELECT json_build_object('id', u.id, 'name', u.name)
            FROM users u WHERE u.id = p.author_id
          )
        )
        FROM posts p WHERE p.id = c.commentable_id
      )
    )
    WHEN 'video' THEN json_build_object(
      'type', 'video',
      'data', (
        SELECT json_build_object(
          'id', v.id,
          'duration', v.duration,
          'channel', (
            SELECT json_build_object('id', ch.id, 'name', ch.name)
            FROM channels ch WHERE ch.id = v.channel_id
          ),
          'thumbnails', (
            SELECT COALESCE(json_agg(t0), '[]')
            FROM (SELECT json_build_object('id', t.id, 'url', t.url) FROM thumbnails t WHERE t.video_id = v.id) t0
          )
        )
        FROM videos v WHERE v.id = c.commentable_id
      )
    )
    WHEN 'photo' THEN json_build_object(
      'type', 'photo',
      'data', (
        SELECT json_build_object('id', ph.id, 'url', ph.url)
        FROM photos ph WHERE ph.id = c.commentable_id
      )
    )
  END AS commentable
FROM comments c
WHERE ...
```

This follows VibORM's existing pattern of scalar subqueries with `json_build_object` / `json_agg` for nested relations.

---

## 7. Blind Spots & Missing Pieces

After reviewing the document, these areas need additional consideration:

### 7.1 Missing: Polymorphic Update Schema

The document covers filter, create, select-include but **update schema is missing**. What operations should be supported?

```typescript
// Polymorphic update operations
update: {
  commentable: {
    // Change to a different target (disconnect old, connect new)
    connect: { type: "video", id: "video_456" },
    
    // Or just disconnect (only if optional)
    disconnect: true,
  }
}
```

**Note:** You cannot `update` the related record through polymorphic - that would require knowing which table to update. Use separate queries.

**File to create:** `src/schema/relation/schemas/polymorphic/update.ts`

```typescript
export const polymorphicUpdateFactory = <S extends PolymorphicRelationState>(state: S) => {
  const isOptional = state.optional ?? false;
  
  const baseSchema = v.object({
    connect: v.discriminatedUnion(state.getter, "~.schemas.whereUnique"),
  });
  
  if (isOptional) {
    return baseSchema.extend({
      disconnect: v.literal(true),
    });
  }
  
  return baseSchema;
};
```

### 7.2 Missing: Optional Polymorphic Handling

The document mentions `optional?: boolean` but doesn't fully explore:

1. **Return type when null:**
   ```typescript
   type CommentableResult = PolymorphicResult<T> | null;
   ```

2. **Query behavior:**
   ```typescript
   where: {
     commentable: null  // Find comments with no commentable set
   }
   ```

3. **Database columns:**
   ```sql
   commentable_type VARCHAR(255) NULL,  -- NULL when optional
   commentable_id   VARCHAR(26) NULL,
   ```

### 7.3 Missing: Polymorphic in OrderBy

Can you order by a polymorphic relation? **Probably not directly.**

```typescript
// This doesn't make sense - what field to order by?
orderBy: { commentable: "asc" }  // ❌ Invalid

// Could potentially order by type
orderBy: { commentable: { type: "asc" } }  // Maybe?
```

**Recommendation:** Exclude polymorphic from orderBy schema, or only allow ordering by `type`.

### 7.4 Missing: Polymorphic in _count

For polymorphic "belongs to" (like `commentable`), count doesn't make sense - it's always 0 or 1.

```typescript
select: {
  _count: {
    select: {
      commentable: true  // ❌ Should this be allowed?
    }
  }
}
```

**Recommendation:** Exclude polymorphic "belongs to" from `_count`. Only allow on inverse side (`post.comments`).

### 7.5 Missing: Query Engine Integration

The document covers SQL generation but doesn't detail:

1. **QueryContext updates:**
   ```typescript
   interface QueryContext {
     // ... existing ...
     polymorphicRelations: Map<string, PolymorphicRelationInfo>;
   }
   ```

2. **RelationInfo interface needs polymorphic variant:**
   ```typescript
   interface PolymorphicRelationInfo {
     type: "polymorphic";
     models: Record<string, AnyModel>;
     typeColumn: string;
     idColumn: string;
   }
   ```

3. **New builder:** `src/query-engine/builders/polymorphic-include-builder.ts`

### 7.6 Missing: Client Layer Types

The document focuses on schema but doesn't cover result types:

**Files to modify:**

| File | Change |
|------|--------|
| `src/client/result-types.ts` | Add `InferPolymorphicResult<T>` type |
| `src/client/types.ts` | Add polymorphic to operation arg types |

```typescript
// src/client/result-types.ts

// Infer result type for polymorphic field
export type InferPolymorphicResult<
  T extends PolymorphicModelsMap,
  Include extends PolymorphicIncludeArg<T> | undefined
> = Include extends true
  ? PolymorphicResult<T>
  : Include extends Record<string, any>
    ? PolymorphicSelectiveResult<T, Include>
    : never;
```

### 7.7 Missing: MySQL vs PostgreSQL Differences

The SQL examples use `json_build_object` (PostgreSQL). MySQL equivalent:

```sql
-- PostgreSQL
json_build_object('type', 'post', 'data', subquery)

-- MySQL
JSON_OBJECT('type', 'post', 'data', subquery)
```

**Database adapter needs polymorphic JSON helpers:**

```typescript
// src/adapters/types.ts
interface DatabaseAdapter {
  // ... existing ...
  polymorphic: {
    buildTypeCase(typeColumn: string, branches: PolymorphicBranch[]): Sql;
  };
}
```

### 7.8 Missing: Error Types for Runtime

The document mentions errors but doesn't define them:

```typescript
// src/query-engine/errors.ts

export class PolymorphicTypeError extends Error {
  code = "POLYMORPHIC_INVALID_TYPE";
  constructor(
    public field: string,
    public receivedType: string,
    public validTypes: string[]
  ) {
    super(`Invalid polymorphic type '${receivedType}' for '${field}'. Valid: ${validTypes.join(", ")}`);
  }
}

export class PolymorphicOrphanError extends Error {
  code = "POLYMORPHIC_ORPHAN";
  constructor(
    public field: string,
    public type: string,
    public id: string
  ) {
    super(`Polymorphic '${field}' references non-existent ${type}#${id}`);
  }
}
```

### 7.9 Validation Rules: Incorrect Iteration

The validation rules use `for...of` on what would be an object:

```typescript
// WRONG - polymorphicRelations is a Record, not a Map
for (const [pname, polyRel] of model["~"].polymorphicRelations) { ... }

// CORRECT
for (const [pname, polyRel] of Object.entries(model["~"].polymorphicRelations)) { ... }
```

Also, rules reference `polyRel["~"].state.models` but should call the getter:

```typescript
// WRONG
const models = polyRel["~"].state.models;

// CORRECT
const models = polyRel.getModels();  // or polyRel["~"].state.getter()
```

---

## 8. Remaining Open Questions

1. **Cross-database type consistency**
   - What if Post has ULID and Video has UUID?
   - Enforce consistent ID types? Or store as VARCHAR always?
   - **Recommendation:** Require consistent PK types across polymorphic targets, or cast to VARCHAR

2. **Enum type storage for PostgreSQL**
   - Auto-create ENUM type: `CREATE TYPE commentable_type AS ENUM ('post', 'photo', 'video')`
   - Requires migration when adding new types
   - Worth the storage savings?
   - **Recommendation:** Default to VARCHAR, optional `{ typeStorage: "enum" }` for advanced users

3. **Performance optimizations**
   - Materialized polymorphic views?
   - Denormalized type caches?
   - **Recommendation:** Defer to future optimization phase

---

## 9. Success Criteria

- [ ] Can define polymorphic relation with `s.relation.polymorphic()`
- [ ] Polymorphic "has one" inverse supported
- [ ] Polymorphic "has many" inverse supported
- [ ] Type inference works for discriminated unions (`{ type: T, data: TData }`)
- [ ] Automatic inference of inverse relations (no explicit `name` when unambiguous)
- [ ] Explicit `name` required only for ambiguous cases
- [ ] Can create records with polymorphic `connect`
- [ ] Can include polymorphic relations with `include: { commentable: true }`
- [ ] Can use selective includes per type: `{ commentable: { post: { include: { author: true } } } }`
- [ ] Can filter by polymorphic type and related data
- [ ] Inverse relations work (`post.comments`)
- [ ] SQL generation is correct for MySQL and PostgreSQL
- [ ] Full test coverage for polymorphic operations
- [ ] Documentation with examples

---

## 10. References

- [Rails Polymorphic Associations Guide](https://guides.rubyonrails.org/association_basics.html#polymorphic-associations)
- [Prisma Feature Request: Polymorphic Relations](https://github.com/prisma/prisma/issues/1644)
- [TypeORM Polymorphic Relations Discussion](https://github.com/typeorm/typeorm/issues/729)
- [Martin Fowler: Single Table Inheritance](https://martinfowler.com/eaaCatalog/singleTableInheritance.html)
- [Martin Fowler: Class Table Inheritance](https://martinfowler.com/eaaCatalog/classTableInheritance.html)

