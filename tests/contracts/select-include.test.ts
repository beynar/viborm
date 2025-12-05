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
  profile: s.relation().oneToOne(() => profile),
  posts: s.relation().oneToMany(() => post),
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

