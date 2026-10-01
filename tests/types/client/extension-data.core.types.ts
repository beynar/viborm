/**
 * The types of an extension's `data` (extension-capabilities plan v4 §2.2
 * Types, §6 Data "Types"): on a client whose chain declares `data` for a
 * model, the fields it writes accept nothing in that model's create and
 * update payloads (`create`, `createMany` rows, `upsert`'s two arms,
 * `update`, `updateMany`) and in every create and update the call nests
 * through a relation, because the call is refused when it passes one. The
 * base client still accepts them. A misspelt model in an inline `data`
 * declaration is an editor error. The §1.3 lock recipe types end to end.
 * The runtime half is `tests/contracts/engine/write/extension-data-behavior.ts`.
 *
 * Nothing in this file is called. Only the types matter.
 */

import type { AnyDriver } from "@src/drivers/exports";
import { createClient, defineExtension, s } from "@src/index";
import { v } from "@src/validation";
import {
  audit,
  optimisticLock,
  tenancy,
} from "../../fixtures/extension-recipes";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

declare const driver: AnyDriver;

const post = s.model({
  id: s.int().id(),
  title: s.string(),
  tenantId: s.string().nullable(),
  createdBy: s.string().nullable(),
  updatedBy: s.string().nullable(),
  version: s.int().default(0),
  comments: s.toMany(() => comment),
});
const comment = s.model({
  id: s.int().id(),
  body: s.string(),
  createdBy: s.string().nullable(),
  postId: s.int(),
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id"),
});
// `owner` is required by the schema: a stamp cannot fill it (decision U2-1).
const ledger = s.model({ id: s.int().id(), owner: s.string() });
const schema = { post, comment, ledger };

const base = createClient({ schema, driver });

// An inline declaration keeps its model names: only `post` is narrowed.
const stamped = base.$extends(
  defineExtension({
    name: "audit",
    controls: { actor: { schema: v.string(), required: true, on: "writes" } },
    data: {
      models: {
        post: {
          create: { createdBy: { control: "actor" } },
          update: { updatedBy: { control: "actor" } },
        },
        ledger: { create: { owner: { control: "actor" } } },
      },
    },
  })
);

export async function stampedFieldsAreRefused() {
  await stamped.post.create({ data: { id: 1, title: "a" }, actor: "ann" });
  await stamped.post.create({
    // @ts-expect-error - audit writes createdBy on every create of post
    data: { id: 1, title: "a", createdBy: "mallory" },
    actor: "ann",
  });
  await stamped.post.createMany({
    data: [
      { id: 2, title: "b" },
      // @ts-expect-error - and on every createMany row
      { id: 3, title: "c", createdBy: "mallory" },
    ],
    actor: "ann",
  });
  await stamped.post.update({
    where: { id: 1 },
    data: { title: "b" },
    actor: "ann",
  });
  await stamped.post.update({
    where: { id: 1 },
    // @ts-expect-error - audit writes updatedBy on every update of post
    data: { updatedBy: "mallory" },
    actor: "ann",
  });
  await stamped.post.updateMany({
    // @ts-expect-error - updateMany too
    data: { updatedBy: "mallory" },
    actor: "ann",
  });
  await stamped.post.upsert({
    where: { id: 1 },
    // @ts-expect-error - upsert's create arm is a create
    create: { id: 1, title: "a", createdBy: "mallory" },
    update: { title: "b" },
    actor: "ann",
  });
  await stamped.post.upsert({
    where: { id: 1 },
    create: { id: 1, title: "a" },
    // @ts-expect-error - upsert's update arm is an update
    update: { updatedBy: "mallory" },
    actor: "ann",
  });
}

export async function otherFieldsPass() {
  // A field audit writes only on create can still be set by an update.
  await stamped.post.update({
    where: { id: 1 },
    data: { createdBy: "import" },
    actor: "ann",
  });
  // A model the declaration does not name keeps its fields.
  await stamped.comment.create({
    data: { id: 1, body: "x", postId: 1, createdBy: "import" },
    actor: "ann",
  });
  // A nested write to a model the declaration does not name keeps its fields.
  await stamped.post.create({
    data: {
      id: 1,
      title: "a",
      comments: { create: { id: 1, body: "x", createdBy: "x" } },
    },
    actor: "ann",
  });
}

export async function nestedWritesAreNarrowed() {
  await stamped.comment.create({
    data: {
      id: 1,
      body: "x",
      // @ts-expect-error - a nested create of post
      post: { create: { id: 1, title: "a", createdBy: "x" } },
    },
    actor: "ann",
  });
  await stamped.comment.create({
    data: {
      id: 1,
      body: "x",
      post: {
        connectOrCreate: {
          where: { id: 1 },
          // @ts-expect-error - connectOrCreate's create
          create: { id: 1, title: "a", createdBy: "x" },
        },
      },
    },
    actor: "ann",
  });
  await stamped.comment.update({
    where: { id: 1 },
    // @ts-expect-error - a nested update of post
    data: { post: { update: { updatedBy: "x" } } },
    actor: "ann",
  });
  await stamped.comment.update({
    where: { id: 1 },
    data: {
      post: {
        upsert: {
          create: { id: 1, title: "a" },
          // @ts-expect-error - a nested upsert's update arm
          update: { updatedBy: "x" },
        },
      },
    },
    actor: "ann",
  });
  await stamped.comment.update({
    where: { id: 1 },
    data: { post: { update: { title: "b", createdBy: "import" } } },
    actor: "ann",
  });
  // At any depth, item by item.
  await stamped.post.create({
    data: {
      id: 1,
      title: "a",
      comments: {
        create: [
          {
            id: 2,
            body: "y",
            // @ts-expect-error - post again, two relations down
            post: { create: { id: 3, title: "z", createdBy: "q" } },
          },
        ],
      },
    },
    actor: "ann",
  });
  // A transaction's client is the same client.
  await stamped.$transaction(async (tx) => {
    await tx.post.create({
      // @ts-expect-error - the transaction client narrows the same fields
      data: { id: 1, title: "a", createdBy: "mallory" },
      actor: "ann",
    });
  });
}

export async function baseClientAcceptsThem() {
  await base.post.create({ data: { id: 1, title: "a", createdBy: "ann" } });
  await base.post.createMany({ data: [{ id: 2, title: "b", createdBy: "x" }] });
  await base.post.update({ where: { id: 1 }, data: { updatedBy: "bob" } });
  await base.post.upsert({
    where: { id: 1 },
    create: { id: 1, title: "a", createdBy: "ann" },
    update: { updatedBy: "bob" },
  });
  await base.ledger.create({ data: { id: 1, owner: "ann" } });
}

export async function aRequiredStampedFieldRefusesEveryCreate() {
  // The schema requires `owner` and the extension writes it: the caller may
  // not pass it and may not leave it out. Every create is refused when it
  // runs (missing field), so the types refuse it too. The guide says to make
  // such a field nullable or give it a default.
  // @ts-expect-error - owner is required and accepts no value
  await stamped.ledger.create({ data: { id: 1 }, actor: "ann" });
  // @ts-expect-error - and passing it is refused
  await stamped.ledger.create({ data: { id: 1, owner: "a" }, actor: "a" });
}

export function aMisspeltModelIsAnEditorError() {
  base.$extends(
    // @ts-expect-error - no model "psot" in this schema
    defineExtension({
      name: "typo",
      data: {
        models: {
          psot: { create: { createdBy: "system" } },
        },
      },
    })
  );
  // The schema-bound form refuses it at the model, where it is written.
  defineExtension<typeof schema>()({
    name: "typo",
    data: {
      models: {
        // @ts-expect-error - no model "psot" in this schema
        psot: { create: { createdBy: "system" } },
      },
    },
  });
  // A recipe's model list is a plain string[]: its names are not checked,
  // and its fields are refused on every model of the client.
  const recipe = base.$extends(audit(["psot"]));
  return recipe.comment.create({
    // @ts-expect-error - comment.createdBy is refused too
    data: { id: 1, body: "x", postId: 1, createdBy: "x" },
    actor: "ann",
  });
}

// §1.3, end to end through the recipe fixture.
const locked = base.$extends(optimisticLock(["post"]));

export async function optimisticLockTypes() {
  const updated = await locked.post.update({
    where: { id: 1 },
    data: { title: "b" },
    expectedVersion: 3,
  });
  type _updated = Expect<Equal<typeof updated.version, number>>;
  await locked.post.update({
    where: { id: 1 },
    // @ts-expect-error - the lock moves the version itself
    data: { version: 4 },
    expectedVersion: 3,
  });
  await locked.post.update({
    where: { id: 1 },
    // @ts-expect-error - an update operator is refused as well
    data: { version: { increment: 1 } },
    expectedVersion: 3,
  });
  // The lock writes on update only: a create may set the first version.
  await locked.post.create({ data: { id: 2, title: "a", version: 1 } });
  await locked.post.update({
    where: { id: 1 },
    data: { title: "c" },
    versionCheck: "unchecked",
  });
  await locked.post.delete({ where: { id: 1 }, expectedVersion: 4 });
  // @ts-expect-error - expectedVersion is placed on update and delete only
  await locked.post.findMany({ expectedVersion: 3 });
}

// Two recipes on one client: each one's fields are refused.
const both = base.$extends(tenancy(["post"])).$extends(audit(["post"]));

export async function twoExtensions() {
  await both.post.create({
    data: { id: 1, title: "a" },
    tenant: "acme",
    actor: "ann",
  });
  await both.post.create({
    // @ts-expect-error - tenancy writes tenantId
    data: { id: 1, title: "a", tenantId: "globex" },
    tenant: "acme",
    actor: "ann",
  });
  await both.post.create({
    // @ts-expect-error - audit writes createdBy
    data: { id: 1, title: "a", createdBy: "mallory" },
    tenant: "acme",
    actor: "ann",
  });
  // tenancy writes tenantId on create only.
  await both.post.update({
    where: { id: 1 },
    data: { tenantId: "globex" },
    tenant: "acme",
    actor: "ann",
  });
}
