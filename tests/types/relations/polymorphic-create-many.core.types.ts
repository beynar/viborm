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

/**
 * PINNED AS COMPILING WITH THE TYPO (Package J1 labelled this; it was an
 * unlabelled pin before). `secondary` sits beside the real `subject` and is NOT a
 * compile error, because `data` is one of the MEASURED-unguarded clauses:
 * `tests/types/client/contextual-typing-gate.core.types.ts` records that naming
 * `data` in `NoExtraOperationKeys` turns six estate sites into TS2589 and takes the
 * estate type-check from 34s to 172s. The refusal that DOES answer is the runtime
 * one — the row schema is a strict object, so an unknown key beside a real key
 * fails the parse (`nested-args.core.test.ts`, "an unknown key BESIDE a real
 * relation key still refuses"). When a future TypeScript can carry the deeper form
 * this line turns red: delete `secondary` and move it to a `@ts-expect-error`.
 */
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

/**
 * PACKAGE J1 — the row is the ordinary create data shape, so the owned foreign key
 * may be spelled as its relation instead. The polymorphic membership stays
 * connect-only (its `"createMany"` mode), which is what keeps the grouped bulk
 * probe route in `bulk-polymorphic-connect.ts` reachable.
 */
const rootRelationInsteadOfFk = () =>
  client.requiredChild.createMany({
    data: [
      {
        id: "child-1",
        parent: { connect: { id: "parent-1" } },
        subject: { connect: { type: "post", where: { id: "post-1" } } },
      },
    ],
  });

/** A NON-FRESH variable, not a fresh literal: the rows built first, then passed. */
const rootRelationFromVariable = () => {
  const rows = [
    { id: "child-2", parent: { create: { id: "parent-2" } } },
    { id: "child-3", parent: { connect: { id: "parent-1" } } },
  ];
  return client.optionalChild.createMany({ data: rows });
};

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
  expectTypeOf(rootRelationInsteadOfFk).toBeFunction();
  expectTypeOf(rootRelationFromVariable).toBeFunction();
  expectTypeOf(nestedCreateRefusal).toBeFunction();
  expectTypeOf(nestedUpdateRefusal).toBeFunction();
  expectTypeOf(optionalRoot).toBeFunction();
  expectTypeOf(optionalNestedCreate).toBeFunction();
  expectTypeOf(optionalNestedUpdate).toBeFunction();
});
