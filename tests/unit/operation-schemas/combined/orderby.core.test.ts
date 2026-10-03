/**
 * OrderBy Schema Tests
 *
 * Tests the orderBy schema which allows asc/desc ordering on scalar fields
 * and nested ordering on relations.
 */

import { s } from "@schema";
import {
  authorSchemas,
  postSchemas,
  simpleSchemas,
} from "@tests/unit/operation-schemas/fixtures";
import {
  createSchemaRegistry,
  type InferInput,
  parse,
  toJsonSchema,
} from "@validation";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

test("unused to-one ordering stays lazy while each registry owns its resolution", () => {
  const author = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });
  const post = s.model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  });
  const first = createSchemaRegistry({ author, post }).proxy.post.core.orderBy;
  const second = createSchemaRegistry({ author, post }).proxy.post.core.orderBy;
  const targetReads = vi.spyOn(author, "~", "get");
  try {
    expect(parse(first, { id: "asc", author: undefined })).toEqual({
      value: { id: "asc" },
    });
    expect(targetReads).not.toHaveBeenCalled();

    expect(parse(first, { author: { id: "desc" } })).toEqual({
      value: { author: { id: "desc" } },
    });
    expect(targetReads).toHaveBeenCalled();
    targetReads.mockClear();
    expect(parse(first, { author: { id: "asc" } })).toEqual({
      value: { author: { id: "asc" } },
    });
    expect(targetReads).not.toHaveBeenCalled();

    expect(toJsonSchema(second)).toMatchObject({
      type: "object",
      properties: { author: { type: "object" } },
    });
    expect(targetReads).toHaveBeenCalled();
    expect(parse(second, { author: { id: "desc" } })).toEqual({
      value: { author: { id: "desc" } },
    });
  } finally {
    targetReads.mockRestore();
  }
});

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("OrderBy Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.orderBy>;

  test("type: includes scalar fields", () => {
    expectTypeOf<Input>().toHaveProperty("id");
    expectTypeOf<Input>().toHaveProperty("name");
    expectTypeOf<Input>().toHaveProperty("email");
    expectTypeOf<Input>().toHaveProperty("age");
    expectTypeOf<Input>().toHaveProperty("active");
  });

  test("type: all fields are optional (empty object matches)", () => {
    // biome-ignore lint/complexity/noBannedTypes: the empty object type is the subject of this type assertion.
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// TYPE TESTS - Author Model (with relations)
// =============================================================================

describe("OrderBy Schema - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas.orderBy>;

  test("type: includes relation fields", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("OrderBy Schema - Simple Model Runtime", () => {
  const schema = simpleSchemas.orderBy;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts asc order", () => {
    const result = parse(schema, { name: "asc" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts desc order", () => {
    const result = parse(schema, { name: "desc" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts multiple fields", () => {
    const result = parse(schema, {
      name: "asc",
      age: "desc",
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects invalid order value", () => {
    const result = parse(schema, { name: "ascending" });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects unknown field (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { unknownField: "asc" });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("OrderBy Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.orderBy;

  test("runtime: accepts scalar ordering", () => {
    const result = parse(schema, { name: "asc" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation count ordering", () => {
    const result = parse(schema, {
      posts: { _count: "desc" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts combined scalar and relation ordering", () => {
    const result = parse(schema, {
      name: "asc",
      posts: { _count: "desc" },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("OrderBy Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.orderBy;

  test("runtime: accepts scalar ordering", () => {
    const result = parse(schema, { title: "asc" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested ordering on toOne relation", () => {
    const result = parse(schema, {
      author: { name: "asc" },
    });
    expect(result.issues).toBeUndefined();
  });
});
