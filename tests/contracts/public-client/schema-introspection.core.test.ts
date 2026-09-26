import {
  getOperationPayloadSchema,
  renderOperationResultType,
  renderSchemaType,
  validateOperationPayload,
} from "@client/schema-introspection";
import { ValidationError, VibORMErrorCode } from "@errors";
import { s } from "@schema";
import {
  polymorphicRelationSchema,
  unnamedArmSelections,
} from "@tests/contracts/drivers/behaviors/polymorphic-relation-schema";
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
  test("exposes operation payload schemas and resolves public aliases", () => {
    const findMany = getOperationPayloadSchema(schema, "user", "findMany");
    const validated = findMany["~standard"].validate({ take: 2 });
    expect(validated).toEqual({ value: { take: 2 } });

    const inputSchema = findMany["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    expect(inputSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    });
    expect(inputSchema.properties).toHaveProperty("where");

    const findUnique = getOperationPayloadSchema(schema, "user", "findUnique");
    const findUniqueOrThrow = getOperationPayloadSchema(
      schema,
      "user",
      "findUniqueOrThrow"
    );
    expect(
      findUniqueOrThrow["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      })
    ).toEqual(
      findUnique["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      })
    );

    const findFirst = getOperationPayloadSchema(schema, "user", "findFirst");
    const findFirstOrThrow = getOperationPayloadSchema(
      schema,
      "user",
      "findFirstOrThrow"
    );
    expect(
      findFirstOrThrow["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      })
    ).toEqual(
      findFirst["~standard"].jsonSchema.input({
        target: "draft-2020-12",
      })
    );
  });

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
    const unknownSchemaModel = captureValidationError(() =>
      Reflect.apply(getOperationPayloadSchema, undefined, [
        schema,
        "toString",
        "findMany",
      ])
    );
    expect(unknownSchemaModel.code).toBe(VibORMErrorCode.INVALID_INPUT);
    expect(unknownSchemaModel.source).toEqual({
      kind: "registry",
      property: "toString",
    });

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
      longitude: number;
      latitude: number;
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

  test("renders an arm a singular selection leaves unnamed at its default projection", () => {
    // The renderer's half of one contract the runtime shares, on a schema of
    // its own; the next cell renders the behavior suite's own schema and
    // selections. tests/types/client/polymorphic-result.core.types.ts pins
    // this shape of selection's inferred type.
    const note = s.model({
      id: s.string().id(),
      subject: s.toOne({ article: () => article, clip: () => clip }),
    });
    const draft = s.model({
      id: s.string().id(),
      subject: s.toOne({ article: () => article, clip: () => clip }).optional(),
    });
    const slots = { article, clip, note, draft };
    const selection = {
      select: { id: true, subject: { article: { select: { title: true } } } },
    };
    const union = `{
    readonly type: "article";
    readonly data: {
      title: string;
    };
  } | {
    readonly type: "clip";
    readonly data: {
      id: string;
      duration: number;
    };
  }`;
    expect(
      renderOperationResultType(slots, "note", "findMany", selection)
    ).toBe(`Array<{
  id: string;
  subject: ${union};
}>`);
    expect(
      renderOperationResultType(slots, "draft", "findMany", selection)
    ).toBe(`Array<{
  id: string;
  subject: ${union} | null;
}>`);
  });

  test("renders the behavior suite's unnamed-arm selections over its own schema", () => {
    // The same schema object and selections the runtime cell reads
    // (polymorphic-relation-behavior.ts) and the static pin types
    // (tests/types/client/polymorphic-relation-behavior.core.types.ts).
    const union = `{
    readonly type: "post";
    readonly data: {
      title: string;
    };
  } | {
    readonly type: "video";
    readonly data: {
      id: number;
      slug: string;
      title: string;
    };
  }`;
    expect(
      renderOperationResultType(
        polymorphicRelationSchema,
        "requiredComment",
        "findMany",
        { select: unnamedArmSelections.requiredComment }
      )
    ).toBe(`Array<{
  id: number;
  subject: ${union};
}>`);
    expect(
      renderOperationResultType(
        polymorphicRelationSchema,
        "comment",
        "findUniqueOrThrow",
        { where: { id: 1 }, select: unnamedArmSelections.comment }
      )
    ).toBe(`{
  id: number;
  commentable: ${union} | null;
}`);
  });
});

describe("schema-only rendering of recursive relation slots", () => {
  const tree = s.model({
    id: s.string().id(),
    label: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => tree)
      .name("RenderedTree")
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => tree).name("RenderedTree"),
    groves: s.toMany(() => grove).name("RenderedGrove"),
  });
  const grove = s.model({
    id: s.string().id(),
    rootId: s.string().nullable(),
    root: s
      .toOne(() => tree)
      .name("RenderedGrove")
      .fields("rootId")
      .references("id"),
  });
  const hub = s.model({
    id: s.string().id(),
    links: s.toMany(() => hub).name("RenderedLinks"),
    linkedBy: s.toMany(() => hub).name("RenderedLinks"),
  });
  const recursiveSchema = { tree, grove, hub };

  test("names the repeated node once and leaves its key optional under a numeric cutoff", () => {
    expect(
      renderOperationResultType(recursiveSchema, "tree", "findMany", {
        select: {
          label: true,
          children: { recurse: { depth: 2 }, select: { label: true } },
        },
      })
    ).toBe(`type VibORMOperationResult = Array<{
  label: string;
  children: Array<VibORMRecursiveNode1>;
}>;
type VibORMRecursiveNode1 = {
  label: string;
  children?: Array<VibORMRecursiveNode1>;
};`);
  });

  test("keeps the repeated key required and the slot's own emptiness on exhaustive traversal", () => {
    expect(
      renderOperationResultType(recursiveSchema, "tree", "findUnique", {
        where: { id: "tree-1" },
        select: {
          parent: { recurse: { depth: false }, select: { label: true } },
        },
      })
    ).toBe(`type VibORMOperationResult = {
  parent: VibORMRecursiveNode1 | null;
} | null;
type VibORMRecursiveNode1 = {
  label: string;
  parent: VibORMRecursiveNode1 | null;
};`);
    expect(
      renderOperationResultType(recursiveSchema, "hub", "findFirstOrThrow", {
        include: { links: { recurse: { depth: false } } },
      })
    ).toBe(`type VibORMOperationResult = {
  id: string;
  links: Array<VibORMRecursiveNode1>;
};
type VibORMRecursiveNode1 = {
  id: string;
  links: Array<VibORMRecursiveNode1>;
};`);
  });

  test("renders a recursive slot below an ordinary node and a second slot inside the repeated node", () => {
    expect(
      renderOperationResultType(recursiveSchema, "grove", "findMany", {
        include: {
          root: {
            include: {
              children: {
                recurse: true,
                include: { parent: { recurse: { depth: false } } },
              },
            },
          },
        },
      })
    ).toBe(`type VibORMOperationResult = Array<{
  id: string;
  rootId: string | null;
  root: {
    id: string;
    label: string;
    parentId: string | null;
    children: Array<VibORMRecursiveNode1>;
  } | null;
}>;
type VibORMRecursiveNode1 = {
  id: string;
  label: string;
  parentId: string | null;
  parent: VibORMRecursiveNode2 | null;
  children?: Array<VibORMRecursiveNode1>;
};
type VibORMRecursiveNode2 = {
  id: string;
  label: string;
  parentId: string | null;
  parent: VibORMRecursiveNode2 | null;
};`);
  });

  test("renders the same slot identically on a row-returning mutation and keeps ordinary results expressions", () => {
    expect(
      renderOperationResultType(recursiveSchema, "tree", "update", {
        where: { id: "tree-1" },
        data: { label: "renamed" },
        select: { children: { recurse: { depth: 3 }, select: { id: true } } },
      })
    ).toBe(`type VibORMOperationResult = {
  children: Array<VibORMRecursiveNode1>;
};
type VibORMRecursiveNode1 = {
  id: string;
  children?: Array<VibORMRecursiveNode1>;
};`);
    expect(
      renderOperationResultType(recursiveSchema, "tree", "findMany", {
        select: { children: { select: { id: true } } },
      })
    ).toBe(`Array<{
  children: Array<{
    id: string;
  }>;
}>`);
  });
});
