/**
 * Public type falsifiers for client extensions.
 *
 * Every probe enters through an API a caller imports: the root entry point,
 * a concrete client, or a driver wrapper, and writes an extension as
 * `client.$extends(extension(name, ...parts))`. Typo probes put the typo
 * beside a real key and cover both fresh and held values. No internal
 * extension type is named here.
 *
 * Nothing in this file is called. Only the types matter.
 */

import {
  createClient as createPGliteClient,
  PGliteDriver,
} from "@drivers/pglite";
import {
  args,
  around,
  call,
  createClient,
  type ExtendedClient,
  type ExtensionContributionState,
  extension,
  methods,
  oneOf,
  parts,
  s,
  settled,
  target,
} from "@src/index";
import { expectTypeOf } from "vitest";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;

const author = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post).name("author"),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
  views: s.int(),
  published: s.boolean(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .name("author")
    .fields("authorId")
    .references("id"),
});

const node = s.model({
  id: s.string().id(),
  label: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .name("tree")
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => node).name("tree"),
});

const note = s.model({ id: s.string().id(), body: s.string() });
const image = s.model({ id: s.string().id(), url: s.string() });
const board = s.model({
  id: s.string().id(),
  pinned: s.toOne(
    { note: () => note, image: () => image },
    { values: { note: "extension.note.v1", image: "extension.image.v1" } }
  ),
});

const audit = s.model({ id: s.string().id() });

const schema = { author, post, node, note, image, board, $audit: audit };

const baseClient = () => createClient({ schema, driver: new PGliteDriver() });

// `$extends` takes an extension value, nothing else (owner rule D11): the
// client factory of 1.14 is gone.
function _onlyExtensionValues() {
  const base = baseClient();
  const factory = (client: typeof base) => client;
  // @ts-expect-error - a function of the client is not an extension
  base.$extends(factory);
  // @ts-expect-error - nor is an arbitrary value
  base.$extends(42);
  expectTypeOf<
    ExtendedClient<typeof base, [typeof factory]>
  >().toEqualTypeOf<never>();
}

// =============================================================================
// PUBLIC DEFINITIONS — inline, written apart, and bound to the schema
// =============================================================================

const _inlineContextualTyping = () =>
  baseClient().$extends(
    extension(
      "inline-context",
      call(
        (c) => {
          expectTypeOf(c.model).toEqualTypeOf<"post">();
          expectTypeOf(c.operation).toEqualTypeOf<"findMany">();
          expectTypeOf(c.args).not.toBeAny();
          c.args.where;
          // @ts-expect-error - the call's arguments are shallow readonly
          c.args.take = 1;

          c.set({ where: { published: true } });
        },
        target("post", "findMany")
      ),
      around(
        (c) => {
          expectTypeOf(c.model).toEqualTypeOf<"post">();
          expectTypeOf(c.operation).toEqualTypeOf<"findMany">();
          expectTypeOf(c.kind).toEqualTypeOf<"model">();
          settled(c, (outcome) => {
            expectTypeOf(outcome.certainty).toEqualTypeOf<
              "committed" | "may-have-committed"
            >();
          });
          return async (run) => {
            expectTypeOf(run.mode).toEqualTypeOf<
              "direct" | "transaction" | "array"
            >();
            run.input.where?.title;
            // @ts-expect-error - "ttitle" is not a field of post
            run.input.where?.ttitle;
            return run();
          };
        },
        target("post", "findMany")
      ),
      methods((scope) => {
        scope.post.findMany({ where: { published: true } });
        scope.$transaction([scope.post.count()]);
        return {
          $postCount: () => scope.post.count(),
          post: {
            findPublished: () =>
              scope.post.findMany({ where: { published: true } }),
          },
        };
      })
    )
  );

/**
 * The all-call form has one opaque result. It may return only the value its
 * `run()` owns; it cannot invent one result that claims to fit every
 * operation and schema. Without a target it also sees raw statements, told
 * apart by `kind`.
 */
const genericQueryExtension = extension(
  "generic-query",
  around((c) => {
    expectTypeOf(c.operation).not.toBeAny();
    expectTypeOf(c.args).not.toBeAny();
    if (c.kind === "model") {
      expectTypeOf(c.model).toEqualTypeOf<string>();
      settled(c, (outcome) => {
        expectTypeOf(outcome.certainty).toEqualTypeOf<
          "committed" | "may-have-committed"
        >();
      });
    } else {
      expectTypeOf(c.model).toEqualTypeOf<undefined>();
      expectTypeOf(c.operation).toEqualTypeOf<
        "$queryRaw" | "$executeRaw" | "$queryRawUnsafe" | "$executeRawUnsafe"
      >();
      // @ts-expect-error - a raw statement has no arguments to set
      c.set({});
    }
    return async (run) => {
      expectTypeOf(run.input).toEqualTypeOf<Readonly<unknown>>();
      expectTypeOf(run.mode).toEqualTypeOf<
        "direct" | "transaction" | "array"
      >();
      return run();
    };
  })
);

const _genericQueryAppliesToAConcreteClient = () =>
  baseClient().$extends(genericQueryExtension);

const _genericQueryCannotFabricateOneUniversalResult = extension(
  "generic-query-fabrication",
  // @ts-expect-error - a string cannot stand in for the opaque result of every call
  around(() => async (run) => {
    await run();
    return "fabricated";
  })
);

// A plain `call` sees model calls only.
const _plainCallSeesModels = extension(
  "plain-call",
  call((c) => {
    expectTypeOf(c.kind).toEqualTypeOf<"model">();
    expectTypeOf(c.args.where).toEqualTypeOf<unknown>();
    // Every argument is shown (spec §12.6); setting one that decides the
    // result's shape is refused.
    expectTypeOf(c.args.select).toEqualTypeOf<unknown>();
    c.set({ where: c.args.where });
  })
);

const _genericRequestFreshProtectedPatch = extension(
  "generic-request-fresh-protected-patch",
  call((c) => {
    // @ts-expect-error - a generic patch cannot add select beside the allowed where key
    c.set({ where: { published: true }, select: { id: true } });
  })
);

const heldGenericRequestPatch = {
  where: { published: true },
  include: { author: true },
};

const _genericRequestHeldProtectedPatch = extension(
  "generic-request-held-protected-patch",
  call((c) => {
    // @ts-expect-error - held generic patches structurally refuse protected keys
    c.set(heldGenericRequestPatch);
  })
);

// Written apart from any client, a targeted part types against the widest
// client: its model and operation are still known.
const reusableExtension = extension(
  "written-apart",
  call(
    (c) => {
      expectTypeOf(c.model).toEqualTypeOf<"post">();
      expectTypeOf(c.operation).toEqualTypeOf<"findMany">();
      c.set({ where: c.args.where });
    },
    target("post", "findMany")
  )
);

const _reusableDefinitionApplies = () =>
  baseClient().$extends(reusableExtension);

// Bound to the schema, its parts read the schema's own types.
const forSchema = parts<typeof schema>();

const reusableSchemaExtension = forSchema.extension(
  "schema-bound",
  call(
    (c) => {
      expectTypeOf(c.model).toEqualTypeOf<"post">();
      expectTypeOf(c.operation).toEqualTypeOf<"findMany">();
      c.args.where?.title;
      // @ts-expect-error - "ttitle" is not a field of post
      c.args.where?.ttitle;
      c.set({ where: c.args.where });
    },
    target("post", "findMany")
  ),
  methods((scope) => ({
    post: {
      findByTitle: (title: string) =>
        scope.post.findFirst({
          where: { title },
          select: { id: true, title: true },
        }),
    },
  }))
);

const _schemaBoundDefinitionApplies = () => {
  const client = baseClient().$extends(reusableSchemaExtension);
  const found = client.post.findByTitle("typed");
  expectTypeOf(found).resolves.toEqualTypeOf<{
    id: string;
    title: string;
  } | null>();
};

const _inlineRequestProjectionKeysStayProtected = () =>
  baseClient().$extends(
    extension(
      "inline-request-projections",
      call(
        (c) => {
          // @ts-expect-error - select determines the public row result
          c.set({ where: c.args.where, select: { id: true } });
        },
        target("post", "findMany")
      ),
      call(
        (c) => {
          // @ts-expect-error - omit determines the public row result
          c.set({ data: c.args.data, omit: { secret: true } });
        },
        target("post", "create")
      ),
      call(
        (c) => {
          // @ts-expect-error - count.select determines the public count result
          c.set({ where: c.args.where, select: { _all: true } });
        },
        target("post", "count")
      ),
      call(
        (c) => {
          // @ts-expect-error - aggregate selectors determine its public result
          c.set({ where: c.args.where, _count: true });
        },
        target("post", "aggregate")
      ),
      call(
        (c) => {
          // @ts-expect-error - groupBy.by determines its public result
          c.set({ where: c.args.where, by: ["published"] });
        },
        target("post", "groupBy")
      ),
      call(
        (c) => {
          // @ts-expect-error - bulk select is the returning projection witness
          c.set({ data: c.args.data, select: { id: true } });
        },
        target("post", "createMany")
      ),
      call(
        (c) => {
          // @ts-expect-error - bulk omit is also a returning projection witness
          c.set({ data: c.args.data, omit: { secret: true } });
        },
        target("post", "updateMany")
      )
    )
  );

const _schemaBoundRequestBoundary = forSchema.extension(
  "schema-bound-request-boundary",
  call(
    (c) => {
      // @ts-expect-error - schema-bound parts reject protected patches too
      c.set({ where: c.args.where, select: { id: true } });
    },
    target("post", "findMany")
  )
);

const _freshOperationTypo = () =>
  baseClient().$extends(
    extension(
      "fresh-operation-typo",
      call(
        () => undefined,
        // @ts-expect-error - "findManny" is not an operation, beside the real "findMany"
        target("post", ["findMany", "findManny"])
      )
    )
  );

const heldOperations = ["findMany", "findManny"] as const;

const _heldOperationTypo = () =>
  baseClient().$extends(
    extension(
      "held-operation-typo",
      call(
        () => undefined,
        // @ts-expect-error - a held operation list is checked too
        target("post", heldOperations)
      )
    )
  );

const _driverWrapperExtension = () =>
  createPGliteClient({ schema }).$extends(
    extension(
      "driver-wrapper",
      methods((scope) => ({
        $publishedIds: () =>
          scope.post.findMany({
            where: { published: true },
            select: { id: true },
          }),
      }))
    )
  );

type DriverWrapperRows = Awaited<
  ReturnType<ReturnType<typeof _driverWrapperExtension>["$publishedIds"]>
>;
type _driverWrapperKeepsExactMethodResult = Expect<
  Equal<DriverWrapperRows, { id: string }[]>
>;

// =============================================================================
// IMMUTABLE ACCUMULATION — zero, one, two, five, and ten extensions
// =============================================================================

const _extensionChains = () => {
  const zero = baseClient();
  // @ts-expect-error - the base client has no contributed methods
  zero.$one();

  const one = zero.$extends(
    extension(
      "chain-1",
      methods(() => ({ $one: () => 1 }))
    )
  );
  one.$one();
  // @ts-expect-error - a later method does not appear early
  one.$two();

  const two = one.$extends(
    extension(
      "chain-2",
      methods((scope) => {
        scope.$one();
        return { $two: () => "two" };
      })
    )
  );
  two.$one();
  two.$two();

  const three = two.$extends(
    extension(
      "chain-3",
      methods(() => ({ $three: () => true }))
    )
  );
  const four = three.$extends(
    extension(
      "chain-4",
      methods(() => ({ $four: () => 4 }))
    )
  );
  const five = four.$extends(
    extension(
      "chain-5",
      methods((scope) => {
        scope.$one();
        scope.$four();
        return { $five: () => "five" };
      })
    )
  );
  five.$one();
  five.$two();
  five.$three();
  five.$four();
  five.$five();

  const six = five.$extends(
    extension(
      "chain-6",
      methods(() => ({ $six: () => 6 }))
    )
  );
  const seven = six.$extends(
    extension(
      "chain-7",
      methods(() => ({ $seven: () => 7 }))
    )
  );
  const eight = seven.$extends(
    extension(
      "chain-8",
      methods(() => ({ $eight: () => 8 }))
    )
  );
  const nine = eight.$extends(
    extension(
      "chain-9",
      methods(() => ({ $nine: () => 9 }))
    )
  );
  const ten = nine.$extends(
    extension(
      "chain-10",
      methods((scope) => {
        scope.$one();
        scope.$five();
        scope.$nine();
        return { $ten: () => 10 };
      })
    )
  );
  ten.$one();
  ten.$two();
  ten.$three();
  ten.$four();
  ten.$five();
  ten.$six();
  ten.$seven();
  ten.$eight();
  ten.$nine();
  ten.$ten();
};

// =============================================================================
// METHOD INFERENCE AND TRANSACTION REBINDING
// =============================================================================

const activeMethodsClient = () =>
  baseClient()
    .$extends(
      extension(
        "actor",
        methods((scope) => ({
          $actor: () => "Ada",
          post: {
            findByTitle: (title: string) =>
              scope.post.findFirst({
                where: { title },
                select: { id: true, title: true },
              }),
          },
        }))
      )
    )
    .$extends(
      extension(
        "published",
        methods((scope) => {
          scope.$actor();
          return {
            $published: () =>
              scope.post.findMany({
                where: { published: true },
                select: { id: true },
              }),
            author: {
              findNamed: (name: string) =>
                scope.author.findFirst({ where: { name } }),
            },
          };
        })
      )
    );

const _rootMethodsAreInferred = () => {
  const client = activeMethodsClient();
  const actor: string = client.$actor();
  const rows = client.$published();
  const post = client.post.findByTitle("typed");
  const named = client.author.findNamed("Ada");
  return { actor, rows, post, named };
};

type PublishedRows = Awaited<
  ReturnType<ReturnType<typeof activeMethodsClient>["$published"]>
>;
type FoundPost = Awaited<
  ReturnType<ReturnType<typeof activeMethodsClient>["post"]["findByTitle"]>
>;
type _clientMethodResultIsExact = Expect<
  Equal<PublishedRows, { id: string }[]>
>;
type _modelMethodResultIsExact = Expect<
  Equal<FoundPost, { id: string; title: string } | null>
>;

const _callbackTransactionKeepsMethods = () =>
  activeMethodsClient().$transaction(async (tx) => {
    const actor: string = tx.$actor();
    const rows: { id: string }[] = await tx.$published();
    const found: { id: string; title: string } | null =
      await tx.post.findByTitle("inside-tx");
    await tx.author.findNamed(actor);

    // @ts-expect-error - a transaction view carries methods but cannot derive views
    tx.$extends(extension("inside-transaction"));

    return { actor, rows, found };
  });

const _arrayTransactionAcceptsAModelMethod = () => {
  const client = activeMethodsClient();
  return client.$transaction([
    client.post.findByTitle("one"),
    client.$published(),
  ]);
};

type MethodBatch = Awaited<
  ReturnType<typeof _arrayTransactionAcceptsAModelMethod>
>;
type _methodPendingOperationsStayBatchable = Expect<
  Equal<MethodBatch, [{ id: string; title: string } | null, { id: string }[]]>
>;

// =============================================================================
// EXACTNESS AND COLLISIONS — fresh and held methods
// =============================================================================

const heldModelTypo = {
  post: { valid: () => true },
  posst: { ignored: () => true },
};

const _methodTyposAreRefused = () => {
  const client = baseClient();

  client.$extends(
    extension(
      "fresh-model-typo",
      methods(() => ({
        post: { valid: () => true },
        // @ts-expect-error - "posst" is not a schema model, beside real "post"
        posst: { ignored: () => true },
      }))
    )
  );

  client.$extends(
    extension(
      "held-model-typo",
      // @ts-expect-error - a held method map is exact too
      methods(() => heldModelTypo)
    )
  );
};

const _methodShapesAreRefused = () => {
  const client = baseClient();

  client.$extends(
    extension(
      "client-value",
      methods(() => ({
        $valid: () => true,
        // @ts-expect-error - every client contribution must be a function
        $value: 1,
      }))
    )
  );

  client.$extends(
    extension(
      "missing-dollar",
      methods(() => ({
        $valid: () => true,
        // @ts-expect-error - client method names must be dollar-prefixed
        missingDollar: () => false,
      }))
    )
  );

  client.$extends(
    extension(
      "model-value",
      methods(() => ({
        post: {
          valid: () => true,
          // @ts-expect-error - every model contribution must be a function
          value: 1,
        },
      }))
    )
  );

  client.$extends(
    extension(
      "core-client-collision",
      methods(() => ({
        // @ts-expect-error - a client method cannot replace a core member
        $transaction: () => "collision",
      }))
    )
  );

  client.$extends(
    extension(
      "schema-client-collision",
      methods(() => ({
        // @ts-expect-error - a client method cannot take a model's name
        $audit: () => "collision",
      }))
    )
  );

  client.$extends(
    extension(
      "core-model-collision",
      methods(() => ({
        // @ts-expect-error - a model method cannot replace a core operation
        post: { findMany: () => "collision" },
      }))
    )
  );

  client.$extends(
    extension(
      "then-model",
      methods(() => ({
        // @ts-expect-error - a model method named `then` would make the delegate a thenable
        post: { then: () => 1 },
      }))
    )
  );

  const priorClientMethod = client.$extends(
    extension(
      "prior-client-method",
      methods(() => ({ $existing: () => true }))
    )
  );
  priorClientMethod.$extends(
    extension(
      "prior-client-collision",
      methods(() => ({
        // @ts-expect-error - later extensions cannot replace prior client methods
        $existing: () => false,
      }))
    )
  );

  const priorModelMethod = client.$extends(
    extension(
      "prior-model-method",
      methods(() => ({ post: { existing: () => true } }))
    )
  );
  priorModelMethod.$extends(
    extension(
      "prior-model-collision",
      // Compiles: a plugin generic over the extension state cannot prove this
      // collision, so the refusal is application-time only.
      methods(() => ({ post: { existing: () => false } }))
    )
  );

  // The same contributed name on different models is not a collision.
  client.$extends(
    extension(
      "cross-model-name",
      methods(() => ({
        post: { summarize: () => "post" },
        author: { summarize: () => "author" },
      }))
    )
  );
};

// =============================================================================
// RESULT INFERENCE — ordinary, recursive, variant, and returning operations
// =============================================================================

const resultClient = () =>
  baseClient()
    .$extends(genericQueryExtension)
    .$extends(
      extension(
        "result-inference",
        methods(() => ({ $ready: () => true }))
      )
    );

const selectedRows = () =>
  resultClient().post.findMany({ select: { id: true, title: true } });
type _selectStaysExact = Expect<
  Equal<
    Awaited<ReturnType<typeof selectedRows>>,
    { id: string; title: string }[]
  >
>;

const includedRows = () =>
  resultClient().post.findMany({ include: { author: true } });
type _includeStaysExact = Expect<
  Equal<
    Awaited<ReturnType<typeof includedRows>>,
    {
      id: string;
      title: string;
      secret: string;
      views: number;
      published: boolean;
      authorId: string;
      author: { id: string; name: string };
    }[]
  >
>;

const omittedRows = () =>
  resultClient().post.findMany({ omit: { secret: true } });
type _omitStaysExact = Expect<
  Equal<
    Awaited<ReturnType<typeof omittedRows>>,
    {
      id: string;
      title: string;
      views: number;
      published: boolean;
      authorId: string;
    }[]
  >
>;

const countedRows = () =>
  resultClient().post.count({ select: { _all: true, title: true } });
type _countStaysExact = Expect<
  Equal<
    Awaited<ReturnType<typeof countedRows>>,
    { _all: number; title: number }
  >
>;

const aggregateRows = () =>
  resultClient().post.aggregate({
    _count: true,
    _sum: { views: true },
    _max: { title: true },
  });
type _aggregateStaysExact = Expect<
  Equal<
    Awaited<ReturnType<typeof aggregateRows>>,
    {
      _count: number;
      _sum: { views: number | null };
      _max: { title: string | null };
    }
  >
>;

const groupedRows = () =>
  resultClient().post.groupBy({
    by: ["published"],
    _count: true,
    _sum: { views: true },
  });
type _groupByStaysExact = Expect<
  Equal<
    Awaited<ReturnType<typeof groupedRows>>,
    {
      published: boolean;
      _count: number;
      _sum: { views: number | null };
    }[]
  >
>;

const returnedRows = () =>
  resultClient().post.createMany({
    data: [
      {
        id: "post-1",
        title: "one",
        secret: "secret",
        views: 1,
        published: true,
        authorId: "author-1",
      },
    ],
    select: { id: true, title: true },
  });
type _bulkReturningStaysExact = Expect<
  Equal<
    Awaited<ReturnType<typeof returnedRows>>,
    { id: string; title: string }[]
  >
>;

const recursiveRows = () =>
  resultClient().node.findMany({
    include: { children: { select: { id: true } } },
  });
type RecursiveRows = Awaited<ReturnType<typeof recursiveRows>>;
type _recursiveResultIsNotAny = Expect<
  IsAny<RecursiveRows> extends false ? true : false
>;
type _recursiveResultStaysExact = Expect<
  Equal<
    RecursiveRows,
    {
      id: string;
      label: string;
      parentId: string | null;
      children: { id: string }[];
    }[]
  >
>;

const variantRows = () =>
  resultClient().board.findMany({
    select: {
      id: true,
      pinned: {
        note: { select: { body: true } },
        image: { select: { url: true } },
      },
    },
  });
type VariantRows = Awaited<ReturnType<typeof variantRows>>;
type _variantResultIsNotAny = Expect<
  IsAny<VariantRows> extends false ? true : false
>;
type _variantResultStaysExact = Expect<
  Equal<
    VariantRows,
    {
      id: string;
      pinned:
        | { readonly type: "note"; readonly data: { body: string } }
        | { readonly type: "image"; readonly data: { url: string } };
    }[]
  >
>;

// An extension's parts read its own arguments, typed and read-only (the
// runtime shows each part only its own extension's).
baseClient().$extends(
  extension(
    "control-context",
    args({ reason: oneOf("audit", "sync") }),
    call(
      (c) => {
        expectTypeOf(c.values).toEqualTypeOf<{
          readonly reason?: "audit" | "sync";
        }>();
      },
      target("post", "findMany")
    ),
    around(
      (c) => (run) => {
        // @ts-expect-error - its values are read-only
        c.values.reason = "sync";
        return run();
      },
      target("post", "findMany")
    )
  )
);

// 1.3.3 exported the contribution state with six parameters; the seventh
// (`Result`) is defaulted so a state spelled with six still names one.
type _sixParameterContributionState = Expect<
  Equal<
    ExtensionContributionState<
      Record<never, never>,
      Record<never, never>,
      Record<never, never>,
      never,
      never,
      "result-independent"
    >["result"],
    Record<never, never>
  >
>;
