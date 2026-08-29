import {
  renderOperationResultType,
  renderSchemaType,
  validateOperationPayload,
} from "@client/schema-introspection";
import { ValidationError, VibORMErrorCode } from "@errors";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string().nullable(),
  balance: s.decimal({ precision: 12, scale: 2 }),
  metadata: s.json(),
  status: s.enum(["active", "paused"]),
  score: s.int(),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

const schema = { user, post };

const article = s.model({ id: s.string().id(), title: s.string() });
const clip = s.model({ id: s.string().id(), duration: s.int() });
const library = s.model({
  id: s.string().id(),
  items: s.toMany(
    { article: () => article, clip: () => clip },
    { values: { article: "library.article.v1", clip: "library.clip.v1" } }
  ),
});
const variantSchema = { article, clip, library };

function captureValidationError(run: () => unknown): ValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected validation to fail");
}

describe("schema operation introspection", () => {
  test("validates public operation spellings and returns normalized payloads", () => {
    expect(
      validateOperationPayload(schema, "user", "findMany", undefined)
    ).toEqual({});
    expect(
      validateOperationPayload(schema, "user", "findMany", {
        omit: { metadata: true },
      })
    ).toEqual({
      select: {
        id: true,
        name: true,
        balance: true,
        status: true,
        score: true,
      },
    });
    expect(
      validateOperationPayload(schema, "user", "findUniqueOrThrow", {
        where: { id: "user-1" },
      })
    ).toEqual({ where: { id: "user-1" } });
    expect(validateOperationPayload(schema, "user", "exist", {})).toEqual({});

    const invalidExist = captureValidationError(() =>
      validateOperationPayload(schema, "user", "exist", {
        select: { _all: true },
      })
    );
    expect(invalidExist.source).toEqual({
      kind: "operation",
      operation: "exist",
      model: "user",
    });
    expect(invalidExist.issues[0]?.path).toBe("select");
  });

  test("contains unknown model and operation names at the public boundary", () => {
    const unknownModel = captureValidationError(() =>
      Reflect.apply(validateOperationPayload, undefined, [
        schema,
        "toString",
        "findMany",
        {},
      ])
    );
    expect(unknownModel.code).toBe(VibORMErrorCode.VALIDATION_FAILED);

    const unknownOperation = captureValidationError(() =>
      Reflect.apply(validateOperationPayload, undefined, [
        schema,
        "user",
        "findEverything",
        {},
      ])
    );
    expect(unknownOperation.source).toEqual({
      kind: "registry",
      model: "user",
      property: "findEverything",
    });

    const symbolModel = captureValidationError(() =>
      Reflect.apply(validateOperationPayload, undefined, [
        schema,
        Symbol("model"),
        "findMany",
        {},
      ])
    );
    expect(symbolModel.issues[0]?.path).toBe("model");

    const symbolOperation = captureValidationError(() =>
      Reflect.apply(renderOperationResultType, undefined, [
        schema,
        "user",
        Symbol("operation"),
        {},
      ])
    );
    expect(symbolOperation.issues[0]?.path).toBe("operation");

    const uncoercibleModel = captureValidationError(() =>
      Reflect.apply(validateOperationPayload, undefined, [
        schema,
        Object.create(null),
        "findMany",
        {},
      ])
    );
    expect(uncoercibleModel.issues[0]?.path).toBe("model");
  });

  test("renders the complete recursive schema graph", () => {
    expect(renderSchemaType(schema)).toBe(`type VibORMSchema = {
  user: {
    id: string;
    name: string | null;
    balance: import("viborm").Decimal;
    metadata: unknown;
    status: "active" | "paused";
    score: number;
    posts: Array<VibORMSchema["post"]>;
  };
  post: {
    id: string;
    title: string;
    authorId: string;
    author: VibORMSchema["user"];
  };
};`);
  });

  test("renders the point scalar output shape", () => {
    const waypoint = s.model({ location: s.point() });

    expect(renderSchemaType({ waypoint })).toBe(`type VibORMSchema = {
  waypoint: {
    location: {
      x: number;
      y: number;
    };
  };
};`);
  });

  test("renders selected rows and operation-level nullability", () => {
    expect(
      renderOperationResultType(schema, "user", "findMany", {
        select: {
          id: true,
          posts: { select: { title: true } },
        },
      })
    ).toBe(`Array<{
  id: string;
  posts: Array<{
    title: string;
  }>;
}>`);

    expect(
      renderOperationResultType(schema, "post", "findUnique", {
        where: { id: "post-1" },
        select: { author: { select: { id: true } } },
      })
    ).toBe(`{
  author: {
    id: string;
  };
} | null`);

    expect(
      renderOperationResultType(schema, "post", "findUniqueOrThrow", {
        where: { id: "post-1" },
        select: { id: true },
      })
    ).toBe(`{
  id: string;
}`);
  });

  test("renders count, aggregate, group-by, existence, and bulk result carriers", () => {
    expect(
      renderOperationResultType(schema, "user", "count", {
        select: { _all: true, name: true },
      })
    ).toBe(`{
  _all: number;
  name: number;
}`);
    expect(
      renderOperationResultType(schema, "user", "count", { select: {} })
    ).toBe("number");

    expect(
      renderOperationResultType(schema, "user", "aggregate", {
        _avg: { score: true },
        _sum: { balance: true },
      })
    ).toBe(`{
  _avg: {
    score: number | null;
  };
  _sum: {
    balance: import("viborm").Decimal | null;
  };
}`);

    expect(
      renderOperationResultType(schema, "user", "groupBy", {
        by: ["status"],
        _count: true,
      })
    ).toBe(`Array<{
  status: "active" | "paused";
  _count: number;
}>`);

    expect(renderOperationResultType(schema, "user", "exist", {})).toBe(
      "boolean"
    );
    expect(renderOperationResultType(schema, "user", "deleteMany", {})).toBe(`{
  count: number;
}`);
    expect(
      renderOperationResultType(schema, "user", "deleteMany", {
        select: { id: true },
      })
    ).toBe(`Array<{
  id: string;
}>`);
  });

  test("renders relation counts from the resolved result shape", () => {
    expect(
      renderOperationResultType(schema, "user", "findFirst", {
        select: { _count: { select: { posts: true } } },
      })
    ).toBe(`{
  _count: {
    posts: number;
  };
} | null`);
  });

  test("renders visible variant-relation arms", () => {
    expect(
      renderOperationResultType(variantSchema, "library", "findMany", {
        select: {
          items: {
            only: ["article"],
            variants: { article: { select: { title: true } } },
          },
        },
      })
    ).toBe(`Array<{
  items: ReadonlyArray<{
    readonly type: "article";
    readonly data: {
      title: string;
    };
  }>;
}>`);
  });
});
