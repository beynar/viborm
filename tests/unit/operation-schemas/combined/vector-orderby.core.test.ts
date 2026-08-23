import { s } from "@schema";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

const vectorOrderModels = (() => {
  const collection = s.model({
    id: s.string().id(),
    centroid: s.vector().dimension(3),
    docs: s.toMany(() => doc),
  });

  const doc = s.model({
    id: s.string().id(),
    title: s.string(),
    collectionId: s.string(),
    collection: s
      .toOne(() => collection)
      .fields("collectionId")
      .references("id"),
    embedding: s.vector().dimension(3),
  });

  return { collection, doc };
})();

const vectorOrderRegistry = createSchemaRegistry(vectorOrderModels);
const vectorOrderSchemas = vectorOrderRegistry.proxy.doc;
const vectorCollectionSchemas = vectorOrderRegistry.proxy.collection;

describe("Vector OrderBy Schema", () => {
  type Input = InferInput<typeof vectorOrderSchemas.core.orderBy>;

  test("type: accepts _distance order on vector scalar fields", () => {
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

  test("type: accepts desc sort inside _distance order", () => {
    const input = {
      embedding: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "l2",
          sort: "desc",
        },
      },
    } satisfies Input;

    expectTypeOf(input).toMatchTypeOf<Input>();
  });

  test("type: rejects sibling sort next to _distance order", () => {
    const input: Input = {
      embedding: {
        // @ts-expect-error distance sort belongs inside _distance
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "l2",
        },
        sort: "desc",
      },
    };

    expect(input).toBeDefined();
  });

  test("type: keeps plain sort order available on vector scalar fields", () => {
    const input = {
      embedding: "asc",
    } satisfies Input;

    expectTypeOf(input).toMatchTypeOf<Input>();
  });

  test("type: rejects _distance order on non-vector scalar fields", () => {
    const input: Input = {
      title: {
        // @ts-expect-error _distance is only available on vector scalar fields
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "l2",
        },
      },
    };

    expect(input).toBeDefined();
  });

  test("type: accepts _distance order on to-one relation vector scalar fields", () => {
    const input = {
      collection: {
        centroid: {
          _distance: {
            to: [0.1, 0.2, 0.3],
            metric: "l2",
          },
        },
      },
    } satisfies Input;

    expectTypeOf(input).toMatchTypeOf<Input>();
  });

  test("runtime: accepts _distance order on vector scalar fields", () => {
    const result = parse(vectorOrderSchemas.core.orderBy, {
      embedding: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "l2",
        },
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts desc sort inside _distance order", () => {
    const result = parse(vectorOrderSchemas.core.orderBy, {
      embedding: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "l2",
          sort: "desc",
        },
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects sibling sort next to _distance order", () => {
    const result = parse(vectorOrderSchemas.core.orderBy, {
      embedding: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "l2",
        },
        sort: "desc",
      },
    });

    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects _distance order on non-vector scalar fields", () => {
    const result = parse(vectorOrderSchemas.core.orderBy, {
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
    const result = parse(vectorOrderSchemas.core.orderBy, {
      embedding: {
        _distance: {
          to: [0.1, 0.2, 0.3],
          metric: "innerProduct",
        },
      },
    });

    expect(result.issues).toBeDefined();
  });

  test("runtime: accepts _distance order on to-one relation vector scalar fields", () => {
    const result = parse(vectorOrderSchemas.core.orderBy, {
      collection: {
        centroid: {
          _distance: {
            to: [0.1, 0.2, 0.3],
            metric: "cosine",
          },
        },
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested include with vector distance order and take", () => {
    const result = parse(vectorCollectionSchemas.core.include, {
      docs: {
        orderBy: {
          embedding: {
            _distance: {
              to: [0.1, 0.2, 0.3],
              metric: "l2",
            },
          },
        },
        take: 2,
      },
    });

    expect(result.issues).toBeUndefined();
  });
});
