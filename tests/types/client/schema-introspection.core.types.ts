import type {
  OperationResult,
  ValidatedOperationPayload,
} from "@client/exports";
import { s } from "@schema";
import {
  renderOperationResultType,
  renderSchemaType,
  validateOperationPayload,
} from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const user = s.model({ id: s.string().id(), name: s.string() });
const schema = { user };

describe("schema introspection public types", () => {
  test("returns normalized operation output types", () => {
    const payload: unknown = { where: { id: "user-1" } };
    const validated = validateOperationPayload(
      schema,
      "user",
      "findUniqueOrThrow",
      payload
    );

    expectTypeOf(validated).toEqualTypeOf<
      ValidatedOperationPayload<"findUniqueOrThrow", typeof user>
    >();
    expectTypeOf(
      renderOperationResultType(schema, "user", "findMany", {})
    ).toEqualTypeOf<string>();
    expectTypeOf(renderSchemaType(schema)).toEqualTypeOf<string>();

    const validatedExist = validateOperationPayload(
      schema,
      "user",
      "exist",
      {}
    );
    expectTypeOf(validatedExist).not.toHaveProperty("select");

    expectTypeOf<
      OperationResult<"count", typeof user, { select: Record<never, never> }>
    >().toEqualTypeOf<number>();
  });

  test("keeps model and operation names exact", () => {
    const _unknownModel = () =>
      validateOperationPayload(
        schema,
        // @ts-expect-error - "missing" is not a model in this schema
        "missing",
        "findMany",
        {}
      );
    const _unknownOperation = () =>
      validateOperationPayload(
        schema,
        "user",
        // @ts-expect-error - "findEverything" is not a public operation
        "findEverything",
        {}
      );
  });
});
