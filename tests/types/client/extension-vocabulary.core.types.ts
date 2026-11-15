/**
 * Spelling 1: `client.$extends(extension("n", call((c) => …), rule({ … })))`.
 * Every handler's types come from the client `$extends` is called on,
 * inferred from the type `$extends` expects back through `extension` and
 * each part. Typo probes sit beside a real key (AGENTS.md, "Testing a DX
 * Claim").
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
  call,
  defaults,
  deletes,
  extension,
  fields,
  keep,
  methods,
  now,
  omitted,
  oneOf,
  type Run,
  rule,
  target,
  unless,
  when,
} from "@src/index";
import type { PendingOperation } from "@src/query-engine/pending-operation";
import { v } from "@validation/primitives/v";
import { expectTypeOf } from "vitest";
import { base } from "./extension-vocabulary.fixture";

type Base = typeof base;
type PostFindMany = NonNullable<Parameters<Base["post"]["findMany"]>[0]>;

// =============================================================================
// 1. A call on one model and one operation
// =============================================================================

const _oneOperation = base.$extends(
  extension(
    "one-operation",
    around(
      (c) => {
        expectTypeOf(c.model).toEqualTypeOf<"post">();
        expectTypeOf(c.operation).toEqualTypeOf<"findMany">();
        expectTypeOf(c.args).not.toBeAny();
        c.args.where?.title;
        // @ts-expect-error - "ttitle" is not a field of post
        c.args.where?.ttitle;
        // The call's arguments are shown whole, select included (spec 12.6).
        c.args.select;
        c.set({ take: 10, where: { title: "x" } });
        // @ts-expect-error - a patch cannot replace the caller's select
        c.set({ take: 10, select: { id: true } });
        // @ts-expect-error - "tkae" is refused beside the real "take"
        c.set({ take: 10, tkae: 1 });
        const held = { take: 10, include: { author: true } };
        // @ts-expect-error - a held patch naming include is refused too
        c.set(held);
        return async (run) => {
          expectTypeOf(run).not.toBeAny();
          const rows = await run();
          return rows;
        };
      },
      target("post", "findMany")
    )
  )
);

// `call` alone is the first moment: it patches or refuses, before validation.
const _momentOne = base.$extends(
  extension(
    "moment-one",
    call(
      (c) => {
        c.set({ take: 10 });
        // @ts-expect-error - "tkae" is refused beside the real "take"
        c.set({ take: 10, tkae: 1 });
      },
      target("post", "findMany")
    ),
    // Without a target, a call sees raw statements too, told apart by `kind`.
    call((c) => {
      if (c.kind === "raw") throw new Error("no raw statements");
    })
  )
);

// The second moment's result is the operation's on THIS client: written out
// with the client's own result type, it compiles…
const _resultOnThisClient = base.$extends(
  extension(
    "named-result",
    around(
      () =>
        async <A extends PostFindMany>(
          run: Run<A, OperationResultOf<Base, "post", "findMany", A>>
        ) =>
          run(),
      target("post", "findMany")
    )
  )
);

// …and a call cannot invent a result.
const _inventedResult = base.$extends(
  extension(
    "invented",
    around(
      // @ts-expect-error - the second moment returns run()'s result, not another
      () => async () => [{ title: "invented" }],
      target("post", "findMany")
    )
  )
);

// On a client whose chain hides users, the same call reads `author` as
// nullable: annotating the base client's result type no longer fits.
const hiddenUsers = base.$extends(
  extension(
    "hide-users",
    rule({ user: { read: { where: { tenantId: "t" } } } })
  )
);
type Hidden = typeof hiddenUsers;
type _authorNullableThere = Expect<
  Equal<
    OperationResultOf<
      Hidden,
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
const _hiddenResult = hiddenUsers.$extends(
  extension(
    "hidden-result",
    around(
      () =>
        async <A extends PostFindMany>(
          run: Run<A, OperationResultOf<Hidden, "post", "findMany", A>>
        ) =>
          run(),
      target("post", "findMany")
    )
  )
);
// No negative probe here: annotated with the BASE client's result, the same
// handler also compiles. TypeScript relates the two results, both deferred
// on the generic `A`, without telling them apart; that is TypeScript's
// limit, not the contract's. The positive probe above and the concrete one
// before it are the evidence.

// A misspelt model or operation in `on` is refused at its place.
const _badSelector = base.$extends(
  extension(
    "bad-selector",
    call(
      () => undefined,
      // @ts-expect-error - "pots" is not a model
      target("pots", "findMany")
    )
  )
);
const _badOperation = base.$extends(
  extension(
    "bad-operation",
    call(
      () => undefined,
      // @ts-expect-error - "findMnay" is not an operation
      target("post", "findMnay")
    )
  )
);

// =============================================================================
// 2. A generic call over every model keeps each operation's result
// =============================================================================

const timed = base.$extends(
  extension(
    "timing",
    around((c) => {
      // Without `on`: every model and the raw statements.
      expectTypeOf(c.kind).toEqualTypeOf<"model" | "raw">();
      expectTypeOf(c.operation).toEqualTypeOf<
        | Operations
        | "$queryRaw"
        | "$executeRaw"
        | "$queryRawUnsafe"
        | "$executeRawUnsafe"
      >();
      expectTypeOf(c.model).toEqualTypeOf<
        "user" | "post" | "comment" | undefined
      >();
      return async (run) => {
        const result = await run();
        return result;
      };
    })
  )
);
const _genericInvents = base.$extends(
  extension(
    "generic-invents",
    // @ts-expect-error - one result cannot fit every operation
    around(() => async (run) => {
      await run();
      return 42;
    })
  )
);
type _genericKeepsResults = Expect<
  Equal<
    Awaited<
      ReturnType<typeof timed.post.findMany<{ include: { author: true } }>>
    >,
    Awaited<
      ReturnType<typeof base.post.findMany<{ include: { author: true } }>>
    >
  >
>;

// =============================================================================
// 3. args: the extended client's calls take them, typed, where placed
// =============================================================================

const tenancy = base.$extends(
  extension(
    "tenancy",
    args({
      tenant: accepts(v.string()),
      deleted: oneOf("without", "with", "only").default("without"),
      mode: oneOf("soft", "hard").on(deletes),
    })
  )
);
tenancy.post.findMany({ tenant: "t", deleted: "only" });
tenancy.post.delete({ where: { id: "p" }, mode: "hard", tenant: "t" });
// @ts-expect-error - "nope" is not a value of deleted
tenancy.post.findMany({ deleted: "nope" });
// @ts-expect-error - tenant is a string
tenancy.post.findMany({ tenant: 1 });
// @ts-expect-error - "delted" is refused beside the real "deleted"
tenancy.post.findMany({ deleted: "only", delted: "only" });
// @ts-expect-error - mode is placed on deletes only
tenancy.post.findMany({ mode: "hard" });
// @ts-expect-error - the client before the extension takes no such argument
base.post.findMany({ tenant: "t" });

// =============================================================================
// 4. rule and defaults: names checked at their place; rows and data reach the client
// =============================================================================

const tenanted = base.$extends(
  extension(
    "tenant-rule",
    args({ tenant: accepts(v.string()) }),
    rule({
      user: { read: { where: { tenantId: arg("tenant") } } },
      post: { read: { where: { tenantId: arg("tenant") } } },
    }),
    defaults({ post: { create: { tenantId: arg("tenant") } } })
  )
);

const _misspeltModel = base.$extends(
  extension(
    "misspelt-model",
    args({ tenant: accepts(v.string()) }),
    rule({
      post: { read: { where: { tenantId: arg("tenant") } } },
      // @ts-expect-error - "pots" is not a model, beside the real "post"
      pots: { read: { where: { tenantId: arg("tenant") } } },
    })
  )
);
const _misspeltField = base.$extends(
  extension(
    "misspelt-field",
    args({ tenant: accepts(v.string()) }),
    rule({
      post: {
        read: {
          // @ts-expect-error - "tenatId" is not a field, beside the real "tenantId"
          where: { tenantId: arg("tenant"), tenatId: arg("tenant") },
        },
      },
    })
  )
);
const _misspeltDataField = base.$extends(
  extension(
    "misspelt-data-field",
    args({ tenant: accepts(v.string()) }),
    defaults({
      post: {
        // @ts-expect-error - "tenatId" is not a field, beside the real "tenantId"
        create: { tenantId: arg("tenant"), tenatId: arg("tenant") },
      },
    })
  )
);
const _misspeltArgument = base.$extends(
  extension(
    "misspelt-argument",
    args({ tenant: accepts(v.string()) }),
    rule({
      post: {
        read: {
          where: {
            title: arg("tenant"),
            // @ts-expect-error - "tenat" is not an argument, beside the real "tenant"
            tenantId: arg("tenat"),
          },
        },
      },
    })
  )
);
const _misspeltEntry = base.$extends(
  extension(
    "misspelt-entry",
    rule({
      post: {
        read: { where: { title: "x" } },
        // @ts-expect-error - "raed" is not a rule entry, beside the real "read"
        raed: { where: { title: "x" } },
      },
    })
  )
);
const _operatorWord = base.$extends(
  extension(
    "operator-word",
    args({ deleted: oneOf("without", "with", "only").default("without") }),
    rule({
      post: {
        root: [
          when(arg("deleted"), "without", { deletedAt: null }),
          when(arg("deleted"), "only", { deletedAt: { not: null } }),
        ],
        related: unless(arg("deleted"), "with", { deletedAt: null }),
        delete: { instead: keep({ deletedAt: now }) },
      },
    })
  )
);
const _misspeltWhen = base.$extends(
  extension(
    "misspelt-when",
    args({ deleted: oneOf("without", "with", "only").default("without") }),
    rule({
      post: {
        root: when(arg("deleted"), "without", {
          deletedAt: null,
          // @ts-expect-error - "deltedAt" is refused beside the real "deletedAt"
          deltedAt: null,
        }),
      },
    })
  )
);

// A to-one relation to a model whose rows a rule can hide reads `| null`.
const _nullableAuthor = async () => {
  const [row] = await tenanted.post.findMany({ include: { author: true } });
  expectTypeOf(row!.author).toEqualTypeOf<{
    id: string;
    tenantId: string;
    firstName: string;
    lastName: string;
    passwordHash: string;
  } | null>();
  const [baseRow] = await base.post.findMany({ include: { author: true } });
  expectTypeOf(baseRow!.author).not.toBeNullable();
};

// A field `defaults` writes on create is optional there, root and nested.
tenanted.post.create({
  data: { title: "t", author: { connect: { id: "u" } } },
});
tenanted.user.create({
  data: {
    tenantId: "t",
    firstName: "a",
    lastName: "b",
    passwordHash: "h",
    posts: { create: { title: "nested" } },
  },
});
base.post.create({
  // @ts-expect-error - without the default, tenantId is required
  data: { title: "t", author: { connect: { id: "u" } } },
});
base.user.create({
  data: {
    tenantId: "t",
    firstName: "a",
    lastName: "b",
    passwordHash: "h",
    // @ts-expect-error - without the default, a nested post requires tenantId
    posts: { create: { title: "nested" } },
  },
});

// =============================================================================
// 5. defaults fields: omitted, the eighth fact (default omission)
// =============================================================================

const hidesHash = base.$extends(
  extension("omit", defaults({ user: { fields: { passwordHash: omitted } } }))
);
const _omittedResults = async () => {
  const [row] = await hidesHash.user.findMany();
  expectTypeOf(row!).toEqualTypeOf<{
    id: string;
    tenantId: string;
    firstName: string;
    lastName: string;
  }>();
  const [withAuthor] = await hidesHash.post.findMany({
    include: { author: true },
  });
  expectTypeOf(withAuthor!.author).toEqualTypeOf<{
    id: string;
    tenantId: string;
    firstName: string;
    lastName: string;
  }>();
  const [back] = await hidesHash.user.findMany({
    omit: { passwordHash: false },
  });
  expectTypeOf(back!.passwordHash).toEqualTypeOf<string>();
  const [selected] = await hidesHash.user.findMany({
    select: { passwordHash: true },
  });
  expectTypeOf(selected!).toEqualTypeOf<{ passwordHash: string }>();
};
const _misspeltOmit = base.$extends(
  extension(
    "misspelt-omit",
    defaults({
      user: {
        fields: {
          passwordHash: omitted,
          // @ts-expect-error - "passwordHsh" is refused beside the real "passwordHash"
          passwordHsh: omitted,
        },
      },
    })
  )
);

// =============================================================================
// 6. methods: client methods and model methods typed by `this`
// =============================================================================

type RestoreArgs = { readonly where: { readonly id: string } };
declare const restore: <
  Self,
  const A extends DelegateOperationArgs<Self, RestoreArgs>,
>(
  this: Self,
  args: A
) => PendingOperation<DelegateOperationResult<Self, "update", A>>;
declare const as: <Self>(this: Self, tenant: string) => Self;

const withMethods = tenanted.$extends(
  extension(
    "methods",
    methods(() => ({
      $as: as,
      $ping: () => "pong" as const,
      post: { restore },
    }))
  )
);
const _methodResults = async () => {
  expectTypeOf(withMethods.$ping()).toEqualTypeOf<"pong">();
  expectTypeOf(withMethods.$as("t")).toEqualTypeOf<typeof withMethods>();
  const restored = await withMethods.post.restore({
    where: { id: "p" },
    include: { author: true },
  });
  // Typed from the delegate it is called on: the rule before it hides users.
  expectTypeOf(restored.author).toBeNullable();
  // A later rule reaches it too.
  const omittedAfter = withMethods.$extends(
    extension(
      "omit-after",
      defaults({ user: { fields: { passwordHash: omitted } } })
    )
  );
  const again = await omittedAfter.post.restore({
    where: { id: "p" },
    include: { author: true },
  });
  expectTypeOf(again.author).toEqualTypeOf<{
    id: string;
    tenantId: string;
    firstName: string;
    lastName: string;
  } | null>();
};

// A factory reading the typed scope is a result consumer: a later rule that
// hides rows is refused, as today.
const consumer = base.$extends(
  extension(
    "consumer",
    methods((scope) => ({
      $count: () => scope.post.count(),
    }))
  )
);
expectTypeOf(consumer.$count()).not.toBeAny();
consumer.$extends(
  // @ts-expect-error - a rule hiding rows after a result consumer
  extension(
    "hide-after",
    rule({ user: { read: { where: { tenantId: "t" } } } })
  )
);

// =============================================================================
// 7. fields: compute reads exactly its needs
// =============================================================================

const named = base.$extends(
  extension(
    "full-name",
    fields({
      user: {
        fullName: {
          needs: { firstName: true, lastName: true },
          compute: (u) => {
            // @ts-expect-error - tenantId is not among the needs
            u.tenantId;
            return `${u.firstName} ${u.lastName}`;
          },
        },
      },
    })
  )
);
const _computed = async () => {
  const [row] = await named.user.findMany();
  expectTypeOf(row!.fullName).toEqualTypeOf<string>();
  const [selected] = await named.user.findMany({ select: { fullName: true } });
  expectTypeOf(selected!).toEqualTypeOf<{ fullName: string }>();
};
const _misspeltNeed = base.$extends(
  extension(
    "misspelt-need",
    fields({
      user: {
        fullName: {
          // @ts-expect-error - "frstName" is refused beside the real "firstName"
          needs: { firstName: true, frstName: true },
          compute: (u) => u.firstName,
        },
      },
    })
  )
);

// =============================================================================
// 8. Two extensions: the second names an argument the first declares
// =============================================================================

const first = base.$extends(
  extension("first", args({ tenant: accepts(v.string()) }))
);
const second = first.$extends(
  extension(
    "second",
    rule({ post: { read: { where: { tenantId: arg("tenant") } } } })
  )
);
second.post.findMany({ tenant: "t" });
const _unknownInSecond = first.$extends(
  extension(
    "unknown-in-second",
    rule({
      post: {
        read: {
          where: {
            title: arg("tenant"),
            // @ts-expect-error - "actor" is declared by no extension of the chain
            tenantId: arg("actor"),
          },
        },
      },
    })
  )
);
// A call reads its own extension's arguments as `values`.
const _ownValues = base.$extends(
  extension(
    "own-values",
    args({ tenant: accepts(v.string()) }),
    call(
      (c) => {
        expectTypeOf(c.values).toEqualTypeOf<{ readonly tenant?: string }>();
      },
      target("post", "findMany")
    )
  )
);

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
