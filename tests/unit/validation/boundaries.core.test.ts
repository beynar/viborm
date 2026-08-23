import {
  ValidationError,
  type ValidationErrorSource,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const user = s.model({ id: s.string().id(), name: s.string() });

function registryWithExternalString(
  validate: StandardSchemaV1<string, string>["~standard"]["validate"]
) {
  const externalSchema: StandardSchemaV1<string, string> = {
    "~standard": {
      version: 1,
      vendor: "external",
      validate,
    },
  };
  const externalUser = s.model({
    id: s.string().id(),
    name: s.string().schema(externalSchema),
  });
  return createSchemaRegistry({ user: externalUser });
}

function captureValidationError(run: () => unknown): ValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected validation to fail");
}

describe("validation failure boundaries", () => {
  test("preserves the legacy operation constructor and public operation name", () => {
    const error = new ValidationError(
      "createManyAndReturn",
      [{ path: "data", message: "Invalid data" }],
      { meta: { model: "user" } }
    );

    expect(error.message).toBe(
      "Validation failed for createMany: Invalid data"
    );
    expect(error.code).toBe(VibORMErrorCode.VALIDATION_FAILED);
    expect(error.prismaCode).toBe("P2009");
    expect(error.operation).toBe("createMany");
    expect(error.source).toEqual({
      kind: "operation",
      operation: "createMany",
      model: "user",
    });
    expect(Object.isFrozen(error.source)).toBe(true);
    expect(error.toJSON().source).toEqual(error.source);
  });

  test.each<ValidationErrorSource>([
    { kind: "registry", model: "user" },
    { kind: "registry", property: "missing" },
    { kind: "schema-builder", builder: "fromObject", path: "create.data" },
    { kind: "json-schema", target: "future-draft" },
    { kind: "json-schema", schemaType: "custom" },
  ])("uses V4002 without a false Prisma equivalent for $kind", (source) => {
    const error = new ValidationError(source, [
      { path: "value", message: "Invalid value" },
    ]);

    expect(error.code).toBe(VibORMErrorCode.INVALID_INPUT);
    expect(error.prismaCode).toBeUndefined();
    expect(error.operation).toBeUndefined();
    expect(error.source).toEqual(source);
    expect(Object.isFrozen(error.source)).toBe(true);
  });

  test("retains a sanitized external cause", () => {
    const cause = new Error("external failure");
    const error = new ValidationError(
      { kind: "registry", model: "user" },
      [{ path: "", message: "Validator failed" }],
      { cause }
    );

    expect(error.originalCause).toBeInstanceOf(Error);
    expect(error.originalCause).not.toBe(cause);
    expect(error.originalCause?.message).toBe(
      "Underlying error details redacted"
    );
  });
});

describe("SchemaRegistry", () => {
  test("caches model schemas and exposes the same instance through its proxy", () => {
    const registry = createSchemaRegistry({ user });
    const first = registry.getModelSchemas(user);

    expect(registry.getModelSchemas(user)).toBe(first);
    expect(registry.proxy.user).toBe(first);
  });

  test("reports unknown proxy properties as registry validation failures", () => {
    const registry = createSchemaRegistry({ user });

    for (const property of ["missing", Symbol("missing")]) {
      const error = captureValidationError(() =>
        Reflect.get(registry.proxy, property)
      );
      expect(error.source.kind).toBe("registry");
      expect(error.code).toBe(VibORMErrorCode.INVALID_INPUT);
    }
  });

  test("reports an unknown model as an operation validation failure", () => {
    const registry = createSchemaRegistry({ user });

    const error = captureValidationError(() => {
      registry.validate("missing", "findMany", {});
    });
    expect(error.source).toEqual({
      kind: "operation",
      operation: "findMany",
      model: "missing",
    });
    expect(error.code).toBe(VibORMErrorCode.VALIDATION_FAILED);
  });

  test("returns validated values and preserves nested issue paths", () => {
    const registry = createSchemaRegistry({ user });

    expect(registry.validate("user", "findMany", {})).toEqual({});
    const error = captureValidationError(() => {
      registry.validate("user", "findMany", { take: "many" });
    });
    expect(error.issues[0]?.path).toBe("take");
    expect(error.source).toEqual({
      kind: "operation",
      operation: "findMany",
      model: "user",
    });
  });

  test("contains thrown external validator failures with their cause", () => {
    const cause = new Error("external validator exploded");
    const registry = registryWithExternalString(() => {
      throw cause;
    });

    const error = captureValidationError(() => {
      registry.validate("user", "create", {
        data: { id: "user-1", name: "Ada" },
      });
    });
    expect(error.originalCause).not.toBe(cause);
    expect(error.originalCause?.message).toBe(
      "Underlying error details redacted"
    );
    expect(error.issues).toEqual([
      {
        path: "",
        message: "The external schema validator threw unexpectedly",
      },
    ]);
    expect(error.source).toEqual({
      kind: "operation",
      operation: "create",
      model: "user",
    });
  });

  test("contains non-Error external throws without forging a cause", () => {
    const registry = registryWithExternalString(() => {
      // biome-ignore lint/style/useThrowOnlyError: external JavaScript validators may throw any value
      throw "external refusal";
    });

    const error = captureValidationError(() => {
      registry.validate("user", "create", {
        data: { id: "user-1", name: "Ada" },
      });
    });
    expect(error.originalCause).toBeUndefined();
    expect(error.issues[0]?.message).toBe(
      "The external schema validator threw unexpectedly"
    );
  });

  test("refuses asynchronous external validation", () => {
    const registry = registryWithExternalString((value) =>
      Promise.resolve({ value: String(value) })
    );

    const error = captureValidationError(() =>
      registry.validate("user", "create", {
        data: { id: "user-1", name: "Ada" },
      })
    );
    expect(error.issues).toEqual([
      { message: "Async schemas are not supported", path: "data.name" },
    ]);
  });

  test("ignores a hostile second argument and resolves the public schema", () => {
    const missing = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      missing: s.toOne(() => missing),
    });

    expect(() =>
      Reflect.apply(createSchemaRegistry, undefined, [{ owner }, new Map()])
    ).toThrow("[R006]");
  });
});
