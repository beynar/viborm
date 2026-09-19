import { ValidationError } from "@errors";
import { s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * The schema registry's OWN refusals.
 *
 * `createSchemaRegistry(...).proxy` and `.validate(...)` are the two public
 * doors into the operation schemas. Both are reached from
 * `src/client/schema-introspection.ts` (`validateOperationPayload`,
 * `renderOperationResultType`), which is measured in the `client` coverage
 * lane, so the cells that pin what each door REFUSES live here, beside the
 * schemas they refuse for.
 */

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  age: s.int(),
});

const registry = () => createSchemaRegistry({ user });

const refusal = (run: () => unknown): ValidationError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected a ValidationError");
};

describe("schema registry proxy", () => {
  test("a property that is not a registered model is refused by name", () => {
    const proxy = registry().proxy as unknown as Record<string, unknown>;

    const missing = refusal(() => proxy.ghost);
    expect(missing.issues).toEqual([
      { path: "ghost", message: "ghost does not exist" },
    ]);
    expect(missing.source).toEqual({ kind: "registry", property: "ghost" });

    // A symbol key cannot name a model either, and the refusal still says
    // which property was asked for rather than throwing a TypeError.
    const symbol = Symbol("nope");
    const symbolic = refusal(
      () => (proxy as unknown as Record<symbol, unknown>)[symbol]
    );
    expect(symbolic.issues).toEqual([
      { path: "Symbol(nope)", message: "Symbol(nope) does not exist" },
    ]);
  });

  test("a registered model resolves to its memoized schemas", () => {
    const lookup = registry();
    expect(lookup.proxy.user).toBe(lookup.proxy.user);
    expect(lookup.proxy.user.args).toBeDefined();
  });
});

describe("schema registry validate", () => {
  test("returns the normalized payload for a known operation", () => {
    expect(
      registry().validate("user", "findMany", { where: { name: "Ada" } })
    ).toMatchObject({ where: { name: { equals: "Ada" } } });
  });

  test("a model name that is not registered is refused", () => {
    const error = refusal(() => registry().validate("ghost", "findMany", {}));
    expect(error.issues).toEqual([
      { path: "ghost", message: "ghost does not exist" },
    ]);
    expect(error.source).toEqual({
      kind: "operation",
      operation: "findMany",
      model: "ghost",
    });
  });

  test("an operation the model's args do not spell is refused", () => {
    const error = refusal(() =>
      registry().validate("user", "findEvery" as unknown as "findMany", {})
    );
    expect(error.issues).toEqual([
      { path: "operation", message: "findEvery does not exist" },
    ]);
    expect(error.source).toEqual({
      kind: "registry",
      model: "user",
      property: "findEvery",
    });
  });

  test("a field issue keeps the dotted path of the key that raised it", () => {
    const error = refusal(() =>
      registry().validate("user", "findMany", { where: { name: 42 } })
    );
    expect(error.operation).toBe("findMany");
    expect(error.issues).toEqual([
      {
        path: "where.name",
        message:
          "Value did not match any union member: Expected string, Expected object",
      },
    ]);
  });

  test("a whole-object refusal carries the empty path", () => {
    // A whole-object refusal states no key, so it carries no path; the
    // registry must not invent one.
    const error = refusal(() =>
      registry().validate("user", "groupBy", { by: ["name", "name"] })
    );
    expect(error.issues).toEqual([
      {
        path: "",
        message: "GroupBy operation does not allow duplicate fields in 'by'",
      },
    ]);
  });

  test("an Error thrown by the validator is contained and kept as the cause", () => {
    const thrown = new Error("accessor exploded");
    const payload = Object.defineProperty({}, "where", {
      enumerable: true,
      get: () => {
        throw thrown;
      },
    });

    const error = refusal(() =>
      registry().validate("user", "findMany", payload)
    );
    expect(error.issues).toEqual([
      { path: "", message: "The external schema validator threw unexpectedly" },
    ]);
    // The retained cause is a SANITIZED copy, never the schema's own object.
    expect(error.originalCause).toBeInstanceOf(Error);
    expect(error.originalCause).not.toBe(thrown);
  });

  test("a non-Error thrown by the validator is contained without a cause", () => {
    const payload = Object.defineProperty({}, "where", {
      enumerable: true,
      get: () => {
        // biome-ignore lint/style/useThrowOnlyError: a non-Error throw is the point
        throw "a string, not an Error";
      },
    });

    const error = refusal(() =>
      registry().validate("user", "findMany", payload)
    );
    expect(error.issues).toEqual([
      { path: "", message: "The external schema validator threw unexpectedly" },
    ]);
    // Nothing guarantees a `throw` carries an Error, and a non-Error is not
    // one: the refusal stands on its own rather than wrapping a value the
    // diagnostics layer cannot sanitize.
    expect(error.originalCause).toBeUndefined();
  });
});
