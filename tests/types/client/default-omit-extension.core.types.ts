import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { defaultOmit } from "@src/client/exports";
import { PGliteDriver } from "@src/drivers/pglite";
import {
  type ClientExtension,
  createClient,
  defineExtension,
  s,
} from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { expectTypeOf } from "vitest";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type Expect<Condition extends true> = Condition;
type _rootDefaultOmitIsAbsent = Expect<
  Equal<
    "defaultOmit" extends keyof typeof import("@src/index") ? true : false,
    false
  >
>;

const user = s.model({
  id: s.string().id(),
  email: s.string(),
  passwordHash: s.string(),
  posts: s.toMany(() => post).name("author"),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id")
    .name("author"),
});
const node = s.model({
  id: s.string().id(),
  label: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => node).name("tree"),
});
const note = s.model({
  id: s.string().id(),
  body: s.string(),
  secret: s.string(),
});
const image = s.model({
  id: s.string().id(),
  url: s.string(),
  token: s.string(),
});
const board = s.model({
  id: s.string().id(),
  pinned: s.toOne(
    { note: () => note, image: () => image },
    { values: { note: "default.note.v1", image: "default.image.v1" } }
  ),
});
const gallery = s.model({
  id: s.string().id(),
  items: s.toMany(
    { note: () => note, image: () => image },
    { values: { note: "default.notes.v1", image: "default.images.v1" } }
  ),
});

const schema = { user, post, node, note, image, board, gallery };
const base = createClient({ schema, driver: new PGliteDriver() });

const official = defaultOmit<typeof schema>()({
  user: { passwordHash: true },
  post: { secret: true },
  node: { label: true },
  note: { secret: true },
  image: { token: true },
});
const omitted = base.$extends(official);

// The official identity cannot be erased into the ordinary reusable surface.
// @ts-expect-error - only the authentic official admission may alter result types
const _erasedOfficial: ClientExtension<typeof schema> = official;

// Fresh and held exactness are both structural, never EPC-only.
defaultOmit<typeof schema>()({
  user: { passwordHash: true },
  // @ts-expect-error - "usr" is not a model beside the real "user"
  usr: { passwordHash: true },
});
defaultOmit<typeof schema>()({
  user: {
    passwordHash: true,
    // @ts-expect-error - "passwordHsh" is not a scalar beside the real field
    passwordHsh: true,
  },
});
defaultOmit<typeof schema>()({
  post: {
    secret: true,
    // @ts-expect-error - relations are not client-default omission fields
    author: true,
  },
});
defaultOmit<typeof schema>()({
  user: {
    passwordHash: true,
    email: true,
  },
});
const heldFalseOmit = {
  user: { passwordHash: true, email: false },
} as const;
// @ts-expect-error - default omission accepts only literal true
defaultOmit<typeof schema>()(heldFalseOmit);

const heldModelTypo = {
  user: { passwordHash: true },
  usr: { passwordHash: true },
} as const;
// @ts-expect-error - held model typos are refused beside a real model
defaultOmit<typeof schema>()(heldModelTypo);

const heldScalarTypo = {
  user: { passwordHash: true, passwordHsh: true },
} as const;
// @ts-expect-error - held scalar typos are refused beside a real scalar
defaultOmit<typeof schema>()(heldScalarTypo);

const widenedModels: Record<string, { passwordHash: true }> = {
  user: { passwordHash: true },
};
// @ts-expect-error - a widened model record names nothing the schema can check
defaultOmit<typeof schema>()(widenedModels);

declare const heldUnion:
  | { readonly user: { readonly passwordHash: true } }
  | {
      readonly user: { readonly passwordHash: true };
      readonly usr: { readonly passwordHash: true };
    };
// @ts-expect-error - every held union branch is checked for model typos
defaultOmit<typeof schema>()(heldUnion);

// Authentic clones retain the exact request identity; replacement does not.
base.$extends({ ...official });
// @ts-expect-error - the fixed official name cannot be changed
base.$extends({ ...official, name: "renamed-default-omit" });
// @ts-expect-error - replacing the request identity loses the omission witness
base.$extends({ ...official, request: () => ({}) });
// @ts-expect-error - binding replaces the exact official request identity
base.$extends({ ...official, request: official.request.bind(undefined) });
// @ts-expect-error - an ordinary extension cannot claim the reserved name
base.$extends(defineExtension({ name: "viborm.defaultOmit" }));
// @ts-expect-error - the official default omit capability is unique
omitted.$extends(official);

const priorRequest = base.$extends({
  name: "prior-request",
  request: () => ({}),
});
const priorGenericQuery = base.$extends({
  name: "prior-generic-query",
  query: async ({ proceed }) => proceed(),
});
const priorMappedQuery = base.$extends({
  name: "prior-mapped-query",
  query: {
    user: {
      findMany: async ({ proceed }) => proceed(),
    },
  },
});
const priorClient = base.$extends({
  name: "prior-client",
  client: () => ({ $prior: () => true }),
});
const priorModel = base.$extends({
  name: "prior-model",
  model: { user: () => ({ prior: () => true }) },
});
const priorStatement = base.$extends({
  name: "prior-statement",
  statement: ({ statement }) => statement,
});
const priorObserve = base.$extends({
  name: "prior-observe",
  observe: (_unit, proceed) => proceed(),
});
const priorCache = base.$extends(cache({ driver: new MemoryCache() }));
const priorInstrumentation = base.$extends(instrumentation({ tracing: true }));

const omittedAfterRequest = priorRequest.$extends(official);
priorGenericQuery.$extends(official);
// @ts-expect-error - a schema-mapped query handler consumed the unomitted result contract
priorMappedQuery.$extends(official);
// @ts-expect-error - a prior client method captured the unomitted result contract
priorClient.$extends(official);
// @ts-expect-error - a prior model method captured the unomitted result contract
priorModel.$extends(official);
priorStatement.$extends(official);
priorObserve.$extends(official);
priorCache.$extends(official);
priorInstrumentation.$extends(official);

type HiddenUser = { id: string; email: string };
type HiddenPost = { id: string; title: string; authorId: string };

type _priorRequestKeepsOmittedResult = Expect<
  Equal<
    Awaited<ReturnType<typeof omittedAfterRequest.user.findMany>>,
    HiddenUser[]
  >
>;

const findFirst = () => omitted.user.findFirst({});
const findFirstOrThrow = () => omitted.user.findFirstOrThrow({});
const findMany = () => omitted.user.findMany({});
const findUnique = () => omitted.user.findUnique({ where: { id: "u1" } });
const findUniqueOrThrow = () =>
  omitted.user.findUniqueOrThrow({ where: { id: "u1" } });
const create = () =>
  omitted.user.create({
    data: { id: "u2", email: "two@example.test", passwordHash: "two" },
  });
const update = () =>
  omitted.user.update({
    where: { id: "u1" },
    data: { email: "updated@example.test" },
  });
const remove = () => omitted.user.delete({ where: { id: "u1" } });
const upsert = () =>
  omitted.user.upsert({
    where: { id: "u1" },
    create: { id: "u1", email: "one@example.test", passwordHash: "one" },
    update: { email: "updated@example.test" },
  });

type _findFirst = Expect<
  Equal<Awaited<ReturnType<typeof findFirst>>, HiddenUser | null>
>;
type _findFirstOrThrow = Expect<
  Equal<Awaited<ReturnType<typeof findFirstOrThrow>>, HiddenUser>
>;
type _findMany = Expect<
  Equal<Awaited<ReturnType<typeof findMany>>, HiddenUser[]>
>;
type _findUnique = Expect<
  Equal<Awaited<ReturnType<typeof findUnique>>, HiddenUser | null>
>;
type _findUniqueOrThrow = Expect<
  Equal<Awaited<ReturnType<typeof findUniqueOrThrow>>, HiddenUser>
>;
type _create = Expect<Equal<Awaited<ReturnType<typeof create>>, HiddenUser>>;
type _update = Expect<Equal<Awaited<ReturnType<typeof update>>, HiddenUser>>;
type _delete = Expect<Equal<Awaited<ReturnType<typeof remove>>, HiddenUser>>;
type _upsert = Expect<Equal<Awaited<ReturnType<typeof upsert>>, HiddenUser>>;

const selected = () =>
  omitted.user.findMany({ select: { id: true, passwordHash: true } });
const restored = () => omitted.user.findMany({ omit: { passwordHash: false } });
const added = () => omitted.user.findMany({ omit: { email: true } });
type _selectOverrides = Expect<
  Equal<
    Awaited<ReturnType<typeof selected>>,
    { id: string; passwordHash: string }[]
  >
>;
type _localFalseRestores = Expect<
  Equal<
    Awaited<ReturnType<typeof restored>>,
    { id: string; email: string; passwordHash: string }[]
  >
>;
type _localTrueAdds = Expect<
  Equal<Awaited<ReturnType<typeof added>>, { id: string }[]>
>;

const createManyCount = () =>
  omitted.user.createMany({
    data: [{ id: "u3", email: "three@example.test", passwordHash: "three" }],
  });
const createManyRows = () =>
  omitted.user.createMany({
    data: [{ id: "u3", email: "three@example.test", passwordHash: "three" }],
    omit: { email: true },
  });
const updateManyCount = () =>
  omitted.user.updateMany({ data: { email: "bulk@example.test" } });
const updateManyRows = () =>
  omitted.user.updateMany({
    data: { email: "bulk@example.test" },
    omit: { email: true },
  });
const deleteManyCount = () => omitted.user.deleteMany({ where: { id: "u1" } });
const deleteManyRows = () =>
  omitted.user.deleteMany({ where: { id: "u1" }, omit: { email: true } });
type _createManyCount = Expect<
  Equal<Awaited<ReturnType<typeof createManyCount>>, { count: number }>
>;
type _createManyRows = Expect<
  Equal<Awaited<ReturnType<typeof createManyRows>>, { id: string }[]>
>;
type _updateManyCount = Expect<
  Equal<Awaited<ReturnType<typeof updateManyCount>>, { count: number }>
>;
type _updateManyRows = Expect<
  Equal<Awaited<ReturnType<typeof updateManyRows>>, { id: string }[]>
>;
type _deleteManyCount = Expect<
  Equal<Awaited<ReturnType<typeof deleteManyCount>>, { count: number }>
>;
type _deleteManyRows = Expect<
  Equal<Awaited<ReturnType<typeof deleteManyRows>>, { id: string }[]>
>;

const counted = () =>
  omitted.user.count({ select: { _all: true, email: true } });
const exists = () => omitted.user.exist({ where: { id: "u1" } });
const aggregated = () =>
  omitted.user.aggregate({ _count: true, _min: { email: true } });
const grouped = () => omitted.user.groupBy({ by: ["email"], _count: true });
type _countUnchanged = Expect<
  Equal<Awaited<ReturnType<typeof counted>>, { _all: number; email: number }>
>;
type _existUnchanged = Expect<
  Equal<Awaited<ReturnType<typeof exists>>, boolean>
>;
type _aggregateUnchanged = Expect<
  Equal<
    Awaited<ReturnType<typeof aggregated>>,
    { _count: number; _min: { email: string | null } }
  >
>;
type _groupByUnchanged = Expect<
  Equal<
    Awaited<ReturnType<typeof grouped>>,
    { email: string; _count: number }[]
  >
>;

const nested = () =>
  omitted.user.findMany({
    include: { posts: { include: { author: true } } },
  });
type _nestedDefaults = Expect<
  Equal<
    Awaited<ReturnType<typeof nested>>,
    {
      id: string;
      email: string;
      posts: {
        id: string;
        title: string;
        authorId: string;
        author: HiddenUser;
      }[];
    }[]
  >
>;

const recursive = () => omitted.node.findMany({ include: { children: true } });
type RecursiveRows = Awaited<ReturnType<typeof recursive>>;
type _recursiveRoot = Expect<
  Equal<keyof RecursiveRows[number], "id" | "parentId" | "children">
>;
type _recursiveChild = Expect<
  Equal<keyof RecursiveRows[number]["children"][number], "id" | "parentId">
>;

const directVariant = () =>
  omitted.board.findMany({ include: { pinned: true } });
type DirectVariant = Awaited<
  ReturnType<typeof directVariant>
>[number]["pinned"];
type _directVariant = Expect<
  Equal<
    DirectVariant,
    | {
        readonly type: "note";
        readonly data: { id: string; body: string };
      }
    | {
        readonly type: "image";
        readonly data: { id: string; url: string };
      }
  >
>;

const collectionVariant = () =>
  omitted.gallery.findMany({ include: { items: true } });
type CollectionVariant = Awaited<
  ReturnType<typeof collectionVariant>
>[number]["items"][number];
type _collectionVariant = Expect<
  Equal<
    CollectionVariant,
    | {
        readonly type: "note";
        readonly data: { id: string; body: string };
      }
    | {
        readonly type: "image";
        readonly data: { id: string; url: string };
      }
  >
>;

const callbackTransaction = () =>
  omitted.$transaction(async (tx) => {
    const root = await tx.user.findMany({});
    const nested = await tx.$transaction((inner) => inner.user.findMany({}));
    // @ts-expect-error - transaction clients cannot extend their chain
    tx.$extends(official);
    return { root, nested };
  });
type _callbackTransaction = Expect<
  Equal<
    Awaited<ReturnType<typeof callbackTransaction>>,
    { root: HiddenUser[]; nested: HiddenUser[] }
  >
>;

const arrayTransaction = () =>
  omitted.$transaction([omitted.user.findMany({}), omitted.post.findMany({})]);
type _arrayTransaction = Expect<
  Equal<
    Awaited<ReturnType<typeof arrayTransaction>>,
    [HiddenUser[], HiddenPost[]]
  >
>;

const cached = omitted.$extends(cache({ driver: new MemoryCache() }));
const cachedRows = () => cached.$withCache().user.findMany({});
type _cachedRows = Expect<
  Equal<Awaited<ReturnType<typeof cachedRows>>, HiddenUser[]>
>;

const after = omitted.$extends({
  name: "after-default-omit",
  request: {
    user: {
      findMany({ input }) {
        input.where;
        // @ts-expect-error - request transforms never see protected omit state
        input.omit;
        return { where: { email: { contains: "@" } } };
      },
    },
  },
  query: {
    user: {
      async findMany({ proceed }) {
        return proceed();
      },
    },
  },
  client(scope) {
    const rows = () => scope.user.findMany({});
    type _scopeRows = Expect<
      Equal<Awaited<ReturnType<typeof rows>>, HiddenUser[]>
    >;
    return { $hiddenUsers: rows };
  },
  model: {
    user(delegate) {
      const rows = () => delegate.findMany({});
      type _delegateRows = Expect<
        Equal<Awaited<ReturnType<typeof rows>>, HiddenUser[]>
      >;
      return { hidden: rows };
    },
  },
});
const afterRoot = () => after.user.findMany({});
const afterClientMethod = () => after.$hiddenUsers();
const afterModelMethod = () => after.user.hidden();
type _afterRoot = Expect<
  Equal<Awaited<ReturnType<typeof afterRoot>>, HiddenUser[]>
>;
type _afterClientMethod = Expect<
  Equal<Awaited<ReturnType<typeof afterClientMethod>>, HiddenUser[]>
>;
type _afterModelMethod = Expect<
  Equal<Awaited<ReturnType<typeof afterModelMethod>>, HiddenUser[]>
>;

const staleQuery = defineExtension<typeof schema>()({
  name: "stale-query",
  query: {
    user: {
      async findMany({ input, proceed }) {
        type _PasswordHashFilter = NonNullable<
          typeof input.where
        >["passwordHash"];
        return proceed();
      },
    },
  },
});
const safeGlobalQuery = defineExtension<typeof schema>()({
  name: "safe-global-query",
  query: async (context) => context.proceed(),
});
const staleClient = defineExtension<typeof schema>()({
  name: "stale-client",
  client(scope) {
    return { $fullUsers: () => scope.user.findMany({}) };
  },
});
const staleModel = defineExtension<typeof schema>()({
  name: "stale-model",
  model: {
    user(delegate) {
      return { full: () => delegate.findMany({}) };
    },
  },
});
// @ts-expect-error - its query context was fixed against the unomitted schema
omitted.$extends(staleQuery);
// @ts-expect-error - its client method was fixed against the unomitted schema
omitted.$extends(staleClient);
// @ts-expect-error - its model method was fixed against the unomitted schema
omitted.$extends(staleModel);

const omittedWithGlobalQuery = omitted.$extends(safeGlobalQuery);
const globallyInterceptedRows = () => omittedWithGlobalQuery.user.findMany({});
type _globalQueryKeepsOmittedResult = Expect<
  Equal<Awaited<ReturnType<typeof globallyInterceptedRows>>, HiddenUser[]>
>;

const safeReusable = defineExtension<typeof schema>()({
  name: "safe-reusable",
  request: ({ input }) => ({ ...input }),
  statement: ({ statement }) => statement,
  observe: (_unit, proceed) => proceed(),
});
omitted.$extends(safeReusable);

const baseRows = () => base.user.findMany({});
// @ts-expect-error - the unextended root has no contributed client method
base.$hiddenUsers();
// @ts-expect-error - the unextended model has no contributed model method
base.user.hidden();
const siblingRows = () =>
  base
    .$extends(defaultOmit<typeof schema>()({ user: { email: true } }))
    .user.findMany({});
type _baseUnchanged = Expect<
  Equal<
    Awaited<ReturnType<typeof baseRows>>,
    { id: string; email: string; passwordHash: string }[]
  >
>;
type _siblingIsolated = Expect<
  Equal<
    Awaited<ReturnType<typeof siblingRows>>,
    { id: string; passwordHash: string }[]
  >
>;

expectTypeOf(official.name).toEqualTypeOf<"viborm.defaultOmit">();
