/**
 * Select/Include Schema Contract Tests
 *
 * Verifies type/runtime parity for select and include operations.
 */

import { describe, it, expect } from "vitest";
import { s } from "../../src/schema/index.js";
import {
  buildSelectSchema,
  buildIncludeSchema,
} from "../../src/schema/model/runtime/core-schemas.js";
import type {
  ModelSelect,
  ModelInclude,
} from "../../src/schema/model/types/index.js";

// =============================================================================
// TEST MODELS
// =============================================================================

const profile = s.model({
  id: s.string().id().ulid(),
  bio: s.string().nullable(),
});

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  content: s.string().nullable(),
});

const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string(),
  profile: s.relation.oneToOne(() => profile),
  posts: s.relation.oneToMany(() => post),
});

type UserFields = (typeof user)["~"]["fields"];

// =============================================================================
// SELECT CONTRACTS
// =============================================================================

describe("Select Schema Type/Runtime Parity", () => {
  const selectSchema = buildSelectSchema(user);

  describe("Scalar Selection", () => {
    it("accepts boolean true for scalar", () => {
      const input: ModelSelect<UserFields> = {
        name: true,
      };
      expect(() => selectSchema.assert(input)).not.toThrow();
    });

    it("accepts boolean false for scalar", () => {
      const input: ModelSelect<UserFields> = {
        name: false,
      };
      expect(() => selectSchema.assert(input)).not.toThrow();
    });

    it("accepts multiple scalar selections", () => {
      const input: ModelSelect<UserFields> = {
        id: true,
        name: true,
        email: true,
      };
      expect(() => selectSchema.assert(input)).not.toThrow();
    });
  });

  describe("Relation Selection", () => {
    it("accepts boolean true for relation", () => {
      const input: ModelSelect<UserFields> = {
        profile: true,
      };
      expect(() => selectSchema.assert(input)).not.toThrow();
    });

    it("accepts boolean true for to-many relation", () => {
      const input: ModelSelect<UserFields> = {
        posts: true,
      };
      expect(() => selectSchema.assert(input)).not.toThrow();
    });
  });

  describe("Mixed Selection", () => {
    it("accepts scalars and relations together", () => {
      const input: ModelSelect<UserFields> = {
        name: true,
        email: true,
        profile: true,
        posts: true,
      };
      expect(() => selectSchema.assert(input)).not.toThrow();
    });
  });

  describe("Empty Selection", () => {
    it("accepts empty object", () => {
      const input: ModelSelect<UserFields> = {};
      expect(() => selectSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// INCLUDE CONTRACTS
// =============================================================================

describe("Include Schema Type/Runtime Parity", () => {
  const includeSchema = buildIncludeSchema(user);

  describe("Simple Include", () => {
    it("accepts boolean true for to-one relation", () => {
      const input: ModelInclude<UserFields> = {
        profile: true,
      };
      expect(() => includeSchema.assert(input)).not.toThrow();
    });

    it("accepts boolean true for to-many relation", () => {
      const input: ModelInclude<UserFields> = {
        posts: true,
      };
      expect(() => includeSchema.assert(input)).not.toThrow();
    });

    it("accepts multiple includes", () => {
      const input: ModelInclude<UserFields> = {
        profile: true,
        posts: true,
      };
      expect(() => includeSchema.assert(input)).not.toThrow();
    });
  });

  describe("Empty Include", () => {
    it("accepts empty object", () => {
      const input: ModelInclude<UserFields> = {};
      expect(() => includeSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// NESTED SELECT/INCLUDE CONTRACTS
// =============================================================================

import {
  buildSelectNestedSchema,
  buildIncludeNestedSchema,
} from "../../src/schema/model/runtime/nested-schemas.js";
import type {
  ModelSelectNested,
  ModelIncludeNested,
} from "../../src/schema/model/types/index.js";

describe("Nested Select Schema Type/Runtime Parity", () => {
  const selectNestedSchema = buildSelectNestedSchema(user);

  describe("Nested select with filtering (to-many)", () => {
    it("accepts nested select on to-many relation", () => {
      const input: ModelSelectNested<UserFields> = {
        name: true,
        posts: {
          select: {
            title: true,
          },
        },
      };
      expect(() => selectNestedSchema.assert(input)).not.toThrow();
    });

    it("accepts nested select with where filter", () => {
      const input: ModelSelectNested<UserFields> = {
        posts: {
          select: { title: true },
          where: { title: "Hello" },
        },
      };
      expect(() => selectNestedSchema.assert(input)).not.toThrow();
    });

    it("accepts nested select with take/skip", () => {
      const input: ModelSelectNested<UserFields> = {
        posts: {
          select: { title: true },
          take: 10,
          skip: 5,
        },
      };
      expect(() => selectNestedSchema.assert(input)).not.toThrow();
    });
  });

  describe("Nested include inside select", () => {
    it("accepts include inside select for to-one relation", () => {
      const input: ModelSelectNested<UserFields> = {
        name: true,
        profile: {
          select: { bio: true },
          include: {}, // would include nested relations if profile had any
        },
      };
      expect(() => selectNestedSchema.assert(input)).not.toThrow();
    });

    it("accepts include inside select for to-many relation", () => {
      const input: ModelSelectNested<UserFields> = {
        posts: {
          select: { title: true },
          include: {}, // would include nested relations if post had any
        },
      };
      expect(() => selectNestedSchema.assert(input)).not.toThrow();
    });
  });
});

describe("Nested Include Schema Type/Runtime Parity", () => {
  const includeNestedSchema = buildIncludeNestedSchema(user);

  describe("Nested include with filtering (to-many)", () => {
    it("accepts nested include on to-many relation", () => {
      const input: ModelIncludeNested<UserFields> = {
        posts: {
          select: {
            title: true,
          },
        },
      };
      expect(() => includeNestedSchema.assert(input)).not.toThrow();
    });

    it("accepts nested include with where filter", () => {
      const input: ModelIncludeNested<UserFields> = {
        posts: {
          where: { title: "Hello" },
          take: 5,
        },
      };
      expect(() => includeNestedSchema.assert(input)).not.toThrow();
    });
  });

  describe("Nested select inside include", () => {
    it("accepts select inside include", () => {
      const input: ModelIncludeNested<UserFields> = {
        profile: {
          select: { bio: true },
        },
      };
      expect(() => includeNestedSchema.assert(input)).not.toThrow();
    });
  });

  describe("Deep nesting", () => {
    it("accepts nested include inside include", () => {
      const input: ModelIncludeNested<UserFields> = {
        profile: {
          include: {}, // nested include
        },
      };
      expect(() => includeNestedSchema.assert(input)).not.toThrow();
    });
  });
});
