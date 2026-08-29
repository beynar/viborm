import {
  isSchemaValidationError,
  SchemaValidationError,
  validateSchemaOrThrow,
} from "@src/index";
import { s } from "@src/schema";
import { thrownAsError } from "@src/schema/validation/error";
import type { ValidationRule } from "@src/schema/validation/types";
import {
  resolveSchemaOrThrow,
  SchemaValidator,
} from "@src/schema/validation/validator";
import { describe, expect, it } from "vitest";

/**
 * The SchemaValidator's own surface: what it registers, what it resolves, and
 * how it reports.
 *
 * The polymorphic CLIFF this file used to open with — a second entry point that
 * ran the complete rule set only when some model happened to declare a variant
 * carrier — is gone (plan §7.3). Its timing witnesses live in
 * `inverse-resolution-timing.core.test.ts`; what stays here is the validator's
 * contract with its callers.
 */
describe("SchemaValidator boundaries", () => {
  it("resolves once per validator lifecycle and hands back the same arm", () => {
    const user = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const validator = new SchemaValidator().registerAll({ user, post });

    const first = validator.resolve();
    const second = validator.resolve();

    expect(first.ok).toBe(true);
    // Strict identity: a second call is not a second resolution.
    expect(second).toBe(first);
    if (!first.ok) return;
    expect([...first.index.keys()]).toEqual([user, post]);
  });

  it("invalidates a successful resolution after a successful registration", () => {
    const stable = s.model({ id: s.string().id() });
    const missing = s.model({ id: s.string().id() });
    const orphan = s.model({
      id: s.string().id(),
      missing: s.toOne(() => missing),
    });
    const validator = new SchemaValidator().register("stable", stable);
    const before = validator.resolve();
    expect(before.ok).toBe(true);

    validator.register("orphan", orphan);
    const after = validator.resolve();

    expect(after).not.toBe(before);
    expect(after.ok).toBe(false);
    expect(after.issues.map((issue) => issue.code)).toEqual(["R006"]);
  });

  it("leaves the cached resolution untouched after a failed registration", () => {
    const first = s.model({ id: s.string().id() });
    const duplicate = s.model({ id: s.string().id() });
    const validator = new SchemaValidator().register("user", first);
    const resolution = validator.resolve();

    expect(() => validator.register("user", duplicate)).toThrow("[M003]");
    expect(validator.resolve()).toBe(resolution);
  });

  it("treats the same model under the same key as idempotent", () => {
    const user = s.model({ id: s.string().id() });
    const validator = new SchemaValidator().register("user", user);
    validator.resolve();

    expect(validator.register("user", user)).toBe(validator);
    expect(validator.resolve().ok).toBe(true);
  });

  it("publishes NO index for an unresolvable graph", () => {
    const orphan = s.model({
      id: s.string().id(),
      ghosts: s.toMany(() => tag),
    });
    const tag = s.model({ id: s.string().id() });
    const resolution = new SchemaValidator()
      .registerAll({ orphan, tag })
      .resolve();

    expect(resolution.ok).toBe(false);
    // The failure arm has issues and no index at all — there is no partial arm
    // and no `unresolved` edge form to inspect.
    expect(resolution).not.toHaveProperty("index");
    if (resolution.ok) return;
    expect(resolution.issues.map((issue) => issue.code)).toEqual(["R002"]);
  });

  it("stops at the FIRST thrown target getter and carries that exact Error", () => {
    const boom = new Error("target module not loaded");
    let secondGetterCalls = 0;
    const later = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      first: s.toOne(() => {
        throw boom;
      }),
      second: s.toOne(() => {
        secondGetterCalls += 1;
        return later;
      }),
    });

    const resolution = new SchemaValidator()
      .registerAll({ owner, later })
      .resolve();

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    // Identity, not equality: the terminal's settled Error is what the failure
    // arm carries, so two schema contexts observe the same object.
    expect(resolution.cause).toBe(boom);
    expect(resolution.issues.map((issue) => issue.code)).toEqual(["R006"]);
    expect(secondGetterCalls).toBe(0);
  });

  it("normalizes a non-Error throw once, at the terminal", () => {
    const owner = s.model({
      id: s.string().id(),
      first: s.toOne(() => {
        // biome-ignore lint/style/useThrowOnlyError: the hostile input under test
        throw "not an error";
      }),
    });

    const resolution = new SchemaValidator().registerAll({ owner }).resolve();

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.cause).toBeInstanceOf(Error);
    expect(resolution.cause?.message).toContain("not an error");
  });

  it("exposes the getter failure through the sanitized public cause", () => {
    const boom = new Error("target module not loaded");
    const owner = s.model({
      id: s.string().id(),
      broken: s.toOne(() => {
        throw boom;
      }),
    });

    try {
      validateSchemaOrThrow({ owner });
      expect.unreachable("a thrown target getter must refuse the schema");
    } catch (error) {
      expect(isSchemaValidationError(error)).toBe(true);
      if (!isSchemaValidationError(error)) return;
      expect(error.issues.map((issue) => issue.code)).toEqual(["R006"]);
      expect(error.originalCause).toBeInstanceOf(Error);
    }
  });

  it("preserves getter causes through both throwing publication paths", () => {
    for (const publish of [validateSchemaOrThrow, resolveSchemaOrThrow]) {
      const owner = s.model({
        id: s.string().id(),
        broken: s.toOne(() => {
          throw new Error("unavailable target module");
        }),
      });

      try {
        publish({ owner });
        expect.unreachable("a thrown getter must refuse publication");
      } catch (error) {
        expect(isSchemaValidationError(error)).toBe(true);
        if (!isSchemaValidationError(error)) continue;
        expect(error.issues.map((issue) => issue.code)).toEqual(["R006"]);
        expect(error.originalCause).toBeInstanceOf(Error);
      }
    }
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

    expect(
      new SchemaValidator().registerAll({ user }).validate([contextRule])
    ).toEqual({
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

    expect(() =>
      new SchemaValidator().registerAll({ user }).validate([namedFailure])
    ).toThrowError(
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
      new SchemaValidator().registerAll({ user }).validate([
        () => {
          // biome-ignore lint/style/useThrowOnlyError: this boundary must normalize hostile non-Error throws
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

  it("reads a thrown value as one Error, whatever the thrower handed over", () => {
    // The gate's one owner for a `catch` boundary. Every in-repo thrower it
    // catches throws an `Error`, so it CARRIES that object — identity and all,
    // which is what lets a refusal chain to the original cause. Hostile or
    // future callers may throw anything, and the rendering is owned here rather
    // than re-decided at each catch.
    const original = new Error("target module missing");
    expect(thrownAsError(original)).toBe(original);

    const nonError: unknown = "plain refusal";
    const rendered = thrownAsError(nonError);
    expect(rendered).toBeInstanceOf(Error);
    expect(rendered.message).toBe("plain refusal");
  });
});
