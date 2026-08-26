/**
 * Public type falsifiers for client extensions.
 *
 * Every probe enters through an API a caller imports: the root entry point,
 * the `viborm/client` entry point, a concrete client, or a driver wrapper.
 * Extension-definition typo probes put the typo beside a real key and cover
 * both fresh and held values. No internal extension type is named here.
 *
 * Nothing in this file is called. Only the types matter.
 */

import {
  createClient as createPGliteClient,
  PGliteDriver,
} from "@drivers/pglite";
import {
  type ClientExtension as ClientSubpathExtension,
  defineExtension as defineClientExtension,
} from "@src/client/exports";
import {
  type ClientExtension,
  createClient,
  defineExtension,
  s,
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

// =============================================================================
// PUBLIC DEFINITIONS — inline, generic, curried, and both export surfaces
// =============================================================================

const _inlineContextualTyping = () =>
  baseClient().$extends({
    name: "inline-context",
    request: {
      post: {
        findMany({ model, operation, input }) {
          expectTypeOf(model).toEqualTypeOf<"post">();
          expectTypeOf(operation).toEqualTypeOf<"findMany">();
          expectTypeOf(input).not.toBeAny();
          input.where;
          // @ts-expect-error - the borrowed request input is shallow readonly
          input.take = 1;

          return { where: { published: true } };
        },
      },
    },
    query: {
      post: {
        async findMany({
          model,
          operation,
          kind,
          mode,
          input,
          proceed,
          onWriteOutcome,
        }) {
          expectTypeOf(model).toEqualTypeOf<"post">();
          expectTypeOf(operation).toEqualTypeOf<"findMany">();
          expectTypeOf(kind).not.toBeAny();
          expectTypeOf(mode).toEqualTypeOf<
            "direct" | "transaction" | "array"
          >();
          onWriteOutcome((outcome) => {
            expectTypeOf(outcome.certainty).toEqualTypeOf<
              "committed" | "may-have-committed"
            >();
          });
          // @ts-expect-error - opaque generic input values are unknown, not any
          const _opaqueInputValue: string = input.__extensionTypeProbe;
          return proceed();
        },
      },
    },
    client(scope) {
      scope.post.findMany({ where: { published: true } });
      scope.$transaction([scope.post.count()]);

      return {
        $postCount() {
          return scope.post.count();
        },
      };
    },
    model: {
      post(delegate) {
        delegate.findMany({ where: { title: "typed" } });

        return {
          findPublished() {
            return delegate.findMany({ where: { published: true } });
          },
        };
      },
    },
  });

/**
 * The all-query form has one opaque result. It may return only the value its
 * continuation owns; it cannot invent one result that claims to fit every
 * operation and schema.
 */
const genericQueryExtension = defineExtension({
  name: "generic-query",
  async query(context) {
    expectTypeOf(context.model).not.toBeAny();
    expectTypeOf(context.operation).not.toBeAny();
    expectTypeOf(context.kind).not.toBeAny();
    expectTypeOf(context.input).not.toBeAny();
    expectTypeOf(context.mode).toEqualTypeOf<
      "direct" | "transaction" | "array"
    >();
    context.onWriteOutcome((outcome) => {
      expectTypeOf(outcome.certainty).toEqualTypeOf<
        "committed" | "may-have-committed"
      >();
    });
    if (context.kind === "model") {
      expectTypeOf(context.model).toEqualTypeOf<string>();
      expectTypeOf(context.operation).not.toBeAny();
    } else if (context.kind === "queryRaw") {
      expectTypeOf(context.model).toEqualTypeOf<undefined>();
      expectTypeOf(context.operation).toEqualTypeOf<"$queryRaw">();
    } else if (context.kind === "executeRaw") {
      expectTypeOf(context.operation).toEqualTypeOf<"$executeRaw">();
    } else if (context.kind === "queryRawUnsafe") {
      expectTypeOf(context.operation).toEqualTypeOf<"$queryRawUnsafe">();
    } else {
      expectTypeOf(context.operation).toEqualTypeOf<"$executeRawUnsafe">();
    }
    return context.proceed();
  },
});

const _genericQueryAppliesToAConcreteClient = () =>
  baseClient().$extends(genericQueryExtension);

const _genericQueryCannotFabricateOneUniversalResult = defineExtension({
  name: "generic-query-fabrication",
  // @ts-expect-error - a string cannot stand in for the opaque result of every query
  async query({ proceed }) {
    await proceed();
    return "fabricated";
  },
});

const _genericRequestInputStaysProjectionFree = defineExtension({
  name: "generic-request-input",
  request({ input }) {
    expectTypeOf(input.where).toEqualTypeOf<unknown>();
    expectTypeOf(input.select).toEqualTypeOf<undefined>();
    expectTypeOf(input.include).toEqualTypeOf<undefined>();
    expectTypeOf(input.omit).toEqualTypeOf<undefined>();
    expectTypeOf(input.by).toEqualTypeOf<undefined>();

    return { where: input.where };
  },
});

const _genericRequestFreshProtectedPatch = defineExtension({
  name: "generic-request-fresh-protected-patch",
  // @ts-expect-error - a generic patch cannot add select beside the allowed where key
  request: () => ({ where: { published: true }, select: { id: true } }),
});

const heldGenericRequestPatch = {
  where: { published: true },
  include: { author: true },
};

const _genericRequestHeldProtectedPatch = defineExtension({
  name: "generic-request-held-protected-patch",
  // @ts-expect-error - held generic patches structurally refuse protected keys
  request: () => heldGenericRequestPatch,
});

const _genericMapsRequireSchemaBinder = () => {
  defineExtension({
    name: "generic-request-map-refused",
    client: () => ({ $valid: () => true }),
    // @ts-expect-error - direct reusable definitions require the generic function form
    request: { post: { findMany: () => ({}) } },
  });

  defineExtension({
    name: "generic-query-map-refused",
    client: () => ({ $valid: () => true }),
    // @ts-expect-error - schema-specific query maps require the curried binder
    query: { post: { findMany: async () => [] } },
  });
};

const reusableSchemaExtension = defineExtension<typeof schema>()({
  name: "schema-bound",
  request: {
    post: {
      findMany({ model, operation, input }) {
        expectTypeOf(model).toEqualTypeOf<"post">();
        expectTypeOf(operation).toEqualTypeOf<"findMany">();
        return { where: input.where };
      },
    },
  },
  model: {
    post(delegate) {
      return {
        findByTitle(title: string) {
          return delegate.findFirst({
            where: { title },
            select: { id: true, title: true },
          });
        },
      };
    },
  },
});

const _schemaBoundDefinitionApplies = () =>
  baseClient().$extends(reusableSchemaExtension);

const _inlineRequestProjectionKeysStayProtected = () =>
  baseClient().$extends({
    name: "inline-request-projections",
    request: {
      post: {
        findFirst({ input }) {
          // @ts-expect-error - handlers cannot read caller-owned include
          input.include;
          return { where: input.where };
        },
        // @ts-expect-error - select determines the public row result
        findMany({ input }) {
          return { where: input.where, select: { id: true } };
        },
        // @ts-expect-error - omit determines the public row result
        create({ input }) {
          return { data: input.data, omit: { secret: true } };
        },
        // @ts-expect-error - count.select determines the public count result
        count({ input }) {
          return { where: input.where, select: { _all: true } };
        },
        // @ts-expect-error - aggregate selectors determine its public result
        aggregate({ input }) {
          return { where: input.where, _count: true };
        },
        // @ts-expect-error - groupBy.by determines its public result
        groupBy({ input }) {
          return { where: input.where, by: ["published"] };
        },
        // @ts-expect-error - bulk select is the returning projection witness
        createMany({ input }) {
          return { data: input.data, select: { id: true } };
        },
        // @ts-expect-error - bulk omit is also a returning projection witness
        updateMany({ input }) {
          return { data: input.data, omit: { secret: true } };
        },
      },
    },
  });

const _curriedRequestBoundary = defineExtension<typeof schema>()({
  name: "curried-request-boundary",
  // @ts-expect-error - curried reusable maps reject protected patches too
  request: {
    post: {
      findFirst: ({ input }) => ({ where: input.where }),
      findMany({ input }) {
        return { where: input.where, select: { id: true } };
      },
    },
  },
});

const _curriedFreshOperationTypo = defineExtension<typeof schema>()({
  name: "curried-fresh-operation-typo",
  request: {
    post: {
      findMany: () => ({}),
      // @ts-expect-error - typo is refused beside a real operation
      findManny: () => ({}),
    },
  },
});

const heldCurriedOperationMap = {
  findMany: () => ({}),
  findManny: () => ({}),
};

const _curriedHeldOperationTypo = defineExtension<typeof schema>()({
  name: "curried-held-operation-typo",
  request: {
    // @ts-expect-error - non-fresh operation maps are structurally exact
    post: heldCurriedOperationMap,
  },
});

// The public type describes one reusable schema-bound definition before any
// prior extension state exists; the curried definition must fit it directly.
const _rootPublicType: ClientExtension<typeof schema> = reusableSchemaExtension;

const _clientSubpathPublicType: ClientSubpathExtension<typeof schema> =
  defineClientExtension<typeof schema>()({ name: "client-subpath" });

const _driverWrapperExtension = () =>
  createPGliteClient({ schema }).$extends({
    name: "driver-wrapper",
    client(scope) {
      return {
        $publishedIds() {
          return scope.post.findMany({
            where: { published: true },
            select: { id: true },
          });
        },
      };
    },
  });

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

  const one = zero.$extends({
    name: "chain-1",
    client() {
      return { $one: () => 1 };
    },
  });
  one.$one();
  // @ts-expect-error - a later method does not appear early
  one.$two();

  const two = one.$extends({
    name: "chain-2",
    client(scope) {
      scope.$one();
      return { $two: () => "two" };
    },
  });
  two.$one();
  two.$two();

  const three = two.$extends({
    name: "chain-3",
    client() {
      return { $three: () => true };
    },
  });
  const four = three.$extends({
    name: "chain-4",
    client() {
      return { $four: () => 4 };
    },
  });
  const five = four.$extends({
    name: "chain-5",
    client(scope) {
      scope.$one();
      scope.$four();
      return { $five: () => "five" };
    },
  });
  five.$one();
  five.$two();
  five.$three();
  five.$four();
  five.$five();

  const six = five.$extends({
    name: "chain-6",
    client: () => ({ $six: () => 6 }),
  });
  const seven = six.$extends({
    name: "chain-7",
    client: () => ({ $seven: () => 7 }),
  });
  const eight = seven.$extends({
    name: "chain-8",
    client: () => ({ $eight: () => 8 }),
  });
  const nine = eight.$extends({
    name: "chain-9",
    client: () => ({ $nine: () => 9 }),
  });
  const ten = nine.$extends({
    name: "chain-10",
    client(scope) {
      scope.$one();
      scope.$five();
      scope.$nine();
      return { $ten: () => 10 };
    },
  });
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
    .$extends({
      name: "actor",
      client() {
        return { $actor: () => "Ada" };
      },
      model: {
        post(delegate) {
          return {
            findByTitle(title: string) {
              return delegate.findFirst({
                where: { title },
                select: { id: true, title: true },
              });
            },
          };
        },
      },
    })
    .$extends({
      name: "published",
      client(scope) {
        scope.$actor();
        return {
          $published() {
            return scope.post.findMany({
              where: { published: true },
              select: { id: true },
            });
          },
        };
      },
      model: {
        author(delegate) {
          return {
            findNamed(name: string) {
              return delegate.findFirst({ where: { name } });
            },
          };
        },
      },
    });

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
    tx.$extends({ name: "inside-transaction" });

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
// EXACTNESS AND COLLISIONS — fresh and non-fresh public definitions
// =============================================================================

const heldEnvelopeTypo = {
  name: "held-envelope-typo",
  client: () => ({ $valid: () => true }),
  cliet: () => ({ $ignored: () => true }),
};

const heldModelTypo = {
  post: () => ({ valid: () => true }),
  posst: () => ({ ignored: () => true }),
};

const heldOperationTypo = {
  findMany: () => ({}),
  findManny: () => ({}),
};

const _definitionTyposAreRefused = () => {
  const client = baseClient();

  client.$extends({
    name: "fresh-envelope-typo",
    client: () => ({ $valid: () => true }),
    // @ts-expect-error - "cliet" is not an envelope key, beside real "client"
    cliet: () => ({ $ignored: () => true }),
  });

  // @ts-expect-error - held definitions are structurally exact too
  client.$extends(heldEnvelopeTypo);

  client.$extends({
    name: "fresh-model-typo",
    model: {
      post: () => ({ valid: () => true }),
      // @ts-expect-error - "posst" is not a schema model, beside real "post"
      posst: () => ({ ignored: () => true }),
    },
  });

  // @ts-expect-error - a held model map is exact too
  client.$extends({ name: "held-model-typo", model: heldModelTypo });

  client.$extends({
    name: "fresh-operation-typo",
    request: {
      post: {
        findMany: () => ({}),
        // @ts-expect-error - "findManny" is not an operation, beside real "findMany"
        findManny: () => ({}),
      },
    },
  });

  client.$extends({
    name: "held-operation-typo",
    request: {
      // @ts-expect-error - a held operation map is exact too
      post: heldOperationTypo,
    },
  });
};

const _methodShapesAreRefused = () => {
  const client = baseClient();

  client.$extends({
    name: "client-value",
    // @ts-expect-error - every client contribution must be a function
    client: () => ({ $valid: () => true, $value: 1 }),
  });

  client.$extends({
    name: "missing-dollar",
    // @ts-expect-error - client method names must be dollar-prefixed
    client: () => ({ $valid: () => true, missingDollar: () => false }),
  });

  client.$extends({
    name: "model-value",
    model: {
      // @ts-expect-error - every model contribution must be a function
      post: () => ({ valid: () => true, value: 1 }),
    },
  });

  client.$extends({
    name: "core-client-collision",
    // @ts-expect-error - a client method cannot replace a core member
    client: () => ({ $transaction: () => "collision" }),
  });

  client.$extends({
    name: "schema-client-collision",
    // @ts-expect-error - static defense for invalid schemas; valid model keys cannot start "$"
    client: () => ({ $audit: () => "collision" }),
  });

  client.$extends({
    name: "core-model-collision",
    model: {
      // @ts-expect-error - a model method cannot replace a core operation
      post: () => ({ findMany: () => "collision" }),
    },
  });

  const priorClientMethod = client.$extends({
    name: "prior-client-method",
    client: () => ({ $existing: () => true }),
  });
  priorClientMethod.$extends({
    name: "prior-client-collision",
    // @ts-expect-error - later extensions cannot replace prior client methods
    client: () => ({ $existing: () => false }),
  });

  const priorModelMethod = client.$extends({
    name: "prior-model-method",
    model: { post: () => ({ existing: () => true }) },
  });
  priorModelMethod.$extends({
    name: "prior-model-collision",
    model: {
      // @ts-expect-error - later extensions cannot replace a prior method on that model
      post: () => ({ existing: () => false }),
    },
  });

  // The same contributed name on different models is not a collision.
  client.$extends({
    name: "cross-model-name",
    model: {
      post: () => ({ summarize: () => "post" }),
      author: () => ({ summarize: () => "author" }),
    },
  });
};

const _siblingMethodsAreNotThisVisible = () =>
  baseClient().$extends({
    name: "no-sibling-this",
    client: () => ({
      $first() {
        // @ts-expect-error - contributed methods have no dynamic client this
        return this.$second();
      },
      $second: () => "client sibling",
    }),
    model: {
      post: () => ({
        first() {
          // @ts-expect-error - contributed methods have no dynamic delegate this
          return this.second();
        },
        second: () => "model sibling",
      }),
    },
  });

// =============================================================================
// RESULT INFERENCE — ordinary, recursive, variant, and returning operations
// =============================================================================

const resultClient = () =>
  baseClient()
    .$extends(genericQueryExtension)
    .$extends({
      name: "result-inference",
      client: () => ({ $ready: () => true }),
    });

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
