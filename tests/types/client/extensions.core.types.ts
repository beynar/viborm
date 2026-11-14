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
  extension,
  call,
  args,
  methods,
  target,
  around,
  oneOf,
  settled,
} from "@src/client/exports";
import {
  type ClientExtension,
  createClient,
  type ExtendedClient,
  type ExtensionContributionState,
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

function _clientAwareFactory() {
  const base = baseClient();
  const factory = (client: typeof base) =>
    client.$extends(
      extension(
        "factory-method",
        methods((scope) => {
          const own = { client: () => ({ $answer: () => 42 as const }) };
          return { ...own.client?.(scope), ...own.models };
        })
      )
    );
  const result = base.$extends(factory);
  expectTypeOf(result.$answer()).toEqualTypeOf<42>();
  expectTypeOf<
    ExtendedClient<typeof base, [typeof factory]>
  >().toEqualTypeOf<never>();
  result.post.findMany({ where: { title: "typed" } });
  // @ts-expect-error - factories return a client synchronously
  base.$extends(async (client) => client);
  // @ts-expect-error - factories return a client, not an arbitrary value
  base.$extends(() => 42);
}

// =============================================================================
// PUBLIC DEFINITIONS — inline, generic, curried, and both export surfaces
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
          // @ts-expect-error - the borrowed request input is shallow readonly
          c.args.take = 1;

          c.set({ where: { published: true } });
        },
        target("post", "findMany")
      ),
      around(
        (c) => {
          settled(c, (outcome) => {
            expectTypeOf(outcome.certainty).toEqualTypeOf<
              "committed" | "may-have-committed"
            >();
          });
          return async (run) => {
            expectTypeOf(c.model).toEqualTypeOf<"post">();
            expectTypeOf(c.operation).toEqualTypeOf<"findMany">();
            expectTypeOf(c.kind).not.toBeAny();
            expectTypeOf(run.mode).toEqualTypeOf<
              "direct" | "transaction" | "array"
            >();

            // @ts-expect-error - opaque generic input values are unknown, not any
            const _opaqueInputValue: string = run.input.__extensionTypeProbe;
            return run();
          };
        },
        target("post", "findMany")
      ),
      methods((scope) => {
        const own = {
          client(scope) {
            scope.post.findMany({ where: { published: true } });
            scope.$transaction([scope.post.count()]);

            return {
              $postCount() {
                return scope.post.count();
              },
            };
          },
          models: {
            post(delegate) {
              delegate.findMany({ where: { title: "typed" } });

              return {
                findPublished() {
                  return delegate.findMany({ where: { published: true } });
                },
              };
            },
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

/**
 * The all-query form has one opaque result. It may return only the value its
 * continuation owns; it cannot invent one result that claims to fit every
 * operation and schema.
 */
const genericQueryExtension = extension(
  "generic-query",
  around((c) => {
    settled(c, (outcome) => {
      expectTypeOf(outcome.certainty).toEqualTypeOf<
        "committed" | "may-have-committed"
      >();
    });
    return async (run) => {
      expectTypeOf(c.model).not.toBeAny();
      expectTypeOf(c.operation).not.toBeAny();
      expectTypeOf(c.kind).not.toBeAny();
      expectTypeOf(run.input).not.toBeAny();
      expectTypeOf(run.mode).toEqualTypeOf<
        "direct" | "transaction" | "array"
      >();

      if (c.kind === "model") {
        expectTypeOf(c.model).toEqualTypeOf<string>();
        expectTypeOf(c.operation).not.toBeAny();
      } else if (c.kind === "queryRaw") {
        expectTypeOf(c.model).toEqualTypeOf<undefined>();
        expectTypeOf(c.operation).toEqualTypeOf<"$queryRaw">();
      } else if (c.kind === "executeRaw") {
        expectTypeOf(c.operation).toEqualTypeOf<"$executeRaw">();
      } else if (c.kind === "queryRawUnsafe") {
        expectTypeOf(c.operation).toEqualTypeOf<"$queryRawUnsafe">();
      } else {
        expectTypeOf(c.operation).toEqualTypeOf<"$executeRawUnsafe">();
      }
      return run();
    };
  })
);

const _genericQueryAppliesToAConcreteClient = () =>
  baseClient().$extends(genericQueryExtension);

const _genericQueryCannotFabricateOneUniversalResult = extension(
  "generic-query-fabrication",
  around(() => async (run) => {
    await run();
    return "fabricated";
  })
);

const _genericRequestInputStaysProjectionFree = extension(
  "generic-request-input",
  call((c) => {
    expectTypeOf(c.args.where).toEqualTypeOf<unknown>();
    expectTypeOf(c.args.select).toEqualTypeOf<undefined>();
    expectTypeOf(c.args.include).toEqualTypeOf<undefined>();
    expectTypeOf(c.args.omit).toEqualTypeOf<undefined>();
    expectTypeOf(c.args.by).toEqualTypeOf<undefined>();

    c.set({ where: c.args.where });
  })
);

const _genericRequestFreshProtectedPatch = extension(
  "generic-request-fresh-protected-patch",
  call((c) => {
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
    c.set(heldGenericRequestPatch);
  })
);

const _genericMapsRequireSchemaBinder = () => {
  extension(
    "generic-request-map-refused",
    call(
      (c) => {
        c.set({});
      },
      target("post", "findMany")
    ),
    methods((scope) => {
      const own = { client: () => ({ $valid: () => true }) };
      return { ...own.client?.(scope), ...own.models };
    })
  );

  extension(
    "generic-query-map-refused",
    around(() => async (run) => [], target("post", "findMany")),
    methods((scope) => {
      const own = { client: () => ({ $valid: () => true }) };
      return { ...own.client?.(scope), ...own.models };
    })
  );
};

const reusableSchemaExtension = extension(
  "schema-bound",
  call(
    (c) => {
      expectTypeOf(c.model).toEqualTypeOf<"post">();
      expectTypeOf(c.operation).toEqualTypeOf<"findMany">();
      c.set({ where: c.args.where });
    },
    target("post", "findMany")
  ),
  methods((scope) => {
    const own = {
      models: {
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
    };
    return { ...own.client?.(scope), ...own.models };
  })
);

const _schemaBoundDefinitionApplies = () =>
  baseClient().$extends(reusableSchemaExtension);

const _inlineRequestProjectionKeysStayProtected = () =>
  baseClient().$extends(
    extension(
      "inline-request-projections",
      call(
        (c) => {
          // @ts-expect-error - handlers cannot read caller-owned include
          c.args.include;
          c.set({ where: c.args.where });
        },
        target("post", "findFirst")
      ),
      call(
        (c) => {
          c.set({ where: c.args.where, select: { id: true } });
        },
        target("post", "findMany")
      ),
      call(
        (c) => {
          c.set({ data: c.args.data, omit: { secret: true } });
        },
        target("post", "create")
      ),
      call(
        (c) => {
          c.set({ where: c.args.where, select: { _all: true } });
        },
        target("post", "count")
      ),
      call(
        (c) => {
          c.set({ where: c.args.where, _count: true });
        },
        target("post", "aggregate")
      ),
      call(
        (c) => {
          c.set({ where: c.args.where, by: ["published"] });
        },
        target("post", "groupBy")
      ),
      call(
        (c) => {
          c.set({ data: c.args.data, select: { id: true } });
        },
        target("post", "createMany")
      ),
      call(
        (c) => {
          c.set({ data: c.args.data, omit: { secret: true } });
        },
        target("post", "updateMany")
      )
    )
  );

const _curriedRequestBoundary = extension(
  "curried-request-boundary",
  call(
    (c) => {
      c.set({ where: c.args.where });
    },
    target("post", "findFirst")
  ),
  call(
    (c) => {
      c.set({ where: c.args.where, select: { id: true } });
    },
    target("post", "findMany")
  )
);

const _curriedFreshOperationTypo = extension(
  "curried-fresh-operation-typo",
  call(
    (c) => {
      c.set({});
    },
    target("post", "findMany")
  ),
  call(
    (c) => {
      c.set({});
    },
    target("post", "findManny")
  )
);

const heldCurriedOperationMap = {
  findMany: () => ({}),
  findManny: () => ({}),
};

const _curriedHeldOperationTypo = extension(
  "curried-held-operation-typo",
  call(
    (c) => {
      c.set({});
    },
    target("post", "findMany")
  ),
  call(
    (c) => {
      c.set({});
    },
    target("post", "findManny")
  )
);

// The public type describes one reusable schema-bound definition before any
// prior extension state exists; the curried definition must fit it directly.
const _rootPublicType: ClientExtension<typeof schema> = reusableSchemaExtension;

const _clientSubpathPublicType: ClientSubpathExtension<typeof schema> =
  defineClientExtension<typeof schema>()({ name: "client-subpath" });

const _driverWrapperExtension = () =>
  createPGliteClient({ schema }).$extends(
    extension(
      "driver-wrapper",
      methods((scope) => {
        const own = {
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
        };
        return { ...own.client?.(scope), ...own.models };
      })
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
      methods((scope) => {
        const own = {
          client() {
            return { $one: () => 1 };
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  one.$one();
  // @ts-expect-error - a later method does not appear early
  one.$two();

  const two = one.$extends(
    extension(
      "chain-2",
      methods((scope) => {
        const own = {
          client(scope) {
            scope.$one();
            return { $two: () => "two" };
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  two.$one();
  two.$two();

  const three = two.$extends(
    extension(
      "chain-3",
      methods((scope) => {
        const own = {
          client() {
            return { $three: () => true };
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  const four = three.$extends(
    extension(
      "chain-4",
      methods((scope) => {
        const own = {
          client() {
            return { $four: () => 4 };
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  const five = four.$extends(
    extension(
      "chain-5",
      methods((scope) => {
        const own = {
          client(scope) {
            scope.$one();
            scope.$four();
            return { $five: () => "five" };
          },
        };
        return { ...own.client?.(scope), ...own.models };
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
      methods((scope) => {
        const own = { client: () => ({ $six: () => 6 }) };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  const seven = six.$extends(
    extension(
      "chain-7",
      methods((scope) => {
        const own = { client: () => ({ $seven: () => 7 }) };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  const eight = seven.$extends(
    extension(
      "chain-8",
      methods((scope) => {
        const own = { client: () => ({ $eight: () => 8 }) };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  const nine = eight.$extends(
    extension(
      "chain-9",
      methods((scope) => {
        const own = { client: () => ({ $nine: () => 9 }) };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  const ten = nine.$extends(
    extension(
      "chain-10",
      methods((scope) => {
        const own = {
          client(scope) {
            scope.$one();
            scope.$five();
            scope.$nine();
            return { $ten: () => 10 };
          },
        };
        return { ...own.client?.(scope), ...own.models };
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
        methods((scope) => {
          const own = {
            client() {
              return { $actor: () => "Ada" };
            },
            models: {
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
          };
          return { ...own.client?.(scope), ...own.models };
        })
      )
    )
    .$extends(
      extension(
        "published",
        methods((scope) => {
          const own = {
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
            models: {
              author(delegate) {
                return {
                  findNamed(name: string) {
                    return delegate.findFirst({ where: { name } });
                  },
                };
              },
            },
          };
          return { ...own.client?.(scope), ...own.models };
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

  client.$extends(
    extension(
      "fresh-model-typo",
      methods((scope) => {
        const own = {
          models: {
            post: () => ({ valid: () => true }),
            // @ts-expect-error - "posst" is not a schema model, beside real "post"
            posst: () => ({ ignored: () => true }),
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  // @ts-expect-error - a held model map is exact too
  client.$extends(
    extension(
      "held-model-typo",
      methods((scope) => {
        const own = { models: heldModelTypo };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  client.$extends(
    extension(
      "fresh-operation-typo",
      call(
        (c) => {
          c.set({});
        },
        target("post", "findMany")
      ),
      call(
        (c) => {
          c.set({});
        },
        target("post", "findManny")
      )
    )
  );

  client.$extends(
    extension(
      "held-operation-typo",
      call(
        (c) => {
          c.set({});
        },
        target("post", "findMany")
      ),
      call(
        (c) => {
          c.set({});
        },
        target("post", "findManny")
      )
    )
  );
};

const _methodShapesAreRefused = () => {
  const client = baseClient();

  client.$extends(
    extension(
      "client-value",
      methods((scope) => {
        const own = { client: () => ({ $valid: () => true, $value: 1 }) };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  client.$extends(
    extension(
      "missing-dollar",
      methods((scope) => {
        const own = {
          client: () => ({ $valid: () => true, missingDollar: () => false }),
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  client.$extends(
    extension(
      "model-value",
      methods((scope) => {
        const own = {
          models: {
            // @ts-expect-error - every model contribution must be a function
            post: () => ({ valid: () => true, value: 1 }),
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  client.$extends(
    extension(
      "core-client-collision",
      methods((scope) => {
        const own = { client: () => ({ $transaction: () => "collision" }) };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  client.$extends(
    extension(
      "schema-client-collision",
      methods((scope) => {
        const own = { client: () => ({ $audit: () => "collision" }) };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  client.$extends(
    extension(
      "core-model-collision",
      methods((scope) => {
        const own = {
          models: {
            // @ts-expect-error - a model method cannot replace a core operation
            post: () => ({ findMany: () => "collision" }),
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  client.$extends(
    extension(
      "then-model",
      methods((scope) => {
        const own = {
          models: {
            // @ts-expect-error - a model method named `then` would make the delegate a thenable
            post: () => ({ then: () => 1 }),
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  const priorClientMethod = client.$extends(
    extension(
      "prior-client-method",
      methods((scope) => {
        const own = { client: () => ({ $existing: () => true }) };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  priorClientMethod.$extends(
    extension(
      "prior-client-collision",
      methods((scope) => {
        const own = { client: () => ({ $existing: () => false }) };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  const priorModelMethod = client.$extends(
    extension(
      "prior-model-method",
      methods((scope) => {
        const own = { models: { post: () => ({ existing: () => true }) } };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
  priorModelMethod.$extends(
    extension(
      "prior-model-collision",
      methods((scope) => {
        const own = {
          models: {
            // Compiles: a plugin generic over the extension state cannot prove this
            // collision, so the refusal is application-time only (DC2), pinned at
            // runtime by extensions-foundation.core.test.ts "prior-model".
            post: () => ({ existing: () => false }),
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

  // The same contributed name on different models is not a collision.
  client.$extends(
    extension(
      "cross-model-name",
      methods((scope) => {
        const own = {
          models: {
            post: () => ({ summarize: () => "post" }),
            author: () => ({ summarize: () => "author" }),
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );
};

const _siblingMethodsAreNotThisVisible = () =>
  baseClient().$extends(
    extension(
      "no-sibling-this",
      methods((scope) => {
        const own = {
          client: () => ({
            $first() {
              // @ts-expect-error - contributed methods have no dynamic client this
              return this.$second();
            },
            $second: () => "client sibling",
          }),
          models: {
            post: () => ({
              first() {
                // @ts-expect-error - contributed methods have no dynamic delegate this
                return this.second();
              },
              second: () => "model sibling",
            }),
          },
        };
        return { ...own.client?.(scope), ...own.models };
      })
    )
  );

// =============================================================================
// RESULT INFERENCE — ordinary, recursive, variant, and returning operations
// =============================================================================

const resultClient = () =>
  baseClient()
    .$extends(genericQueryExtension)
    .$extends(
      extension(
        "result-inference",
        methods((scope) => {
          const own = { client: () => ({ $ready: () => true }) };
          return { ...own.client?.(scope), ...own.models };
        })
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

// A declaring extension's handlers read its admitted controls, read-only and
// unknown until narrowed (the runtime shows each handler only its own).
baseClient().$extends(
  extension(
    "control-context",
    args({ reason: oneOf("audit", "sync") }),
    call(
      (c) => {
        type _requestControls = Expect<
          Equal<typeof c.values, Readonly<Record<string, unknown>> | undefined>
        >;
        c.set({});
      },
      target("post", "findMany")
    ),
    around(
      (c) => (run) => {
        type _queryControls = Expect<
          Equal<typeof c.values, Readonly<Record<string, unknown>> | undefined>
        >;
        // @ts-expect-error - admitted controls are read-only
        if (c.values) c.values.reason = "sync";
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
