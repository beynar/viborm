import { describe, test, expect } from "vitest";
import {
  QueryValidator,
  ValidationError,
} from "../../src/adapters/databases/query-validator";
import { s } from "../../src/schema";

describe("QueryValidator", () => {
  const testModel = s.model("user", {
    id: s.string().id(),
    name: s.string(),
    email: s.string(),
  });

  describe("validateOperation", () => {
    test("should accept valid operations", () => {
      expect(() => QueryValidator.validateOperation("findMany")).not.toThrow();
      expect(() => QueryValidator.validateOperation("create")).not.toThrow();
      expect(() => QueryValidator.validateOperation("update")).not.toThrow();
    });

    test("should reject invalid operations", () => {
      expect(() =>
        QueryValidator.validateOperation("invalidOp" as any)
      ).toThrow(ValidationError);
    });
  });

  describe("validateModel", () => {
    test("should accept valid models", () => {
      expect(() => QueryValidator.validateModel(testModel)).not.toThrow();
    });

    test("should reject null/undefined models", () => {
      expect(() => QueryValidator.validateModel(null as any)).toThrow(
        ValidationError
      );
      expect(() => QueryValidator.validateModel(undefined as any)).toThrow(
        ValidationError
      );
    });
  });

  describe("validateField", () => {
    test("should accept existing fields", () => {
      expect(() =>
        QueryValidator.validateField(testModel, "name")
      ).not.toThrow();
      expect(() =>
        QueryValidator.validateField(testModel, "email")
      ).not.toThrow();
    });

    test("should reject non-existing fields", () => {
      expect(() =>
        QueryValidator.validateField(testModel, "nonExistent")
      ).toThrow(ValidationError);
    });
  });

  describe("validatePayload", () => {
    test("should accept valid payloads", () => {
      expect(() =>
        QueryValidator.validatePayload("findMany", { where: { name: "test" } })
      ).not.toThrow();
      expect(() =>
        QueryValidator.validatePayload("create", { data: { name: "test" } })
      ).not.toThrow();
    });

    test("should reject invalid payloads", () => {
      expect(() => QueryValidator.validatePayload("create", {})).toThrow(
        ValidationError
      );
      expect(() => QueryValidator.validatePayload("findUnique", {})).toThrow(
        ValidationError
      );
    });
  });
});
