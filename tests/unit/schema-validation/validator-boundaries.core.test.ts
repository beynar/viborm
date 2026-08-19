import {
  isSchemaValidationError,
  SchemaValidationError,
  SchemaValidator,
  type ValidationRule,
  validateSchema,
  validateSchemaOrThrow,
} from "@src/index";
import { s } from "@src/schema";
import { PolymorphicToOneRelation } from "@src/schema/relation";
import {
  validateClientSchemaOrThrow,
  validatePolymorphicSchemaOrThrow,
} from "@src/schema/validation/validator";
import { describe, expect, it } from "vitest";

describe("SchemaValidator boundaries", () => {
  it("skips the polymorphic-only definition gate for an ordinary schema", () => {
    const user = s.model({ id: s.string().id() });

    expect(() => validatePolymorphicSchemaOrThrow({ user })).not.toThrow();
  });

  it("runs the complete definition gate for a polymorphic schema", () => {
    const target = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      target: new PolymorphicToOneRelation({
        type: "polymorphic",
        cardinality: "one",
        targets: { target: () => target },
        values: {},
      }),
    });

    expect(() =>
      validatePolymorphicSchemaOrThrow({ target, owner })
    ).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "P003" })],
      })
    );
  });

  it("refuses a carrier that carries no cardinality", () => {
    const target = s.model({ id: s.string().id() });
    // Laundered through a bare construct signature on purpose: the two public
    // factories each stamp their own cardinality, so this carrier has no
    // spelling — only a hostile caller reaching the terminal's constructor with
    // a state that omits `cardinality` produces it. This test asks what the
    // RUNTIME gate does once such a caller gets past the typed surface.
    const ForgedCarrier: new (...args: never) => unknown =
      PolymorphicToOneRelation;
    const owner = s.model({
      id: s.string().id(),
      target: Reflect.construct(ForgedCarrier, [
        {
          type: "polymorphic",
          targets: { target: () => target },
          values: { target: "target" },
        },
      ]),
    });

    expect(() =>
      validatePolymorphicSchemaOrThrow({ target, owner })
    ).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "P013" })],
      })
    );
  });

  it("runs only the inverse optionality contract for ordinary clients", () => {
    const child = s.model({ id: s.string().id() });
    const missingInverse = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => child),
    });

    expect(() =>
      validateClientSchemaOrThrow({ missingInverse, child })
    ).not.toThrow();
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
