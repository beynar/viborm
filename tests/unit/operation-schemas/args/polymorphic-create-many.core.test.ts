import { hydrateSchemaNames } from "@schema/hydration";
import { s } from "@schema/index";
import { createSchemaRegistry, parse } from "@validation/index";
import { describe, expect, test } from "vitest";

const post = s.model({ id: s.string().id() });
const video = s.model({ id: s.string().id() });

const parent = s.model({
  id: s.string().id(),
  requiredChildren: s
    .oneToMany(() => requiredChild)
    .name("requiredChildren"),
  optionalChildren: s
    .oneToMany(() => optionalChild)
    .name("optionalChildren"),
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

const refusal =
  "createMany is not available for model 'requiredChild' because required polymorphic relation 'subject' cannot be supplied by a scalar-only bulk row. Use create instead.";

describe("required polymorphic createMany availability", () => {
  test("root createMany refuses the first required polymorphic field", () => {
    const result = parse(schemas.requiredChild.args.createMany, { data: [] });

    expect(result.issues?.[0]?.message).toBe(refusal);
  });

  test("nested create-family createMany uses the same refusal", () => {
    const result = parse(schemas.parent.args.create, {
      data: {
        id: "parent-1",
        requiredChildren: { createMany: { data: [] } },
      },
    });

    expect(result.issues?.[0]?.message).toBe(refusal);
    expect(result.issues?.[0]?.path).toEqual([
      "data",
      "requiredChildren",
      "createMany",
    ]);
  });

  test("nested update-family createMany uses the same refusal", () => {
    const result = parse(schemas.parent.args.update, {
      where: { id: "parent-1" },
      data: {
        requiredChildren: { createMany: { data: [] } },
      },
    });

    expect(result.issues?.[0]?.message).toBe(refusal);
    expect(result.issues?.[0]?.path).toEqual([
      "data",
      "requiredChildren",
      "createMany",
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
