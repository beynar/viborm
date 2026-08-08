import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema/index";
import { expectTypeOf, test } from "vitest";

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

const client = createClient({
  schema: { parent, requiredChild, optionalChild, post, video },
  driver: new PGliteDriver(),
});

const requiredNestedCreateMany = { createMany: { data: [] } };

const rootRequiredConnect = () =>
  client.requiredChild.createMany({
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

const nestedCreateRefusal = () =>
  client.parent.create({
    data: {
      id: "parent-1",
      // @ts-expect-error - nested createMany cannot supply the required polymorphic edge
      requiredChildren: requiredNestedCreateMany,
    },
  });

const nestedUpdateRefusal = () =>
  client.parent.update({
    where: { id: "parent-1" },
    data: {
      // @ts-expect-error - update-family createMany has the same scalar-only boundary
      requiredChildren: requiredNestedCreateMany,
    },
  });

const optionalRoot = () =>
  client.optionalChild.createMany({ data: [{ id: "child-1" }] });

const optionalNestedCreate = () =>
  client.parent.create({
    data: {
      id: "parent-1",
      optionalChildren: { createMany: { data: [{ id: "child-2" }] } },
    },
  });

const optionalNestedUpdate = () =>
  client.parent.update({
    where: { id: "parent-1" },
    data: {
      optionalChildren: { createMany: { data: [{ id: "child-3" }] } },
    },
  });

test("public createMany availability follows polymorphic nullability", () => {
  expectTypeOf(rootRequiredConnect).toBeFunction();
  expectTypeOf(nestedCreateRefusal).toBeFunction();
  expectTypeOf(nestedUpdateRefusal).toBeFunction();
  expectTypeOf(optionalRoot).toBeFunction();
  expectTypeOf(optionalNestedCreate).toBeFunction();
  expectTypeOf(optionalNestedUpdate).toBeFunction();
});
