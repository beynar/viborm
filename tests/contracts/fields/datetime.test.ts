/**
 * DateTime Field Contract Tests
 *
 * Validates type/runtime parity for datetime fields.
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
import { datetimeModel, type DatetimeModelFields } from "../models.js";

const whereSchema = buildWhereSchema(datetimeModel);
const createSchema = buildCreateSchema(datetimeModel);
const updateSchema = buildUpdateSchema(datetimeModel);

// =============================================================================
// FILTER TESTS
// =============================================================================

describe("DateTime Filter", () => {
  const now = new Date();
  const isoString = "2024-01-15T10:30:00.000Z";

  describe("equals", () => {
    it("accepts Date object shorthand", () => {
      const input: ModelWhereInput<DatetimeModelFields> = { required: now };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts ISO string shorthand", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: isoString,
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit equals with Date", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { equals: now },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit equals with string", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { equals: isoString },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("not", () => {
    it("accepts not Date", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { not: now },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts not string", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { not: isoString },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("in/notIn", () => {
    it("accepts in array of Dates", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { in: [now, new Date()] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts in array of strings", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { in: [isoString, "2024-12-31T23:59:59.999Z"] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts notIn", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { notIn: [isoString] },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("comparison operators", () => {
    it("accepts lt", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { lt: now },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts lte", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { lte: now },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts gt", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { gt: isoString },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts gte", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { gte: isoString },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts combined range", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        required: { gte: "2024-01-01T00:00:00Z", lt: "2025-01-01T00:00:00Z" },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelWhereInput<DatetimeModelFields> = { nullable: null };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });

    it("accepts equals null", () => {
      const input: ModelWhereInput<DatetimeModelFields> = {
        nullable: { equals: null },
      };
      expect(() => whereSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// CREATE TESTS
// =============================================================================

describe("DateTime Create", () => {
  describe("required field", () => {
    it("accepts Date object", () => {
      const input: ModelCreateInput<DatetimeModelFields> = {
        required: new Date(),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts ISO string", () => {
      const input: ModelCreateInput<DatetimeModelFields> = {
        required: "2024-01-15T10:30:00Z",
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("rejects missing required", () => {
      expect(() => createSchema.assert({ array: [] })).toThrow();
    });

    it("rejects invalid string", () => {
      expect(() =>
        createSchema.assert({ required: "not-a-date", array: [] })
      ).toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<DatetimeModelFields> = {
        required: new Date(),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit null", () => {
      const input: ModelCreateInput<DatetimeModelFields> = {
        required: new Date(),
        nullable: null,
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("field with default (now)", () => {
    it("accepts omitted", () => {
      const input: ModelCreateInput<DatetimeModelFields> = {
        required: new Date(),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts explicit value", () => {
      const input: ModelCreateInput<DatetimeModelFields> = {
        required: new Date(),
        withDefault: new Date("2024-06-15"),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts array of Dates", () => {
      const input: ModelCreateInput<DatetimeModelFields> = {
        required: new Date(),
        array: [new Date(), new Date()],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts array of strings", () => {
      const input: ModelCreateInput<DatetimeModelFields> = {
        required: new Date(),
        array: ["2024-01-01T00:00:00Z", "2024-12-31T23:59:59Z"],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });

    it("accepts empty array", () => {
      const input: ModelCreateInput<DatetimeModelFields> = {
        required: new Date(),
        array: [],
      };
      expect(() => createSchema.assert(input)).not.toThrow();
    });
  });
});

// =============================================================================
// UPDATE TESTS
// =============================================================================

describe("DateTime Update", () => {
  describe("direct value", () => {
    it("accepts Date", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = {
        required: new Date(),
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts ISO string", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = {
        required: "2024-06-15T12:00:00Z",
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("set operation", () => {
    it("accepts set with Date", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = {
        required: { set: new Date() },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set with string", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = {
        required: { set: "2024-06-15T12:00:00Z" },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("nullable field", () => {
    it("accepts null", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = { nullable: null };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts set null", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = {
        nullable: { set: null },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("array field", () => {
    it("accepts set array", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = {
        array: { set: [new Date()] },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts push Date", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = {
        array: { push: new Date() },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });

    it("accepts push string", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = {
        array: { push: "2024-01-01T00:00:00Z" },
      };
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });

  describe("empty update", () => {
    it("accepts empty object", () => {
      const input: ModelUpdateInput<DatetimeModelFields> = {};
      expect(() => updateSchema.assert(input)).not.toThrow();
    });
  });
});

