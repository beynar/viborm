/**
 * Test Model Definitions
 *
 * Isolated model definitions for testing without client imports.
 * This avoids the path alias issues when testing runtime schemas.
 */

import z from "zod/v4";
import { s } from "../src/schema/index.js";

// =============================================================================
// FIELD EXPORTS (for field type inference tests)
// =============================================================================

export const string = s.string();
export const nullableString = s.string().nullable();
export const stringWithDefault = s.string().default("default");
export const stringWithValidation = s.string().validator(z.email());

export const number = s.int();
export const nullableNumber = s.int().nullable();
export const numberWithDefault = s.int().default(1);
export const numberWithValidation = s.int().validator(z.number().min(1));

export const boolean = s.boolean();
export const nullableBoolean = s.boolean().nullable();
export const booleanWithDefault = s.boolean().default(true);

export const bigint = s.bigInt();
export const nullableBigint = s.bigInt().nullable();
export const bigintWithDefault = s.bigInt().default(BigInt(1));

export const dateTime = s.dateTime();
export const nullableDateTime = s.dateTime().nullable();
export const dateTimeWithDefault = s.dateTime().default(new Date());

export const simpleJson = z.object({
  name: z.string(),
  age: z.number(),
});
export const json = s.json(simpleJson);
export const nullableJson = s.json(simpleJson).nullable();

export const blob = s.blob();
export const nullableBlob = s.blob().nullable();

export const enumField = s.enum(["a", "b"]);
export const nullableEnumField = s.enum(["a", "b"]).nullable();
export const enumFieldWithDefault = s.enum(["a", "b"]).default("a");

// =============================================================================
// TEST MODELS FOR CONTRACT TESTS
// =============================================================================

/**
 * Test user model - main model with all relation types
 */
export const testUser = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),
  bio: s.string().nullable(),
  tags: s.string().array(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().now(),
  // Relations - using builder pattern: s.relation.config().type(() => model)
  posts: s.relation.oneToMany(() => testPost),
  profile: s.relation.oneToOne(() => testProfile),
  friends: s.relation.manyToMany(() => testUser),
});

/**
 * Test post model - with manyToOne back-reference to user
 */
export const testPost = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  content: s.string().nullable(),
  published: s.boolean().default(false),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().now(),
  authorId: s.string(),
  // Relations
  author: s.relation.manyToOne(() => testUser),
  metadata: s
    .json(
      z.object({
        tags: z.array(z.string()),
      })
    )
    .nullable(),
});

/**
 * Test profile model - with oneToOne back-reference to user
 */
export const testProfile = s.model({
  id: s.string().id().ulid(),
  bio: s.string().nullable(),
  avatar: s.string().nullable(),
  userId: s.string().unique(),
  // Relations
  user: s.relation.oneToOne(() => testUser),
});

// =============================================================================
// SCHEMA BUNDLE (for tests that need all models)
// =============================================================================

export const testSchema = {
  user: testUser,
  post: testPost,
  profile: testProfile,
};
