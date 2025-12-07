/**
 * Blob Field Contract Tests
 *
 * Validates type/runtime parity for blob (binary) fields.
 * Tests: filter, create, update operations.
 */

import { describe, it, expect } from "vitest";
import {
  buildWhereSchema,
  buildCreateSchema,
  buildUpdateSchema,
} from "../../../src/schema/model/runtime/core-schemas.js";
import type {
  ModelWhereInput,
  ModelCreateInput,
  ModelUpdateInput,
} from "../../../src/schema/model/types/index.js";
import { blobModel, type BlobModelFields } from "../models.js";

const whereSchema = buildWhereSchema(blobModel);
const createSchema = buildCreateSchema(blobModel);
const updateSchema = buildUpdateSchema(blobModel);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("Blob Filter", () => {
  describe("equals", () => {
    it("accepts Uint8Array shorthand", () => {
      const input: ModelWhereInput<BlobModelFields> = {
        required: new Uint8Array([1, 2, 3]),
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit equals", () => {
      const input: ModelWhereInput<BlobModelFields> = {
        required: { equals: new Uint8Array([1, 2, 3]) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts empty Uint8Array", () => {
      const input: ModelWhereInput<BlobModelFields> = {
        required: new Uint8Array([]),
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("not", () => {
    it("accepts not", () => {
      const input: ModelWhereInput<BlobModelFields> = {
        required: { not: new Uint8Array([0]) },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null shorthand", () => {
      const input: ModelWhereInput<BlobModelFields> = { nullable: null };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts equals null", () => {
      const input: ModelWhereInput<BlobModelFields> = {
        nullable: { equals: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts not null", () => {
      const input: ModelWhereInput<BlobModelFields> = {
        nullable: { not: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("Blob Create", () => {
  describe("required field", () => {
    it("accepts Uint8Array", () => {
      const input: ModelCreateInput<BlobModelFields> = {
        required: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]),
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts empty Uint8Array", () => {
      const input: ModelCreateInput<BlobModelFields> = {
        required: new Uint8Array([]),
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects missing required", () => {
      expect(() => createSchema.assert({})).toThrow();
    });

    it("rejects regular array", () => {
      expect(() => createSchema.assert({ required: [1, 2, 3] })).toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<BlobModelFields> = {
        required: new Uint8Array([1]),
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit null", () => {
      const input: ModelCreateInput<BlobModelFields> = {
        required: new Uint8Array([1]),
        nullable: null,
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts value", () => {
      const input: ModelCreateInput<BlobModelFields> = {
        required: new Uint8Array([1]),
        nullable: new Uint8Array([2]),
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("field with default", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<BlobModelFields> = {
        required: new Uint8Array([1]),
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// UPDATE TESTS
// =============================================================================

describe("Blob Update", () => {
  describe("direct value", () => {
    it("accepts Uint8Array", () => {
      const input: ModelUpdateInput<BlobModelFields> = {
        required: new Uint8Array([9, 8, 7]),
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("set operation", () => {
    it("accepts set", () => {
      const input: ModelUpdateInput<BlobModelFields> = {
        required: { set: new Uint8Array([5, 4, 3, 2, 1]) },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelUpdateInput<BlobModelFields> = { nullable: null };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set null", () => {
      const input: ModelUpdateInput<BlobModelFields> = {
        nullable: { set: null },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<BlobModelFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});
