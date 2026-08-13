import { hydrateSchemaNames } from "@schema/hydration";
import { s } from "@schema/index";
import { createSchemaRegistry, parse } from "@validation/index";
import { describe, expect, test } from "vitest";

const post = s.model({ id: s.string().id() });
const video = s.model({ id: s.string().id() });

const parent = s.model({
  id: s.string().id(),
  requiredChildren: s.oneToMany(() => requiredChild).name("requiredChildren"),
  optionalChildren: s.oneToMany(() => optionalChild).name("optionalChildren"),
});

const requiredChild = s.model({
  id: s.string().id(),
  parentId: s.string(),
  parent: s
    .manyToOne(() => parent)
    .fields("parentId")
    .references("id")
    .name("requiredChildren"),
  preview: s
    .polymorphic(
      { post: () => post, video: () => video },
      { values: { post: "preview.post.v1", video: "preview.video.v1" } }
    )
    .optional(),
  subject: s.polymorphic(
    { post: () => post, video: () => video },
    { values: { post: "post.v1", video: "video.v1" } }
  ),
  secondary: s.polymorphic(
    { post: () => post, video: () => video },
    { values: { post: "secondary.post.v1", video: "secondary.video.v1" } }
  ),
});

const optionalChild = s.model({
  id: s.string().id(),
  parentId: s.string().default("unbound"),
  parent: s
    .manyToOne(() => parent)
    .fields("parentId")
    .references("id")
    .name("optionalChildren")
    .optional(),
  subject: s
    .polymorphic(
      { post: () => post, video: () => video },
      { values: { post: "post.v1", video: "video.v1" } }
    )
    .optional(),
});

const models = { parent, requiredChild, optionalChild, post, video };
hydrateSchemaNames(models);
const schemas = createSchemaRegistry(models).proxy;

describe("polymorphic createMany relation requirements", () => {
  test("root createMany accepts connect-only polymorphic memberships per row", () => {
    const accepted = parse(schemas.requiredChild.args.createMany, {
      data: [
        {
          id: "child-1",
          parentId: "parent-1",
          subject: { connect: { type: "post", where: { id: "post-1" } } },
          secondary: {
            connect: { type: "video", where: { id: "video-1" } },
          },
        },
      ],
    });
    const missing = parse(schemas.requiredChild.args.createMany, {
      data: [{ id: "child-2", parentId: "parent-1" }],
    });

    expect(accepted.issues).toBeUndefined();
    expect(missing.issues?.[0]?.message).toContain("subject");
  });

  test("nested create-family createMany accepts relation-bearing rows", () => {
    const result = parse(schemas.parent.args.create, {
      data: {
        id: "parent-1",
        requiredChildren: {
          createMany: {
            data: [
              {
                id: "child-1",
                subject: {
                  connect: { type: "post", where: { id: "post-1" } },
                },
                secondary: {
                  connect: { type: "video", where: { id: "video-1" } },
                },
              },
            ],
          },
        },
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("nested update-family createMany accepts relation-bearing rows", () => {
    const result = parse(schemas.parent.args.update, {
      where: { id: "parent-1" },
      data: {
        requiredChildren: {
          createMany: {
            data: [
              {
                id: "child-2",
                subject: {
                  connect: { type: "video", where: { id: "video-2" } },
                },
                secondary: {
                  connect: { type: "post", where: { id: "post-2" } },
                },
              },
            ],
          },
        },
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("nested createMany still requires every relation not supplied by its enclosing edge", () => {
    const result = parse(schemas.parent.args.create, {
      data: {
        id: "parent-1",
        requiredChildren: {
          createMany: {
            data: [
              {
                id: "child-3",
                subject: {
                  connect: { type: "post", where: { id: "post-1" } },
                },
              },
            ],
          },
        },
      },
    });

    expect(result.issues?.[0]?.path).toEqual([
      "data",
      "requiredChildren",
      "createMany",
      "data",
      0,
    ]);
  });

  test("nested createMany keeps the enclosing ordinary membership unspellable", () => {
    const row = {
      id: "child-4",
      parentId: "other-parent",
      subject: {
        connect: { type: "post", where: { id: "post-1" } },
      },
      secondary: {
        connect: { type: "video", where: { id: "video-1" } },
      },
    };
    const result = parse(schemas.parent.args.create, {
      data: {
        id: "parent-1",
        requiredChildren: { createMany: { data: [row] } },
      },
    });

    expect(result.issues?.[0]?.message).toBe("Unknown key: parentId");
    expect(result.issues?.[0]?.path).toEqual([
      "data",
      "requiredChildren",
      "createMany",
      "data",
      0,
      "parentId",
    ]);
  });

  test("optional-only polymorphic targets retain root and nested createMany", () => {
    const root = parse(schemas.optionalChild.args.createMany, {
      data: [{ id: "child-1" }],
    });
    const nestedCreate = parse(schemas.parent.args.create, {
      data: {
        id: "parent-1",
        optionalChildren: { createMany: { data: [{ id: "child-2" }] } },
      },
    });
    const nestedUpdate = parse(schemas.parent.args.update, {
      where: { id: "parent-1" },
      data: {
        optionalChildren: { createMany: { data: [{ id: "child-3" }] } },
      },
    });

    expect(root.issues).toBeUndefined();
    expect(nestedCreate.issues).toBeUndefined();
    expect(nestedUpdate.issues).toBeUndefined();
  });
});
