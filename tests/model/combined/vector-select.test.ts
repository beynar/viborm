import type { OperationResult } from "@client/types";
import { s } from "@schema";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

const vectorSelectModels = (() => {
  const doc = s.model({
    id: s.string().id(),
    title: s.string(),
    embedding: s.vector().dimension(3),
  });

  return { doc };
})();

const vectorSelectRegistry = createSchemaRegistry(vectorSelectModels);
const vectorSelectSchemas = vectorSelectRegistry.proxy.doc;

describe("Vector Select Schema", () => {
  type Input = InferInput<typeof vectorSelectSchemas.core.select>;

  test("type: accepts _distance select on vector scalar fields", () => {
    const input = {
      embedding: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "cosine",
        },
      },
    } satisfies Input;

    expectTypeOf(input).toMatchTypeOf<Input>();
  });

  test("type: keeps boolean select available on vector scalar fields", () => {
    const input = {
      embedding: true,
    } satisfies Input;

    expectTypeOf(input).toMatchTypeOf<Input>();
  });

  test("type: rejects _distance select on non-vector scalar fields", () => {
    const input: Input = {
      // @ts-expect-error _distance is only available on vector scalar fields
      title: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "l2",
        },
      },
    };

    expect(input).toBeDefined();
  });

  test("type: exposes selected vector distance as _distance number", () => {
    type Args = {
      select: {
        id: true;
        embedding: {
          _distance: {
            to: [0.1, 0.2, 0.3];
            metric: "cosine";
          };
        };
      };
    };

    type Result = OperationResult<
      "findMany",
      typeof vectorSelectModels.doc,
      Args
    >[number];

    expectTypeOf<Result>().toHaveProperty("id");
    expectTypeOf<Result>().toHaveProperty("_distance");
    expectTypeOf<Result["_distance"]>().toEqualTypeOf<number>();
    expectTypeOf<keyof Result>().toEqualTypeOf<"id" | "_distance">();
  });

  test("runtime: accepts _distance select on vector scalar fields", () => {
    const result = parse(vectorSelectSchemas.core.select, {
      embedding: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "l2",
        },
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects _distance select on non-vector scalar fields", () => {
    const result = parse(vectorSelectSchemas.core.select, {
      title: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "l2",
        },
      },
    });

    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects invalid vector distance metric", () => {
    const result = parse(vectorSelectSchemas.core.select, {
      embedding: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "innerProduct",
        },
      },
    });

    expect(result.issues).toBeDefined();
  });
});
