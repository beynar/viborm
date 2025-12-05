/**
 * To-Many Relations Contract Tests
 *
 * Verifies type/runtime parity for some/every/none operators on to-many relations.
 */

import { describe, it, expect } from "vitest";
import { s } from "../../src/schema/index.js";
import { buildWhereSchema } from "../../src/schema/model/runtime/core-schemas.js";
import type { ModelWhereInput } from "../../src/schema/model/types/index.js";

// =============================================================================
// TEST MODELS
// =============================================================================

const tag = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
});

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  published: s.boolean().default(false),
});

const author = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  posts: s.relation().oneToMany(() => post),
  tags: s.relation().manyToMany(() => tag),
});

type AuthorFields = (typeof author)["~"]["fields"];

// =============================================================================
// TO-MANY WHERE CONTRACTS
// =============================================================================

describe("To-Many Relation Where Type/Runtime Parity", () => {
  const authorWhere = buildWhereSchema(author);

  describe("some operator", () => {
    it("accepts some with nested conditions", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: { some: { title: "Hello" } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts some with multiple nested conditions", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: { some: { title: "Hello", published: true } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts some with nested operators", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: { some: { title: { contains: "Hello" } } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });
  });

  describe("every operator", () => {
    it("accepts every with nested conditions", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: { every: { published: true } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts every with nested operators", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: { every: { title: { startsWith: "Draft" } } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });
  });

  describe("none operator", () => {
    it("accepts none with nested conditions", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: { none: { published: false } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts none with nested operators", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: { none: { title: { contains: "DELETED" } } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });
  });

  describe("combined operators", () => {
    it("accepts some and every together", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: {
          some: { published: true },
          every: { title: { not: null } }, // not accepts null or string, not object
        },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts some and none together", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: {
          some: { published: true },
          none: { title: { contains: "DRAFT" } },
        },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });
  });

  describe("many-to-many relations", () => {
    it("accepts some on many-to-many", () => {
      const input: ModelWhereInput<AuthorFields> = {
        tags: { some: { name: "typescript" } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts every on many-to-many", () => {
      const input: ModelWhereInput<AuthorFields> = {
        tags: { every: { name: { not: null } } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts none on many-to-many", () => {
      const input: ModelWhereInput<AuthorFields> = {
        tags: { none: { name: "deprecated" } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });
  });

  describe("complex queries", () => {
    it("accepts relation filters with scalar filters", () => {
      const input: ModelWhereInput<AuthorFields> = {
        name: { contains: "John" },
        posts: { some: { published: true } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts multiple relation filters", () => {
      const input: ModelWhereInput<AuthorFields> = {
        posts: { some: { published: true } },
        tags: { some: { name: "typescript" } },
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts relation filters inside AND", () => {
      const input: ModelWhereInput<AuthorFields> = {
        AND: [
          { name: { startsWith: "J" } },
          { posts: { some: { published: true } } },
        ],
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });

    it("accepts relation filters inside OR", () => {
      const input: ModelWhereInput<AuthorFields> = {
        OR: [
          { posts: { some: { title: { contains: "TypeScript" } } } },
          { tags: { some: { name: "javascript" } } },
        ],
      };
      expect(() => authorWhere.assert(input)).not.toThrow();
    });
  });
});

