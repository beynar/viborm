/**
 * Minimal Where Schema Test
 *
 * Tests just the basic where schema building to isolate issues.
 */

import { describe, it, expect } from "vitest";
import { s } from "../../src/schema/index.js";
import { buildWhereSchema } from "../../src/schema/model/runtime/core-schemas.js";
import type { ModelWhereInput } from "../../src/schema/model/types/index.js";

// =============================================================================
// UNIDIRECTIONAL RELATIONS (no circularity)
// =============================================================================

const author = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  age: s.int().nullable(),
});

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  author: s.relation().manyToOne(() => author),
});

type PostFields = (typeof post)["~"]["fields"];

// =============================================================================
// CONTRACT TESTS
// =============================================================================

describe("Where Schema Type/Runtime Parity", () => {
  const postWhere = buildWhereSchema(post);

  describe("Scalar Fields", () => {
    it("string shorthand - both accept", () => {
      const input: ModelWhereInput<PostFields> = { title: "Hello" };
      expect(() => postWhere.assert(input)).not.toThrow();
    });

    it("string explicit equals - both accept", () => {
      const input: ModelWhereInput<PostFields> = { title: { equals: "Hello" } };
      expect(() => postWhere.assert(input)).not.toThrow();
    });

    it("string contains - both accept", () => {
      const input: ModelWhereInput<PostFields> = {
        title: { contains: "ello", mode: "insensitive" },
      };
      expect(() => postWhere.assert(input)).not.toThrow();
    });
  });

  describe("To-One Relations", () => {
    it("explicit is - both accept", () => {
      const input: ModelWhereInput<PostFields> = {
        author: { is: { name: "Alice" } },
      };
      expect(() => postWhere.assert(input)).not.toThrow();
    });

    it("explicit isNot - both accept", () => {
      const input: ModelWhereInput<PostFields> = {
        author: { isNot: { name: "Bob" } },
      };
      expect(() => postWhere.assert(input)).not.toThrow();
    });

    it("explicit is with nested operators - both accept", () => {
      const input: ModelWhereInput<PostFields> = {
        author: { is: { name: { contains: "ali" }, age: { gte: 18 } } },
      };
      expect(() => postWhere.assert(input)).not.toThrow();
    });

    it("combined is/isNot - both accept", () => {
      const input: ModelWhereInput<PostFields> = {
        author: {
          is: { name: "Alice" },
          isNot: { age: { lt: 18 } },
        },
      };
      expect(() => postWhere.assert(input)).not.toThrow();
    });
  });

  describe("Logical Operators", () => {
    it("AND array - both accept", () => {
      const input: ModelWhereInput<PostFields> = {
        AND: [{ title: "Hello" }, { author: { is: { name: "Alice" } } }],
      };
      expect(() => postWhere.assert(input)).not.toThrow();
    });

    it("OR array - both accept", () => {
      const input: ModelWhereInput<PostFields> = {
        OR: [{ title: "Hello" }, { title: "World" }],
      };
      expect(() => postWhere.assert(input)).not.toThrow();
    });

    it("NOT object - both accept", () => {
      const input: ModelWhereInput<PostFields> = {
        NOT: { title: "Deleted" },
      };
      expect(() => postWhere.assert(input)).not.toThrow();
    });
  });

  describe("Invalid Inputs (runtime rejects)", () => {
    it("rejects number for string field", () => {
      expect(() => postWhere.assert({ title: 123 })).toThrow();
    });

    // NOTE: ArkType allows extra keys by default (structural typing)
    it.skip("rejects unknown fields (needs closed objects)", () => {
      expect(() => postWhere.assert({ unknownField: "value" })).toThrow();
    });
  });
});
