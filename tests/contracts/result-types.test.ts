/**
 * Result Types Contract Tests
 *
 * Verifies that result types are correctly inferred based on select/include.
 * These are compile-time only tests (type-level).
 */

import { describe, it, expectTypeOf } from "vitest";
import { s } from "../../src/schema/index.js";
import type {
  ModelBaseResult,
  SelectResult,
  IncludeResult,
  InferResult,
} from "../../src/schema/model/types/index.js";

// =============================================================================
// TEST MODELS
// =============================================================================

const profile = s.model({
  id: s.string().id().ulid(),
  bio: s.string().nullable(),
  avatar: s.string().nullable(),
});

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  published: s.boolean().default(false),
});

const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string(),
  age: s.int().nullable(),
  createdAt: s.dateTime().now(),
  profile: s.relation.oneToOne(() => profile),
  posts: s.relation.oneToMany(() => post),
});

type UserFields = (typeof user)["~"]["fields"];
type ProfileFields = (typeof profile)["~"]["fields"];
type PostFields = (typeof post)["~"]["fields"];

// =============================================================================
// BASE RESULT CONTRACTS
// =============================================================================

describe("ModelBaseResult Type Contracts", () => {
  type UserResult = ModelBaseResult<UserFields>;

  it("includes all scalar fields", () => {
    expectTypeOf<UserResult>().toHaveProperty("id");
    expectTypeOf<UserResult>().toHaveProperty("name");
    expectTypeOf<UserResult>().toHaveProperty("email");
    expectTypeOf<UserResult>().toHaveProperty("age");
    expectTypeOf<UserResult>().toHaveProperty("createdAt");
  });

  it("excludes relation fields", () => {
    expectTypeOf<UserResult>().not.toHaveProperty("profile");
    expectTypeOf<UserResult>().not.toHaveProperty("posts");
  });

  it("infers correct scalar types", () => {
    expectTypeOf<UserResult["id"]>().toEqualTypeOf<string>();
    expectTypeOf<UserResult["name"]>().toEqualTypeOf<string>();
    expectTypeOf<UserResult["email"]>().toEqualTypeOf<string>();
  });

  it("infers nullable types correctly", () => {
    expectTypeOf<UserResult["age"]>().toEqualTypeOf<number | null>();
  });

  it("infers datetime as Date", () => {
    expectTypeOf<UserResult["createdAt"]>().toEqualTypeOf<Date>();
  });
});

// =============================================================================
// SELECT RESULT CONTRACTS
// =============================================================================

describe("SelectResult Type Contracts", () => {
  it("returns only selected scalar fields", () => {
    type Result = SelectResult<UserFields, { name: true; email: true }>;

    expectTypeOf<Result>().toHaveProperty("name");
    expectTypeOf<Result>().toHaveProperty("email");
    expectTypeOf<Result>().not.toHaveProperty("id");
    expectTypeOf<Result>().not.toHaveProperty("age");
  });

  it("includes selected relations", () => {
    type Result = SelectResult<UserFields, { name: true; profile: true }>;

    expectTypeOf<Result>().toHaveProperty("name");
    expectTypeOf<Result>().toHaveProperty("profile");
  });

  it("to-one relation is nullable", () => {
    type Result = SelectResult<UserFields, { profile: true }>;

    // profile is to-one optional, so it's nullable
    expectTypeOf<
      Result["profile"]
    >().toMatchTypeOf<ModelBaseResult<ProfileFields> | null>();
  });

  it("to-many relation is array", () => {
    type Result = SelectResult<UserFields, { posts: true }>;

    expectTypeOf<Result["posts"]>().toMatchTypeOf<
      ModelBaseResult<PostFields>[]
    >();
  });
});

// =============================================================================
// INCLUDE RESULT CONTRACTS
// =============================================================================

describe("IncludeResult Type Contracts", () => {
  it("includes all scalars plus included relations", () => {
    type Result = IncludeResult<UserFields, { profile: true }>;

    // All scalars
    expectTypeOf<Result>().toHaveProperty("id");
    expectTypeOf<Result>().toHaveProperty("name");
    expectTypeOf<Result>().toHaveProperty("email");
    expectTypeOf<Result>().toHaveProperty("age");
    expectTypeOf<Result>().toHaveProperty("createdAt");

    // Plus included relation
    expectTypeOf<Result>().toHaveProperty("profile");
  });

  it("to-one included relation is nullable", () => {
    type Result = IncludeResult<UserFields, { profile: true }>;

    expectTypeOf<
      Result["profile"]
    >().toMatchTypeOf<ModelBaseResult<ProfileFields> | null>();
  });

  it("to-many included relation is array", () => {
    type Result = IncludeResult<UserFields, { posts: true }>;

    expectTypeOf<Result["posts"]>().toMatchTypeOf<
      ModelBaseResult<PostFields>[]
    >();
  });

  it("multiple includes work", () => {
    type Result = IncludeResult<UserFields, { profile: true; posts: true }>;

    expectTypeOf<Result>().toHaveProperty("profile");
    expectTypeOf<Result>().toHaveProperty("posts");
  });
});

// =============================================================================
// INFER RESULT DISPATCH CONTRACTS
// =============================================================================

describe("InferResult Type Contracts", () => {
  it("returns base result when no select/include", () => {
    type Result = InferResult<UserFields, {}>;

    // Should be ModelBaseResult - no relations
    expectTypeOf<Result>().toHaveProperty("id");
    expectTypeOf<Result>().toHaveProperty("name");
    expectTypeOf<Result>().not.toHaveProperty("profile");
    expectTypeOf<Result>().not.toHaveProperty("posts");
  });

  it("returns select result when select is provided", () => {
    type Result = InferResult<UserFields, { select: { name: true } }>;

    expectTypeOf<Result>().toHaveProperty("name");
    expectTypeOf<Result>().not.toHaveProperty("id");
    expectTypeOf<Result>().not.toHaveProperty("email");
  });

  it("returns include result when include is provided", () => {
    type Result = InferResult<UserFields, { include: { profile: true } }>;

    // All scalars plus profile
    expectTypeOf<Result>().toHaveProperty("id");
    expectTypeOf<Result>().toHaveProperty("name");
    expectTypeOf<Result>().toHaveProperty("profile");
  });

  it("select takes precedence over include", () => {
    // When both are provided, select wins (Prisma behavior)
    type Result = InferResult<
      UserFields,
      { select: { name: true }; include: { profile: true } }
    >;

    // Should only have name (select takes precedence)
    expectTypeOf<Result>().toHaveProperty("name");
    expectTypeOf<Result>().not.toHaveProperty("id");
    expectTypeOf<Result>().not.toHaveProperty("profile");
  });
});
