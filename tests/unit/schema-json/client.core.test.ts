/**
 * What a parsed schema IS downstream: the same models a hand-written schema
 * produces, so hydration, the resolution gate and the client consume it
 * unchanged and refuse it with their own codes.
 */

import { createClient } from "@client/client";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { attachFieldSchemas, parseSchema, serializeSchema } from "@schema/json";
import { SchemaValidationError } from "@schema/validation/error";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";

const UNKNOWN_MODEL = /not found in schema/;

import { z } from "zod";

const BLOG = {
  version: 1,
  models: {
    user: {
      fields: {
        id: { type: "string", id: true },
        email: { type: "string", unique: true },
        posts: { type: "toMany", target: "post" },
      },
    },
    post: {
      fields: {
        id: { type: "string", id: true },
        authorId: { type: "string" },
        author: {
          type: "toOne",
          target: "user",
          fields: ["authorId"],
          references: ["id"],
        },
      },
    },
  },
};

describe("client", () => {
  it("builds a working client from a document", () => {
    const client = createClient({
      schema: parseSchema(BLOG),
      driver: createInMemorySQLite3Driver(),
    });
    expect(typeof client.user?.findMany).toBe("function");
    expect(typeof client.post?.create).toBe("function");
  });

  it("refuses an unknown model name at runtime", () => {
    const client = createClient({
      schema: parseSchema(BLOG),
      driver: createInMemorySQLite3Driver(),
    });
    expect(() => client.ghost?.findMany()).toThrow(UNKNOWN_MODEL);
  });

  /**
   * The document inherits every graph diagnostic: nothing about a parsed
   * schema is a second trust path, so a topology the gate refuses in code is
   * refused here too, by the gate, with its own code.
   */
  it("hands a broken graph to the resolution gate", () => {
    const broken = parseSchema({
      version: 1,
      models: {
        left: {
          fields: {
            id: { type: "string", id: true },
            r: { type: "toOne", target: "right" },
          },
        },
        right: {
          fields: {
            id: { type: "string", id: true },
            l: { type: "toOne", target: "left" },
          },
        },
      },
    });
    let thrown: unknown;
    try {
      createClient({ schema: broken, driver: createInMemorySQLite3Driver() });
    } catch (error) {
      thrown = error;
    }
    const cause = (thrown as { originalCause?: unknown }).originalCause;
    expect(cause ?? thrown).toBeInstanceOf(SchemaValidationError);
  });

  it("refuses an invalid model key at the parse boundary, not at hydration", () => {
    expect(() =>
      parseSchema({ version: 1, models: { "2fast": { fields: {} } } })
    ).toThrow(ValidationError);
  });
});

/**
 * A document can be perfectly well-formed and still describe a schema no client
 * will accept. `{ validate: true }` is where the caller says WHEN to find that
 * out; these tests pin where the failure moves, and that it keeps its own name.
 */
describe("parseSchema({ validate: true })", () => {
  // Shape-valid, graph-invalid: `user.posts` names `post`, and `post` names
  // nobody back.
  const LONE_TO_MANY = {
    version: 1,
    models: {
      user: {
        fields: {
          id: { type: "string", id: true },
          posts: { type: "toMany", target: "post" },
        },
      },
      post: { fields: { id: { type: "string", id: true } } },
    },
  };

  it("refuses a graph the document is right about and the schema is not", () => {
    let thrown: unknown;
    try {
      parseSchema(LONE_TO_MANY, { validate: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaValidationError);
    // The graph keeps its OWN vocabulary: no `J0xx` code describes a topology.
    expect(
      thrown instanceof SchemaValidationError
        ? thrown.issues.map((issue) => issue.code)
        : []
    ).toEqual(["R002"]);
  });

  it("leaves that same document parseable, and lets `createClient` refuse it", () => {
    const schema = parseSchema(LONE_TO_MANY);
    expect(Object.keys(schema)).toEqual(["user", "post"]);
    let thrown: unknown;
    try {
      createClient({ schema, driver: createInMemorySQLite3Driver() });
    } catch (error) {
      thrown = error;
    }
    const cause = (thrown as { originalCause?: unknown }).originalCause;
    expect(cause ?? thrown).toBeInstanceOf(SchemaValidationError);
  });

  it("builds exactly the schema the default builds, for a document that passes", () => {
    const validated = parseSchema(BLOG, { validate: true });
    const plain = parseSchema(BLOG, { validate: false });
    expect(serializeSchema(validated)).toEqual(serializeSchema(plain));
    expect(serializeSchema(validated)).toEqual(
      serializeSchema(parseSchema(BLOG))
    );
  });

  /**
   * Validating hydrates, so the models come back already bound to the keys the
   * DOCUMENT gave them. That is the same binding `createClient` performs, which
   * is why re-registering the same record is idempotent rather than an `M003`.
   */
  it("binds the document's own keys, leaving `createClient` idempotent", () => {
    const schema = parseSchema(BLOG, { validate: true });
    expect(schema.user?.["~"].names.ts).toBe("user");
    const client = createClient({
      schema,
      driver: createInMemorySQLite3Driver(),
    });
    expect(typeof client.user?.findMany).toBe("function");
  });
});

describe("GeoPoint index interpretation", () => {
  const pointIndexDocument = (index: {
    fields: string[];
    type: "spatial";
    unique?: boolean;
  }) => ({
    version: 1,
    models: {
      place: {
        fields: {
          id: { type: "string" as const, id: true },
          name: { type: "string" as const },
          location: { type: "point" as const },
        },
        indexes: [index],
      },
    },
  });

  it("preserves a valid spatial declaration", () => {
    expect(() =>
      parseSchema(
        pointIndexDocument({ fields: ["location"], type: "spatial" }),
        { validate: true }
      )
    ).not.toThrow();
  });

  it.each([
    { fields: ["location", "name"], type: "spatial" as const },
    { fields: ["location"], type: "spatial" as const, unique: true },
    { fields: ["location"], type: "spatial" as const, unique: false },
  ])("preserves and refuses the invalid declaration %#", (index) => {
    let thrown: unknown;
    try {
      parseSchema(pointIndexDocument(index), { validate: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SchemaValidationError);
    expect(
      thrown instanceof SchemaValidationError
        ? thrown.issues.map((issue) => issue.code)
        : []
    ).toContain("I005");
  });
});

describe("attachFieldSchemas", () => {
  it("applies a validator through the real `.schema()` builder", () => {
    const schema = attachFieldSchemas(parseSchema(BLOG), {
      "user.email": z.string().email(),
    });
    const email = schema.user?.["~"].state.scalars.email;
    expect(email?.["~"].state.schema).toBeDefined();
    expect(
      email?.["~"].state.base["~standard"].validate("nope")
    ).toHaveProperty("issues");
    expect(
      email?.["~"].state.base["~standard"].validate("a@b.com")
    ).toHaveProperty("value", "a@b.com");
  });

  it("applies the validator after nullability, so both survive", () => {
    const schema = attachFieldSchemas(
      parseSchema({
        version: 1,
        models: {
          user: {
            fields: {
              id: { type: "string", id: true },
              nick: { type: "string", nullable: true },
            },
          },
        },
      }),
      { "user.nick": z.string().min(2) }
    );
    const base = schema.user?.["~"].state.scalars.nick?.["~"].state.base;
    expect(base?.["~standard"].validate(null)).toHaveProperty("value", null);
    expect(base?.["~standard"].validate("x")).toHaveProperty("issues");
  });

  it("refuses a path that names no scalar field", () => {
    for (const path of ["user.nope", "ghost.email", "user.posts", "user"]) {
      expect(() =>
        attachFieldSchemas(parseSchema(BLOG), { [path]: z.string() })
      ).toThrow(ValidationError);
    }
  });

  it("works on a schema written in code, and refuses what the document cannot hold", () => {
    const user = s.model({ id: s.string().id(), email: s.string() });
    const attached = attachFieldSchemas(
      { user },
      {
        "user.email": z.string().email(),
      }
    );
    expect(attached.user).not.toBe(user);
    expect(
      attached.user?.["~"].state.scalars.email?.["~"].state.schema
    ).toBeDefined();
    // Every other declaration survives the round trip the re-read performs.
    expect(serializeSchema({ user }).models.user?.fields.email).toEqual({
      type: "string",
    });

    const withClosure = s.model({
      id: s.string().id(),
      at: s.dateTime().default(() => new Date()),
    });
    expect(() => attachFieldSchemas({ withClosure }, {})).toThrow(
      ValidationError
    );
  });
});
