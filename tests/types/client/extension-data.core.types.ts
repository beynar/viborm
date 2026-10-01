/**
 * The types of an extension's `data` (extension-capabilities plan v4 §2.2
 * Types, §6 Data "Types"): on a client whose chain declares `data` for a
 * model, the fields it writes accept nothing in that model's create and
 * update payloads (`create`, `createMany` rows, `upsert`'s two arms,
 * `update`, `updateMany`) and in every create and update the call nests
 * through a relation, because the call is refused when it passes one. They
 * may be left out even where the schema requires them, at the top level and
 * nested, because the chain writes them (owner ruling, plan v4 §7.5). The
 * base client still accepts them and still asks for a required one. A
 * misspelt model in an inline `data` declaration is an editor error. The
 * guide's recipes keep the model names they are given, so they narrow those
 * models and no other; a list whose names the types cannot see narrows
 * nothing. The runtime halves are
 * `tests/contracts/engine/write/extension-data-behavior.ts` and
 * `tests/contracts/engine/write/stamped-required-behavior.ts`.
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
  notes: s.toMany(() => note),
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
// A to-many target stamped on both kinds of write.
const note = s.model({
  id: s.int().id(),
  text: s.string(),
  createdBy: s.string().nullable(),
  updatedBy: s.string().nullable(),
  postId: s.int(),
  post: s
    .toOne(() => post)
    .fields("postId")
    .references("id"),
});
// `owner` is required by the schema, and the extension below writes it.
const ledger = s.model({ id: s.int().id(), owner: s.string() });
// `createdBy` is required here, and only the recipe below names other models.
const invoice = s.model({ id: s.int().id(), createdBy: s.string() });
const schema = { post, comment, note, ledger, invoice };

const base = createClient({ schema, driver });

// An inline declaration keeps its model names: only the models it names are
// narrowed.
const stamped = base.$extends(
  defineExtension({
    name: "audit",
    controls: { actor: { schema: v.string(), required: true, on: "writes" } },
    data: {
      models: {
        post: {
          create: { createdBy: { control: "actor" } },
          update: {
            updatedBy: { control: "actor" },
            version: { increment: 1 },
          },
        },
        note: {
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
  await stamped.post.update({
    where: { id: 1 },
    // @ts-expect-error - an update operator is refused as well as a value
    data: { version: { increment: 1 } },
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
  // A to-many target, through each verb that writes it.
  await stamped.post.create({
    data: {
      id: 1,
      title: "a",
      notes: {
        createMany: {
          // @ts-expect-error - a nested createMany row
          data: [{ id: 1, text: "x", createdBy: "m" }],
        },
      },
    },
    actor: "ann",
  });
  await stamped.post.update({
    where: { id: 1 },
    data: {
      notes: {
        // @ts-expect-error - a nested updateMany entry
        updateMany: [{ where: { id: 1 }, data: { updatedBy: "m" } }],
      },
    },
    actor: "ann",
  });
  await stamped.post.update({
    where: { id: 1 },
    data: {
      notes: {
        // @ts-expect-error - a to-many update names its row, then its data
        update: { where: { id: 1 }, data: { updatedBy: "m" } },
      },
    },
    actor: "ann",
  });
  await stamped.post.update({
    where: { id: 1 },
    data: {
      notes: { update: { where: { id: 1 }, data: { createdBy: "import" } } },
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

export async function aRequiredStampedFieldMayBeLeftOut() {
  // The schema requires `owner` and the extension writes it: the caller
  // leaves it out, and may not pass it.
  await stamped.ledger.create({ data: { id: 1 }, actor: "ann" });
  await stamped.ledger.createMany({ data: [{ id: 1 }], actor: "ann" });
  await stamped.ledger.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
    actor: "ann",
  });
  // @ts-expect-error - passing it is refused
  await stamped.ledger.create({ data: { id: 1, owner: "a" }, actor: "a" });
  // The base client still asks for it.
  // @ts-expect-error - owner is required
  await base.ledger.create({ data: { id: 1 } });
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
}

// A recipe keeps the model names it is given, with no `as const`: the
// models it names are narrowed, every other model keeps its fields.
const audited = base.$extends(audit(["post"]));

export async function aRecipeNarrowsTheModelsItNames() {
  // `invoice` requires `createdBy` and audit does not name it.
  await audited.invoice.create({
    data: { id: 1, createdBy: "ann" },
    actor: "ann",
  });
  // @ts-expect-error - so invoice still asks for it
  await audited.invoice.create({ data: { id: 1 }, actor: "ann" });
  await audited.post.create({
    // @ts-expect-error - audit writes createdBy on post
    data: { id: 1, title: "a", createdBy: "mallory" },
    actor: "ann",
  });
  // A misspelt model in the list is an editor error where it is applied.
  // @ts-expect-error - no model "psot" in this schema
  base.$extends(audit(["psot"]));
  // Two recipes on one client keep each one's controls.
  await base
    .$extends(tenancy(["post"]))
    .$extends(audit(["post"]))
    .post.create({ data: { id: 1, title: "a" }, tenant: "acme", actor: "ann" });
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
    // @ts-expect-error - the lock moves the version on every update of post
    data: { version: 4 },
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

// Two inline declarations on one client: each one's fields are refused.
const both = stamped.$extends(
  defineExtension({
    name: "tenancy",
    controls: { tenant: { schema: v.string(), required: true } },
    data: {
      models: { post: { create: { tenantId: { control: "tenant" } } } },
    },
  })
);

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

// A list whose names the types cannot see (a plain `string[]`) narrows
// nothing: the fields stay in every payload, and a call that passes one is
// refused when it runs.
declare const names: string[];
const listed = base.$extends(audit(names));

export async function aPlainListNarrowsNothing() {
  await listed.post.create({
    data: { id: 1, title: "a", createdBy: "mallory" },
    actor: "ann",
  });
  await listed.invoice.create({
    data: { id: 1, createdBy: "ann" },
    actor: "ann",
  });
}

// The guide's tenancy over a schema that requires `tenantId`: a plain field
// on `article`, a required foreign key on `reply`, and `memo`, which the
// recipe does not name.
const org = s.model({ id: s.string().id(), replies: s.toMany(() => reply) });
const article = s.model({
  id: s.int().id(),
  title: s.string(),
  tenantId: s.string(),
  replies: s.toMany(() => reply),
});
const reply = s.model({
  id: s.int().id(),
  body: s.string(),
  tenantId: s.string(),
  tenant: s
    .toOne(() => org)
    .fields("tenantId")
    .references("id"),
  articleId: s.int(),
  article: s
    .toOne(() => article)
    .fields("articleId")
    .references("id"),
});
const memo = s.model({ id: s.int().id(), tenantId: s.string() });
const plainTenants = createClient({
  schema: { org, article, reply, memo },
  driver,
});
const tenants = plainTenants.$extends(tenancy(["article", "reply"]));

export async function aRequiredTenantMayBeLeftOut() {
  await tenants.article.create({ data: { id: 1, title: "a" }, tenant: "acme" });
  await tenants.article.create({
    // @ts-expect-error - tenancy writes tenantId
    data: { id: 1, title: "a", tenantId: "globex" },
    tenant: "acme",
  });
  // A required foreign key: neither it nor its relation is asked for.
  await tenants.reply.create({
    data: { id: 1, body: "b", articleId: 1 },
    tenant: "acme",
  });
  await tenants.article.createMany({
    data: [{ id: 2, title: "b" }],
    tenant: "acme",
  });
  await tenants.article.upsert({
    where: { id: 1 },
    create: { id: 1, title: "a" },
    update: { title: "b" },
    tenant: "acme",
  });
  // @ts-expect-error - memo is not named: its tenantId is still required
  await tenants.memo.create({ data: { id: 1 }, tenant: "acme" });
  await tenants.memo.create({ data: { id: 1, tenantId: "acme" } });
  // @ts-expect-error - the base client still asks for it
  await plainTenants.article.create({ data: { id: 1, title: "a" } });
}

export async function aNestedCreateMayLeaveItOutToo() {
  await tenants.article.create({
    data: { id: 1, title: "a", replies: { create: [{ id: 1, body: "b" }] } },
    tenant: "acme",
  });
  await tenants.reply.create({
    data: { id: 1, body: "b", article: { create: { id: 1, title: "a" } } },
    tenant: "acme",
  });
  await tenants.article.update({
    where: { id: 1 },
    data: {
      replies: {
        createMany: { data: [{ id: 2, body: "c" }] },
        connectOrCreate: { where: { id: 3 }, create: { id: 3, body: "d" } },
        upsert: {
          where: { id: 4 },
          create: { id: 4, body: "e" },
          update: { body: "f" },
        },
      },
    },
    tenant: "acme",
  });
  await tenants.article.create({
    data: {
      id: 1,
      title: "a",
      // @ts-expect-error - a nested create may not pass it either
      replies: { create: [{ id: 1, body: "b", tenantId: "globex" }] },
    },
    tenant: "acme",
  });
}
