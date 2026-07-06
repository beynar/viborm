/**
 * Validation engine benchmarks.
 *
 * Compares viborm's validation engine against valibot, zod, and arktype via
 * the StandardSchema interface. JIT is disabled everywhere (zod v4 and
 * arktype use eval-based JIT) for a fair comparison that also matches edge
 * runtimes like Cloudflare Workers where eval is forbidden.
 *
 * Run: pnpm bench
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v } from "@validation";
import { type } from "arktype";
import { configure } from "arktype/config";
import {
  array as vbArray,
  boolean as vbBoolean,
  literal as vbLiteral,
  number as vbNumber,
  object as vbObject,
  optional as vbOptional,
  partial as vbPartial,
  string as vbString,
  union as vbUnion,
} from "valibot";
import { bench, describe } from "vitest";
import { z } from "zod";

configure({ jitless: true });
z.config({ jitless: true });

const validate = (schema: StandardSchemaV1, value: unknown): void => {
  void schema["~standard"].validate(value);
};

// ============================================================================
// Schemas
// ============================================================================

const vibormSimpleUser = v.object(
  { id: v.string(), name: v.string(), age: v.number(), active: v.boolean() },
  { partial: false }
);
const valibotSimpleUser = vbObject({
  id: vbString(),
  name: vbString(),
  age: vbNumber(),
  active: vbBoolean(),
});
const zodSimpleUser = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number(),
  active: z.boolean(),
});
const arktypeSimpleUser = type({
  id: "string",
  name: "string",
  age: "number",
  active: "boolean",
});

const vibormComplexUser = v.object(
  {
    id: v.string(),
    email: v.string(),
    name: v.string(),
    age: v.number({ optional: true }),
    role: v.union([v.literal("admin"), v.literal("user"), v.literal("guest")]),
    tags: v.string({ array: true }),
    metadata: v.object({
      createdAt: v.string(),
      updatedAt: v.string(),
      version: v.number(),
    }),
    settings: v.object(
      { theme: v.literal("light"), notifications: v.boolean() },
      { partial: true }
    ),
  },
  { partial: false }
);
const valibotComplexUser = vbObject({
  id: vbString(),
  email: vbString(),
  name: vbString(),
  age: vbOptional(vbNumber()),
  role: vbUnion([vbLiteral("admin"), vbLiteral("user"), vbLiteral("guest")]),
  tags: vbArray(vbString()),
  metadata: vbObject({
    createdAt: vbString(),
    updatedAt: vbString(),
    version: vbNumber(),
  }),
  settings: vbPartial(
    vbObject({
      theme: vbLiteral("light"),
      notifications: vbBoolean(),
    })
  ),
});
const zodComplexUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  age: z.number().optional(),
  role: z.union([z.literal("admin"), z.literal("user"), z.literal("guest")]),
  tags: z.array(z.string()),
  metadata: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number(),
  }),
  settings: z
    .object({ theme: z.literal("light"), notifications: z.boolean() })
    .partial(),
});
const arktypeComplexUser = type({
  id: "string",
  email: "string",
  name: "string",
  "age?": "number",
  role: "'admin' | 'user' | 'guest'",
  tags: "string[]",
  metadata: { createdAt: "string", updatedAt: "string", version: "number" },
  settings: { "theme?": "'light'", "notifications?": "boolean" },
});

const vibormPosts = v.array(
  v.object(
    {
      id: v.string(),
      title: v.string(),
      content: v.string(),
      published: v.boolean(),
      likes: v.number(),
    },
    { partial: false }
  )
);
const valibotPosts = vbArray(
  vbObject({
    id: vbString(),
    title: vbString(),
    content: vbString(),
    published: vbBoolean(),
    likes: vbNumber(),
  })
);
const zodPosts = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    content: z.string(),
    published: z.boolean(),
    likes: z.number(),
  })
);
const arktypePosts = type({
  id: "string",
  title: "string",
  content: "string",
  published: "boolean",
  likes: "number",
}).array();

// ============================================================================
// Data
// ============================================================================

const validSimpleUser = {
  id: "user_123",
  name: "Alice",
  age: 30,
  active: true,
};

const validComplexUser = {
  id: "user_456",
  email: "alice@example.com",
  name: "Alice Smith",
  age: 28,
  role: "admin" as const,
  tags: ["premium", "verified", "early-adopter"],
  metadata: {
    createdAt: "2023-01-15T10:30:00Z",
    updatedAt: "2024-06-20T14:45:00Z",
    version: 3,
  },
  settings: { theme: "light" as const, notifications: true },
};

const validPosts = Array.from({ length: 10 }, (_, i) => ({
  id: `post_${i}`,
  title: `Post Title ${i}`,
  content: `This is the content of post ${i}`,
  published: i % 2 === 0,
  likes: i * 10,
}));

const invalidSimpleUser = {
  id: 123,
  name: "Alice",
  age: "thirty",
  active: true,
};

// ============================================================================
// Benchmarks — libraries within a describe block are compared by vitest
// ============================================================================

describe("validate: simple object (4 fields)", () => {
  bench("viborm", () => validate(vibormSimpleUser, validSimpleUser));
  bench("valibot", () => validate(valibotSimpleUser, validSimpleUser));
  bench("zod", () => validate(zodSimpleUser, validSimpleUser));
  bench("arktype", () => validate(arktypeSimpleUser, validSimpleUser));
});

describe("validate: complex nested object", () => {
  bench("viborm", () => validate(vibormComplexUser, validComplexUser));
  bench("valibot", () => validate(valibotComplexUser, validComplexUser));
  bench("zod", () => validate(zodComplexUser, validComplexUser));
  bench("arktype", () => validate(arktypeComplexUser, validComplexUser));
});

describe("validate: array of 10 objects", () => {
  bench("viborm", () => validate(vibormPosts, validPosts));
  bench("valibot", () => validate(valibotPosts, validPosts));
  bench("zod", () => validate(zodPosts, validPosts));
  bench("arktype", () => validate(arktypePosts, validPosts));
});

describe("validate: invalid data (error path)", () => {
  bench("viborm", () => validate(vibormSimpleUser, invalidSimpleUser));
  bench("valibot", () => validate(valibotSimpleUser, invalidSimpleUser));
  bench("zod", () => validate(zodSimpleUser, invalidSimpleUser));
  bench("arktype", () => validate(arktypeSimpleUser, invalidSimpleUser));
});
