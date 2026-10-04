/**
 * The types of an extension's `data` (extension-capabilities plan v4 §2.2
 * Types, §6 Data "Types"): on a client whose chain declares `data` for a
 * model's creates, the fields it writes there may be left out of that model's
 * create rows (`create`, `createMany` rows, `upsert`'s create arm) even where
 * the schema requires them, at the top level and in every create the call
 * nests through a relation, because the chain writes each one the caller
 * leaves out (owner ruling, plan v4 §7.5). A caller may still write one, with
 * the field's own type, and that value stands, as may the relation whose
 * foreign key holds it (owner ruling 2026-10-02, plan v4 §7.1). An update's
 * fields are optional already and keep their types. The base client still
 * asks for a required one. A misspelt model in an inline `data` declaration
 * is an editor error. The guide's recipes keep the model names they are
 * given, so they narrow those models and no other; a list whose names the
 * types cannot see narrows nothing. The runtime halves are
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
// A to-many target stamped on both kinds of write, its `createdBy` required.
const note = s.model({
  id: s.int().id(),
  text: s.string(),
  createdBy: s.string(),
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

export async function aStampedFieldIsTheCallersWhenWritten() {
  await stamped.post.create({ data: { id: 1, title: "a" }, actor: "ann" });
  // A value the caller writes stands; it keeps the field's own type.
  await stamped.post.create({
    data: { id: 1, title: "a", createdBy: "import" },
    actor: "ann",
  });
  await stamped.post.create({
    // @ts-expect-error - createdBy is a string
    data: { id: 1, title: "a", createdBy: 1 },
    actor: "ann",
  });
  await stamped.post.createMany({
    data: [
      { id: 2, title: "b" },
      { id: 3, title: "c", createdBy: "import" },
    ],
    actor: "ann",
  });
  await stamped.post.createMany({
    // @ts-expect-error - and in every createMany row
    data: [{ id: 3, title: "c", createdBy: 1 }],
    actor: "ann",
  });
  await stamped.post.upsert({
    where: { id: 1 },
    create: { id: 1, title: "a", createdBy: "import" },
    update: { updatedBy: "import" },
    actor: "ann",
  });
  await stamped.post.upsert({
    where: { id: 1 },
    // @ts-expect-error - upsert's create arm is a create
    create: { id: 1, title: "a", createdBy: 1 },
    update: { title: "b" },
    actor: "ann",
  });
  // An update's fields are optional already: they keep their types, update
  // operators included.
  await stamped.post.update({
    where: { id: 1 },
    data: { updatedBy: "import", version: { increment: 5 } },
    actor: "ann",
  });
  await stamped.post.updateMany({
    data: { updatedBy: "import" },
    actor: "ann",
  });
  await stamped.post.update({
    where: { id: 1 },
    // @ts-expect-error - updatedBy is a string
    data: { updatedBy: 1 },
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

export async function nestedCreatesMayLeaveItOut() {
  // `note` requires createdBy, and audit writes it on every create of note.
  await stamped.note.create({ data: { id: 1, text: "x", postId: 1 } });
  await stamped.post.create({
    data: {
      id: 1,
      title: "a",
      notes: {
        create: [
          { id: 1, text: "x" },
          { id: 2, text: "y", createdBy: "m" },
        ],
        createMany: { data: [{ id: 3, text: "z" }] },
        connectOrCreate: { where: { id: 4 }, create: { id: 4, text: "w" } },
      },
    },
    actor: "ann",
  });
  await stamped.post.update({
    where: { id: 1 },
    data: {
      notes: {
        upsert: {
          where: { id: 5 },
          create: { id: 5, text: "v" },
          update: { text: "u", updatedBy: "m" },
        },
        update: { where: { id: 1 }, data: { updatedBy: "m" } },
        updateMany: [{ where: { id: 2 }, data: { createdBy: "import" } }],
      },
    },
    actor: "ann",
  });
  await stamped.post.create({
    data: {
      id: 1,
      title: "a",
      // @ts-expect-error - a value written keeps its type, nested too
      notes: { create: [{ id: 1, text: "x", createdBy: 1 }] },
    },
    actor: "ann",
  });
  // At any depth, item by item: a note under a post under a comment.
  await stamped.comment.create({
    data: {
      id: 1,
      body: "x",
      post: {
        create: {
          id: 3,
          title: "z",
          notes: { create: [{ id: 6, text: "t" }] },
        },
      },
    },
    actor: "ann",
  });
  // A transaction's client is the same client.
  await stamped.$transaction(async (tx) => {
    await tx.post.create({
      data: { id: 1, title: "a", notes: { create: { id: 7, text: "s" } } },
      actor: "ann",
    });
  });
  // The base client still asks for it.
  await base.post.create({
    // @ts-expect-error - createdBy is required on a note
    data: { id: 1, title: "a", notes: { create: { id: 8, text: "r" } } },
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
  // may leave it out, or write it with its own type.
  await stamped.ledger.create({ data: { id: 1 }, actor: "ann" });
  await stamped.ledger.createMany({ data: [{ id: 1 }], actor: "ann" });
  await stamped.ledger.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
    actor: "ann",
  });
  await stamped.ledger.create({ data: { id: 1, owner: "a" }, actor: "a" });
  // @ts-expect-error - owner is a string
  await stamped.ledger.create({ data: { id: 1, owner: 1 }, actor: "a" });
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
  await audited.post.create({ data: { id: 1, title: "a" }, actor: "ann" });
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
  // A version the caller writes wins over the increment.
  await locked.post.update({
    where: { id: 1 },
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

// Two inline declarations on one client: each one's fields are the caller's
// when written.
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
    data: { id: 1, title: "a", tenantId: "globex", createdBy: "import" },
    tenant: "acme",
    actor: "ann",
  });
  await both.post.create({
    // @ts-expect-error - tenantId is a string
    data: { id: 1, title: "a", tenantId: 1 },
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
// nothing: a required field stays required, and a value passed stands.
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
  // Written by hand, it is the caller's: that tenant is written.
  await tenants.article.create({
    data: { id: 1, title: "a", tenantId: "globex" },
    tenant: "acme",
  });
  // A required foreign key: neither it nor its relation is asked for, and
  // either may be written.
  await tenants.reply.create({
    data: { id: 1, body: "b", articleId: 1 },
    tenant: "acme",
  });
  await tenants.reply.create({
    data: { id: 1, body: "b", articleId: 1, tenantId: "globex" },
    tenant: "acme",
  });
  await tenants.reply.create({
    data: { id: 1, body: "b", articleId: 1, tenant: { connect: { id: "x" } } },
    tenant: "acme",
  });
  await tenants.reply.create({
    // @ts-expect-error - the relation keeps its own input
    data: { id: 1, body: "b", articleId: 1, tenant: { connect: { no: "x" } } },
    tenant: "acme",
  });
  // An update writes what the caller writes: tenancy stamps creates only.
  await tenants.reply.update({
    where: { id: 1 },
    data: { tenant: { connect: { id: "globex" } } },
    tenant: "acme",
  });
  // The base client still writes it through the relation.
  await plainTenants.reply.create({
    data: { id: 1, body: "b", articleId: 1, tenant: { connect: { id: "x" } } },
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
  // A nested create may write it, or its relation.
  await tenants.article.create({
    data: {
      id: 1,
      title: "a",
      replies: {
        create: [
          { id: 1, body: "b", tenantId: "globex" },
          { id: 2, body: "c", tenant: { connect: { id: "x" } } },
        ],
      },
    },
    tenant: "acme",
  });
  await tenants.article.create({
    data: {
      id: 1,
      title: "a",
      // @ts-expect-error - tenantId is a string
      replies: { create: [{ id: 1, body: "b", tenantId: 1 }] },
    },
    tenant: "acme",
  });
}
