import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { defineExtension } from "@src/index";
import { tenancy } from "@tests/fixtures/extension-recipes";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * A field the schema requires and an extension writes on create (owner
 * ruling 2, extension-capabilities plan v4 §7.5): the caller leaves it out,
 * at every create site, and the extension writes it. Validation is told, for
 * one parse, which fields the call's create stamps write (`parseStamped`),
 * so its required-field check and its "one of the foreign key or its
 * relation" check count them as given. Everything else refuses as before,
 * with the same message.
 *
 * Fixture: `tenantId` is required everywhere and nothing defaults it. On
 * posts, tags and boards it is a plain column; on comments it is a required
 * foreign key to a tenant row, so a comment's create also passes the key-set
 * check. Boards reach posts and comments through relations with variants (a
 * pinned record and a collection of items). Ledgers have a required
 * `tenantId` that no extension writes. `base` is the same database without
 * the extensions; it seeds and reads back.
 *
 * The calls go through {@link javascript}, as a JavaScript caller makes
 * them: some cells write through a relation with variants, which the client
 * types do not rebuild, and others pass a stamped field on purpose. The
 * typed twin is `tests/types/client/extension-data.core.types.ts`.
 */

export function requiredTenantSchema() {
  const tenant = s.model({
    id: s.string().id(),
    comments: s.toMany(() => comment),
  });
  const post = s.model({
    id: s.int().id(),
    title: s.string(),
    tenantId: s.string(),
    comments: s.toMany(() => comment),
    tags: s.toMany(() => tag),
  });
  const comment = s.model({
    id: s.int().id(),
    body: s.string(),
    tenantId: s.string(),
    tenant: s
      .toOne(() => tenant)
      .fields("tenantId")
      .references("id"),
    postId: s.int().nullable(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  });
  const tag = s.model({
    id: s.int().id(),
    name: s.string(),
    tenantId: s.string(),
    posts: s.toMany(() => post),
  });
  const board = s.model({
    id: s.int().id(),
    tenantId: s.string(),
    pinned: s.toOne({ post: () => post, comment: () => comment }).optional(),
    items: s.toMany({ post: () => post, comment: () => comment }),
  });
  const ledger = s.model({ id: s.int().id(), tenantId: s.string() });
  return { tenant, post, comment, tag, board, ledger };
}

const MODELS = ["post", "comment", "tag", "board"] as const;
const ACME = { tenant: "acme" } as const;

type Call = (args: object) => Promise<unknown>;
type JavaScriptDelegate = Record<
  "create" | "createMany" | "upsert" | "update" | "updateMany",
  Call
>;
type JavaScriptClient = Record<
  "post" | "comment" | "tag" | "board" | "ledger",
  JavaScriptDelegate
> & {
  $transaction: (calls: readonly Promise<unknown>[]) => Promise<unknown>;
};

/**
 * A client as a JavaScript caller sees it, any argument shape: the cells
 * reach what the types refuse or do not rebuild (a stamped field passed on
 * purpose, a create through a relation with variants).
 */
const javascript = (client: object) => client as JavaScriptClient;

/** The tenancy stamp with an optional control: a call without it writes nothing. */
const optionalTenant = defineExtension({
  name: "optionalTenant",
  controls: { tenant: { schema: v.string() } },
  data: {
    models: { post: { create: { tenantId: { control: "tenant" } } } },
  },
});

export async function openRequiredTenantFixture(driver: AnyDriver) {
  const base = createClient({ schema: requiredTenantSchema(), driver });
  await syncLiveSchema(base);
  await base.tenant.create({ data: { id: "acme" } });
  return { base, db: javascript(base.$extends(tenancy(MODELS))) };
}

type Fixture = Awaited<ReturnType<typeof openRequiredTenantFixture>>;

const byId = {
  orderBy: { id: "asc" },
  select: { id: true, tenantId: true },
} as const;
const tenants = (rows: readonly { id: number; tenantId: string }[]) =>
  rows.map((row) => [row.id, row.tenantId]);
const acme = (...ids: number[]) => ids.map((id) => [id, "acme"]);

/** A refusal as a caller reads it: its class, message and issues. */
const refusal = async (pending: Promise<unknown>) => {
  const error = await failure(pending);
  const { name, message, issues } = error as ValidationError;
  return {
    validation: error instanceof ValidationError,
    name,
    message,
    issues,
  };
};

/** Today's refusal of a missing field, byte for byte (measured at 8dce0d121). */
const missing = (path: string, message: string) => ({
  validation: true,
  name: "ValidationError",
  message: `Validation failed for create: ${message}`,
  issues: [{ path, message }],
});
const MISSING_TENANT_ID = missing(
  "data.tenantId",
  "Missing required field: tenantId"
);
const MISSING_TENANT_EDGE = missing(
  "data",
  "Missing required fields: one of tenantId or tenant"
);

export interface StampedRequiredProvider {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}

export function runStampedRequiredBehavior(
  provider: StampedRequiredProvider
): void {
  describe(`${provider.name}: a required field an extension writes`, () => {
    let context: Fixture;

    beforeEach(async () => {
      context = await openRequiredTenantFixture(provider.createDriver());
    });
    afterEach(async () => {
      await context.base.$disconnect();
    });

    /** Each model's rows as [id, tenantId], read without the extensions. */
    const stored = async () => {
      const { base } = context;
      return {
        post: tenants(await base.post.findMany(byId)),
        comment: tenants(await base.comment.findMany(byId)),
        tag: tenants(await base.tag.findMany(byId)),
        board: tenants(await base.board.findMany(byId)),
      };
    };

    test("root create, both createMany forms and upsert's create arm on both routes leave it out: a plain column and a required foreign key", async () => {
      const { db } = context;
      await db.post.create({ data: { id: 1, title: "a" }, ...ACME });
      await db.post.createMany({
        data: [
          { id: 2, title: "b" },
          { id: 3, title: "c" },
        ],
        ...ACME,
      });
      // A row that names a relation takes the record route.
      await db.post.createMany({
        data: [
          { id: 4, title: "d", tags: { create: [{ id: 30, name: "t" }] } },
        ],
        ...ACME,
      });
      await db.post.upsert({
        where: { id: 5 },
        create: { id: 5, title: "e" },
        update: { title: "never" },
        ...ACME,
      });
      await db.$transaction([
        db.post.upsert({
          where: { id: 6 },
          create: { id: 6, title: "f" },
          update: { title: "never" },
          ...ACME,
        }),
      ]);
      await db.comment.create({ data: { id: 10, body: "x" }, ...ACME });
      await db.comment.createMany({ data: [{ id: 11, body: "y" }], ...ACME });
      await db.comment.upsert({
        where: { id: 12 },
        create: { id: 12, body: "z" },
        update: { body: "never" },
        ...ACME,
      });
      await db.comment.upsert({
        where: { id: 13 },
        create: { id: 13, body: "w", post: { connect: { id: 1 } } },
        update: { body: "never" },
        ...ACME,
      });
      expect(await stored()).toEqual({
        post: acme(1, 2, 3, 4, 5, 6),
        comment: acme(10, 11, 12, 13),
        tag: acme(30),
        board: [],
      });
    });

    test("nested create, createMany, connectOrCreate and upsert's create arm leave it out through to-many, to-one and junction relations", async () => {
      const { db } = context;
      await db.post.create({
        data: {
          id: 1,
          title: "a",
          comments: {
            create: [{ id: 10, body: "x" }],
            createMany: { data: [{ id: 11, body: "y" }] },
            connectOrCreate: [
              { where: { id: 12 }, create: { id: 12, body: "z" } },
            ],
          },
          tags: {
            create: [{ id: 30, name: "t" }],
            connectOrCreate: [
              { where: { id: 31 }, create: { id: 31, name: "u" } },
            ],
          },
        },
        ...ACME,
      });
      await db.post.update({
        where: { id: 1 },
        data: {
          comments: {
            upsert: [
              {
                where: { id: 13 },
                create: { id: 13, body: "w" },
                update: { body: "never" },
              },
            ],
          },
          tags: {
            upsert: [
              {
                where: { id: 32 },
                create: { id: 32, name: "v" },
                update: { name: "never" },
              },
            ],
          },
        },
        ...ACME,
      });
      await db.comment.create({
        data: { id: 14, body: "p", post: { create: { id: 2, title: "b" } } },
        ...ACME,
      });
      await db.comment.create({
        data: {
          id: 15,
          body: "q",
          post: {
            connectOrCreate: {
              where: { id: 3 },
              create: { id: 3, title: "c" },
            },
          },
        },
        ...ACME,
      });
      await db.comment.create({ data: { id: 16, body: "r" }, ...ACME });
      await db.comment.update({
        where: { id: 16 },
        data: {
          post: {
            upsert: { create: { id: 4, title: "d" }, update: { title: "e" } },
          },
        },
        ...ACME,
      });
      expect(await stored()).toEqual({
        post: acme(1, 2, 3, 4),
        comment: acme(10, 11, 12, 13, 14, 15, 16),
        tag: acme(30, 31, 32),
        board: [],
      });
    });

    test("a captured row's nested create leaves it out when the series admits it again: a relation-bearing updateMany and a nested updateMany", async () => {
      const { base, db } = context;
      await base.post.create({
        data: {
          id: 1,
          title: "a",
          tenantId: "acme",
          tags: { create: [{ id: 30, name: "t", tenantId: "acme" }] },
        },
      });
      await db.post.updateMany({
        where: { id: 1 },
        data: { title: "b", tags: { create: [{ id: 31, name: "u" }] } },
        ...ACME,
      });
      await db.post.update({
        where: { id: 1 },
        data: {
          tags: {
            updateMany: {
              where: { id: 30 },
              data: { posts: { create: [{ id: 2, title: "c" }] } },
            },
          },
        },
        ...ACME,
      });
      expect(await stored()).toEqual({
        post: acme(1, 2),
        comment: [],
        tag: acme(30, 31),
        board: [],
      });
    });

    test("relations with variants: a pinned record and a collection's create, createMany, connectOrCreate and upsert leave it out", async () => {
      const { db } = context;
      await db.board.create({
        data: {
          id: 1,
          pinned: { create: { type: "comment", data: { id: 10, body: "x" } } },
          items: {
            create: [{ type: "post", data: { id: 1, title: "a" } }],
            createMany: [{ type: "comment", data: [{ id: 11, body: "y" }] }],
            connectOrCreate: [
              {
                type: "post",
                where: { id: 2 },
                create: { id: 2, title: "b" },
              },
            ],
          },
        },
        ...ACME,
      });
      await db.board.update({
        where: { id: 1 },
        data: {
          items: {
            upsert: [
              {
                type: "comment",
                where: { id: 12 },
                create: { id: 12, body: "z" },
                update: { body: "never" },
              },
            ],
          },
        },
        ...ACME,
      });
      expect(await stored()).toEqual({
        post: acme(1, 2),
        comment: acme(10, 11, 12),
        tag: [],
        board: acme(1),
      });
    });

    test("what no stamp writes is still asked for, with today's message: an unextended client, a model the extension does not name, a call without the stamp's control", async () => {
      const { base, db } = context;
      const plain = javascript(base);
      expect(
        await refusal(plain.post.create({ data: { id: 1, title: "a" } }))
      ).toEqual(MISSING_TENANT_ID);
      expect(
        await refusal(plain.comment.create({ data: { id: 1, body: "a" } }))
      ).toEqual(MISSING_TENANT_EDGE);
      expect(
        await refusal(db.ledger.create({ data: { id: 1 }, ...ACME }))
      ).toEqual(MISSING_TENANT_ID);
      const optional = javascript(base.$extends(optionalTenant));
      expect(
        await refusal(optional.post.create({ data: { id: 1, title: "a" } }))
      ).toEqual(MISSING_TENANT_ID);
      await optional.post.create({ data: { id: 1, title: "a" }, ...ACME });
      expect((await stored()).post).toEqual(acme(1));
    });

    test("a caller who writes the field is still refused, at the root and nested", async () => {
      const { db } = context;
      const written = {
        validation: true,
        name: "ValidationError",
        message:
          'Validation failed for create: Field "tenantId" is written by extension "tenancy"',
        issues: [
          {
            path: "data.tenantId",
            message: 'Field "tenantId" is written by extension "tenancy"',
          },
        ],
      };
      expect(
        await refusal(
          db.post.create({
            data: { id: 1, title: "a", tenantId: "globex" },
            ...ACME,
          })
        )
      ).toEqual(written);
      expect(
        await refusal(
          db.post.create({
            data: {
              id: 1,
              title: "a",
              comments: { create: [{ id: 10, body: "x", tenantId: "acme" }] },
            },
            ...ACME,
          })
        )
      ).toEqual(written);
      expect(await stored()).toEqual({
        post: [],
        comment: [],
        tag: [],
        board: [],
      });
    });

    test("a call refused mid-parse leaves no provided field behind: the next unextended create still asks for it", async () => {
      const { base, db } = context;
      const midParse = await refusal(
        db.post.create({
          data: { id: 1, title: "a", comments: { create: [{ id: 10 }] } },
          ...ACME,
        })
      );
      expect(midParse.issues).toEqual([
        {
          path: "data.comments.create",
          message:
            "Value did not match any union member: Expected object, Missing required field: body",
        },
      ]);
      expect(
        await refusal(
          javascript(base).post.create({ data: { id: 1, title: "a" } })
        )
      ).toEqual(MISSING_TENANT_ID);
    });
  });
}
