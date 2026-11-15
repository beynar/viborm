/**
 * Spelling 2: the vocabulary bound to a schema (`parts<typeof schema>()`) or
 * to a client type (`parts<typeof client>()`), for an extension written apart
 * from the `$extends` it is passed to. The call site is still
 * `client.$extends(extension)` (owner's decision D11). Only `extension` is
 * taken from the binder: the free parts inside it read the target from it.
 */

import type { Operations } from "@client/types";
import type {
  DelegateOperationArgs,
  DelegateOperationResult,
  ExtendedOperationResult as OperationResultOf,
} from "@src/index";
import {
  accepts,
  arg,
  args,
  around,
  type CallResult,
  defaults,
  deletes,
  extension,
  fields,
  methods,
  omitted,
  oneOf,
  parts,
  type Run,
  rule,
  type TargetOf,
  target,
} from "@src/index";
import type { PendingOperation } from "@src/query-engine/pending-operation";
import { v } from "@validation/primitives/v";
import { expectTypeOf } from "vitest";
import { base, type schema } from "./extension-vocabulary.fixture";

type Base = typeof base;
type PostFindMany = NonNullable<Parameters<Base["post"]["findMany"]>[0]>;

// =============================================================================
// 2a. Bound to the schema: written once, applied to any client of it
// =============================================================================

const forSchema = parts<typeof schema>();

const oneOperation = forSchema.extension(
  "one-operation",
  around(
    (c) => {
      expectTypeOf(c.model).toEqualTypeOf<"post">();
      expectTypeOf(c.operation).toEqualTypeOf<"findMany">();
      c.args.where?.title;
      // @ts-expect-error - "ttitle" is not a field of post
      c.args.where?.ttitle;
      // @ts-expect-error - "tkae" is refused beside the real "take"
      c.set({ take: 10, tkae: 1 });
      return async (run) => run();
    },
    target("post", "findMany")
  )
);
base.$extends(oneOperation);

const tenancy = forSchema.extension(
  "tenancy",
  args({
    tenant: accepts(v.string()),
    deleted: oneOf("without", "with", "only").default("without"),
    mode: oneOf("soft", "hard").on(deletes),
  }),
  rule({
    user: { read: { where: { tenantId: arg("tenant") } } },
    post: { read: { where: { tenantId: arg("tenant") } } },
  }),
  defaults({ post: { create: { tenantId: arg("tenant") } } })
);
const tenanted = base.$extends(tenancy);
tenanted.post.findMany({ tenant: "t", deleted: "only" });
// @ts-expect-error - "delted" is refused beside the real "deleted"
tenanted.post.findMany({ deleted: "only", delted: "only" });
tenanted.post.create({
  data: { title: "t", author: { connect: { id: "u" } } },
});
const _nullableAuthor = async () => {
  const [row] = await tenanted.post.findMany({ include: { author: true } });
  expectTypeOf(row!.author).toBeNullable();
};

const _misspelt = forSchema.extension(
  "misspelt",
  args({ tenant: accepts(v.string()) }),
  rule({
    post: {
      read: {
        where: {
          tenantId: arg("tenant"),
          // @ts-expect-error - "tenatId" is refused beside the real "tenantId"
          tenatId: arg("tenant"),
        },
      },
    },
    // @ts-expect-error - "pots" is not a model, beside the real "post"
    pots: { read: { where: { title: "x" } } },
  })
);
const _misspeltArgument = forSchema.extension(
  "misspelt-argument",
  args({ tenant: accepts(v.string()) }),
  rule({
    post: {
      read: {
        where: {
          title: arg("tenant"),
          // @ts-expect-error - "tenat" is refused beside the real "tenant"
          tenantId: arg("tenat"),
        },
      },
    },
  })
);

const hidesHash = base.$extends(
  forSchema.extension(
    "omit",
    defaults({ user: { fields: { passwordHash: omitted } } })
  )
);
const _omittedResult = async () => {
  const [row] = await hidesHash.user.findMany();
  expectTypeOf(row!).not.toHaveProperty("passwordHash");
};

type RestoreArgs = { readonly where: { readonly id: string } };
declare const restore: <
  Self,
  const A extends DelegateOperationArgs<Self, RestoreArgs>,
>(
  this: Self,
  args: A
) => PendingOperation<DelegateOperationResult<Self, "update", A>>;
const withMethods = tenanted.$extends(
  forSchema.extension(
    "methods",
    methods(() => ({ post: { restore } }))
  )
);
const _restored = async () => {
  const row = await withMethods.post.restore({
    where: { id: "p" },
    include: { author: true },
  });
  expectTypeOf(row.author).toBeNullable();
};

const named = base.$extends(
  forSchema.extension(
    "full-name",
    fields({
      user: {
        fullName: {
          needs: { firstName: true, lastName: true },
          compute: (u) => `${u.firstName} ${u.lastName}`,
        },
      },
    })
  )
);
const _computed = async () => {
  const [row] = await named.user.findMany({ select: { fullName: true } });
  expectTypeOf(row!).toEqualTypeOf<{ fullName: string }>();
};

// What binding to the schema loses. The chain the extension will follow is
// unknown, so:
// (1) an argument an earlier extension declares cannot be named;
const first = base.$extends(
  extension("first", args({ tenant: accepts(v.string()) }))
);
first.$extends(
  forSchema.extension(
    "second",
    rule({
      post: {
        read: {
          where: {
            title: "x",
            // Declared by the chain, unknown to a part bound to the schema: the
            // name is checked where the extension is applied (D7).
            tenantId: arg("tenant"),
          },
        },
      },
    })
  )
);
// (2) every to-one relation reads `| null` in the second moment, as if any
// earlier rule could hide its target.
type _pessimistic = Expect<
  Equal<
    CallResult<
      TargetOf<typeof schema>,
      "post",
      "findMany",
      { include: { author: true } }
    >[number]["author"],
    | OperationResultOf<
        Base,
        "post",
        "findMany",
        { include: { author: true } }
      >[number]["author"]
    | null
  >
>;
// (3) the generic call's operation list is the same; its result stays opaque.
const _generic = forSchema.extension(
  "generic",
  around((c) => {
    expectTypeOf(c.operation).toEqualTypeOf<
      | Operations
      | "$queryRaw"
      | "$executeRaw"
      | "$queryRawUnsafe"
      | "$executeRawUnsafe"
    >();
    return async (run) => run();
  })
);

// =============================================================================
// 2b. Bound to a client type: the chain is known, nothing is lost
// =============================================================================

const forFirst = parts<typeof first>();
const second = first.$extends(
  forFirst.extension(
    "second",
    rule({ post: { read: { where: { tenantId: arg("tenant") } } } }),
    around(
      () =>
        async <A extends PostFindMany>(
          run: Run<A, OperationResultOf<typeof first, "post", "findMany", A>>
        ) =>
          run(),
      target("post", "findMany")
    )
  )
);
second.post.findMany({ tenant: "t" });
// A client-typed extension applies to that client only: on the base client,
// the argument it names is missing.
// @ts-expect-error - the base client declares no "tenant"
base.$extends(forFirst.extension("second", rule({ post: {} })));

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
