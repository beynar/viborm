/**
 * Extensions written apart from the client they are applied to, and the
 * words a rule takes there. Three spellings: inline in `$extends` (typed
 * against that client, `extension-vocabulary.core.types.ts`); bound to a
 * schema or a client type with `parts<Of>()`; and schema-generic, a function
 * of model names returning an extension for any client that has them (the
 * guide's recipes). Each claim has its probe beside a real key (root
 * `AGENTS.md`, "Testing a DX Claim").
 *
 * Nothing in this file is called. Only the types matter.
 */

import {
  accepts,
  arg,
  args,
  check,
  type ExtendedClient,
  extension,
  gate,
  lazy,
  oneOf,
  only,
  parts,
  rule,
  when,
} from "@src/index";
import { v } from "@src/validation";
import { expectTypeOf } from "vitest";
import { audit, tenancy } from "../../fixtures/extension-recipes";
import { base, type schema } from "./extension-vocabulary.fixture";

// =============================================================================
// Schema-generic: a function of model names (the recipes)
// =============================================================================

const tenanted = base.$extends(tenancy(["post", "comment"]));
// What the recipe adds reaches the client: its argument, typed and required…
tenanted.post.findMany({ tenant: "acme" });
// @ts-expect-error - the tenant is a string
tenanted.post.findMany({ tenant: 1 });
// …and the field it writes on create, left out though the schema requires it.
tenanted.post.create({
  data: { id: "p", title: "t", authorId: "u" },
  tenant: "acme",
});
// A model it does not name keeps its required field.
tenanted.user.create({
  // @ts-expect-error - user is not named: its tenantId is still required
  data: { id: "u", firstName: "a", lastName: "b", passwordHash: "h" },
});
// Its model names are checked where it meets the client.
// @ts-expect-error - "pots" is not a model of this client, beside the real "post"
base.$extends(tenancy(["post", "pots"]));
// A list whose names the types cannot read is refused: a field written on
// create would be optional on every model.
declare const names: string[];
// @ts-expect-error - a plain string[] names no model the client can check
base.$extends(audit(names));
// Two recipes on one client keep each one's arguments.
base
  .$extends(tenancy(["post"]))
  .$extends(audit(["post"]))
  .post.create({
    data: { id: "p", title: "t", authorId: "u" },
    tenant: "acme",
    actor: "ann",
  });
// A recipe names its client in a tuple as `$extends` makes it.
const postTenancy = tenancy(["post"]);
const postTenanted = base.$extends(postTenancy);
expectTypeOf<
  ExtendedClient<typeof base, readonly [typeof postTenancy]>
>().toEqualTypeOf<typeof postTenanted>();

// =============================================================================
// Bound to the schema: parts written alone
// =============================================================================

const typed = parts<typeof schema>();

// A bound part written alone types its literal against the schema: a word
// inside it reads the model's filter.
const checks = typed.rule({
  post: { create: { check: check({ tenantId: "acme" }) } },
});
base.$extends(extension("checks", checks));
typed.rule({
  post: {
    create: {
      // @ts-expect-error - "tenatId" is not a field of post, beside the real one
      check: check({ tenantId: "acme", tenatId: "acme" }),
    },
  },
});
typed.defaults({
  post: {
    create: {
      tenantId: "acme",
      // @ts-expect-error - "tenatId" is refused beside the real "tenantId"
      tenatId: "acme",
    },
  },
});
typed.fields({
  user: {
    fullName: {
      needs: { firstName: true, lastName: true },
      compute: (row) => `${row.firstName} ${row.lastName}`,
    },
    initials: {
      // @ts-expect-error - "fristName" is not a field of user, beside a real one
      needs: { firstName: true, fristName: true },
      compute: () => "",
    },
  },
});

// =============================================================================
// rule((schema) => entries): a rule read from the schema where it is applied
// =============================================================================

base.$extends(
  extension(
    "from-schema",
    rule((applied) => {
      expectTypeOf(applied).toHaveProperty("post");
      return { post: { read: { where: { title: "x" } } } };
    })
  )
);
base.$extends(
  extension(
    "from-schema-typo",
    // @ts-expect-error - "ttitle" is refused beside the real "title" (at the function: its returned entries are checked whole)
    rule(() => ({
      post: {
        read: {
          where: {
            title: "x",
            ttitle: "x",
          },
        },
      },
    }))
  )
);
// Entries built for every model at once hide every model's rows: each
// to-one relation reads `| null`.
const everywhere = base.$extends(
  extension(
    "every-model",
    rule(() => ({}) as Readonly<Record<string, { read: { where: object } }>>)
  )
);
const _everywhere = async () => {
  const [row] = await everywhere.post.findMany({ include: { author: true } });
  expectTypeOf(row!.author).toBeNullable();
};

// =============================================================================
// Words held apart from a rule, and words under a relation
// =============================================================================

// A word written in a shared constant is accepted in its wide form; the
// rule's model admits it where the extension is applied.
const owned = check({ authorId: "u" });
const theirs = only({ authorId: "u" });
const later = lazy(() => ({ read: { where: { postId: "p" } } }));
const visible = gate({ authorId: "u" });
const mine = when(arg("mode"), "own", { authorId: "u" });
const _modes = [when(arg("mode"), "own", { authorId: "u" })];
_modes.push(when(arg("mode"), "all", { id: { in: [] } }));
base.$extends(
  extension(
    "held",
    args({ mode: oneOf("own", "all").default("own") }),
    rule({
      post: {
        root: mine,
        related: _modes,
        read: { fields: { title: visible } },
        update: { where: theirs, check: owned },
        delete: { where: theirs },
      },
      comment: later,
    })
  )
);

// A relation's filter takes words in its target's fields, to three
// relations deep, under is/some/... or directly on a to-one.
base.$extends(
  extension(
    "relations",
    args({ tenant: accepts(v.string()) }),
    rule({
      post: {
        read: {
          where: {
            author: { is: { tenantId: arg("tenant") } },
            comments: {
              some: { post: { author: { tenantId: arg("tenant") } } },
            },
          },
        },
      },
      comment: {
        root: when(
          arg("tenant"),
          { exists: true },
          {
            post: { author: { is: { tenantId: arg("tenant") } } },
          }
        ),
      },
    })
  )
);
base.$extends(
  extension(
    "relation-typo",
    args({ tenant: accepts(v.string()) }),
    rule({
      post: {
        read: {
          where: {
            author: {
              is: {
                tenantId: arg("tenant"),
                // @ts-expect-error - "tenatId" is not a field of user, beside the real one
                tenatId: arg("tenant"),
              },
            },
          },
        },
      },
    })
  )
);
base.$extends(
  extension(
    "relation-argument-typo",
    args({ tenant: accepts(v.string()) }),
    rule({
      post: {
        read: {
          where: {
            title: "x",
            author: {
              is: {
                firstName: arg("tenant"),
                // Pinned, compiles: under a relation an argument's name is
                // checked where the extension is applied (spec 13,
                // correction 5), not on the string. The field's name is
                // (above).
                tenantId: arg("tenat"),
              },
            },
          },
        },
      },
    })
  )
);

// =============================================================================
// Clients that stay assignable
// =============================================================================

// A client the cache extends is still the client before it.
declare const cachedClient: ExtendedClient<
  typeof base,
  readonly [ReturnType<typeof import("@src/cache/exports").cache>]
>;
export const stillBase: typeof base = cachedClient;
// A client written with its plain config names a client `createClient` made.
export const plain: import("@src/index").VibORMClient<
  import("@src/index").VibORMConfig<typeof schema>
> = base;
