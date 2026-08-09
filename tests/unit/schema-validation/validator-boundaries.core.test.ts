import {
  isSchemaValidationError,
  SchemaValidationError,
  SchemaValidator,
  type ValidationRule,
  validateSchema,
  validateSchemaOrThrow,
} from "@src/index";
import { s } from "@src/schema";
import { validatePolymorphicSchemaOrThrow } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

describe("SchemaValidator boundaries", () => {
  it("skips the polymorphic-only definition gate for an ordinary schema", () => {
    const user = s.model({ id: s.string().id() });

    expect(() => validatePolymorphicSchemaOrThrow({ user })).not.toThrow();
  });

  it("registers one model through the fluent API", () => {
    const user = s.model({ id: s.string().id() });
    const validator = new SchemaValidator();

    expect(validator.register("user", user)).toBe(validator);
    expect(validator.validate()).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
  });

  it("rejects a duplicate registration before Map replacement erases it", () => {
    const first = s.model({ id: s.string().id() });
    const second = s.model({ id: s.string().id() });
    const validator = new SchemaValidator().register("user", first);

    expect(() => validator.register("user", second)).toThrowError(
      expect.objectContaining({
        code: "V4002",
        issues: [expect.objectContaining({ code: "M003", model: "user" })],
      })
    );
  });

  it("runs caller-supplied rules with the precomputed context", () => {
    const user = s.model({ id: s.string().id() });
    const contextRule: ValidationRule = (_schema, name, model, context) => {
      expect(context.modelToName.get(model)).toBe(name);
      expect(context.tableToModels.get(name)).toEqual([name]);
      return [
        {
          code: "CUSTOM",
          message: "custom warning",
          severity: "warning",
          model: name,
        },
      ];
    };

    expect(validateSchema({ user }, [contextRule])).toEqual({
      valid: true,
      errors: [],
      warnings: [
        {
          code: "CUSTOM",
          message: "custom warning",
          severity: "warning",
          model: "user",
        },
      ],
    });
  });

  it("wraps an Error thrown by a named external rule", () => {
    const user = s.model({ id: s.string().id() });
    const cause = new Error("external rule exploded");
    const namedFailure: ValidationRule = () => {
      throw cause;
    };

    expect(() => validateSchema({ user }, [namedFailure])).toThrowError(
      expect.objectContaining({
        code: "V4002",
        originalCause: expect.objectContaining({
          message: "Underlying error details redacted",
        }),
        issues: [
          expect.objectContaining({
            code: "S001",
            message: expect.stringContaining("namedFailure"),
          }),
        ],
      })
    );
  });

  it("wraps a non-Error thrown by an anonymous external rule", () => {
    const user = s.model({ id: s.string().id() });

    expect(() =>
      validateSchema({ user }, [
        () => {
          throw "external string failure";
        },
      ])
    ).toThrowError(
      expect.objectContaining({
        code: "V4002",
        issues: [
          expect.objectContaining({
            code: "S001",
            message: expect.stringContaining("external string failure"),
          }),
        ],
      })
    );
  });

  it("throws an immutable typed error for invalid schema definitions", () => {
    const user = s.model({ email: s.string() });

    try {
      validateSchemaOrThrow({ user });
      expect.unreachable("invalid schema must throw");
    } catch (error) {
      expect(isSchemaValidationError(error)).toBe(true);
      expect(error).toBeInstanceOf(SchemaValidationError);
      if (!isSchemaValidationError(error)) return;
      expect(error.code).toBe("V4002");
      expect(error.prismaCode).toBeUndefined();
      expect(Object.isFrozen(error.issues)).toBe(true);
      expect(Object.isFrozen(error.issues[0])).toBe(true);
      expect(error.toJSON()).toEqual(
        expect.objectContaining({
          name: "SchemaValidationError",
          code: "V4002",
          issues: error.issues,
        })
      );
    }

    expect(isSchemaValidationError(new Error("other"))).toBe(false);
  });
});
