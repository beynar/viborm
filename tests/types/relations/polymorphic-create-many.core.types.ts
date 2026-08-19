import { createClient } from "@client/client";
import type { OperationPayload } from "@client/types";
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
    .polymorphicToOne(
      { post: () => post, video: () => video },
      { values: { post: "preview.post.v1", video: "preview.video.v1" } }
    )
    .optional(),
  subject: s.polymorphicToOne(
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
    .polymorphicToOne(
      { post: () => post, video: () => video },
      { values: { post: "post.v1", video: "video.v1" } }
    )
    .optional(),
});

const client = createClient({
  schema: { parent, requiredChild, optionalChild, post, video },
  driver: new PGliteDriver(),
});

const requiredNestedCreateManyCreatePayload = {
  data: {
    id: "parent-1",
    requiredChildren: {
      createMany: {
        data: [
          {
            id: "child-4",
            subject: {
              connect: { type: "post", where: { id: "post-1" } },
            },
          },
        ],
      },
    },
  },
} satisfies OperationPayload<"create", typeof parent>;

const requiredNestedCreateManyUpdatePayload = {
  where: { id: "parent-1" },
  data: {
    requiredChildren: {
      createMany: {
        data: [
          {
            id: "child-5",
            subject: {
              connect: { type: "video", where: { id: "video-1" } },
            },
          },
        ],
      },
    },
  },
} satisfies OperationPayload<"update", typeof parent>;

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

const nestedCreateWithRequiredRelation = () =>
  client.parent.create(requiredNestedCreateManyCreatePayload);

const nestedUpdateWithRequiredRelation = () =>
  client.parent.update(requiredNestedCreateManyUpdatePayload);

const nestedCreateStillRequiresItsOtherMembership = () =>
  client.parent.create({
    data: {
      id: "parent-1",
      requiredChildren: {
        createMany: {
          data: [
            // @ts-expect-error - the enclosing parent supplies parent, not subject
            { id: "child-6" },
          ],
        },
      },
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

/**
 * A collection slot is never a create requirement: the empty collection is the
 * default, so `PolymorphicCreateRequirementKeySetGroup` must drop it.
 */
const collectionOwner = s.model({
  id: s.string().id(),
  attachments: s.polymorphicToMany(
    { post: () => post, video: () => video },
    { values: { post: "attachment.post.v1", video: "attachment.video.v1" } }
  ),
});

const collectionSlotIsNeverRequiredOnCreate = {
  data: { id: "owner-1" },
} satisfies OperationPayload<"create", typeof collectionOwner>;

test("public createMany rows preserve polymorphic relation requirements", () => {
  expectTypeOf(rootRequiredConnect).toBeFunction();
  expectTypeOf(rootRelationInsteadOfFk).toBeFunction();
  expectTypeOf(rootRelationFromVariable).toBeFunction();
  expectTypeOf(nestedCreateWithRequiredRelation).toBeFunction();
  expectTypeOf(nestedUpdateWithRequiredRelation).toBeFunction();
  expectTypeOf(nestedCreateStillRequiresItsOtherMembership).toBeFunction();
  expectTypeOf(optionalRoot).toBeFunction();
  expectTypeOf(optionalNestedCreate).toBeFunction();
  expectTypeOf(optionalNestedUpdate).toBeFunction();
  expectTypeOf(collectionSlotIsNeverRequiredOnCreate).toBeObject();
});
