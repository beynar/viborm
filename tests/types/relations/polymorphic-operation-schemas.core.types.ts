import { s } from "@src/schema";
import v, { createSchemaRegistry } from "@src/validation";
import {
  polymorphicCreateFactory,
  polymorphicFilterFactory,
  polymorphicUpdateFactory,
} from "@src/validation/relations/polymorphic";
import type { InferInput, InferOutput } from "@src/validation/types";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() =>
    Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const post = s.model({ id: s.string().id(), title: s.string() });
const video = s.model({ id: s.string().id(), duration: s.int() });
const relation = s
  .polymorphic(
    { post: () => post, video: () => video },
    { values: { post: "post.v1", video: "video.v1" } }
  )
  .optional();
const postSchemas = {
  core: {
    create: v.object({ id: v.string(), title: v.string() }),
    where: v.object({ title: v.string() }),
    whereUnique: v.object({ id: v.string() }),
    select: v.object({ id: v.boolean(), title: v.boolean() }),
    include: v.object({}),
    omit: v.object({ id: v.boolean(), title: v.boolean() }),
  },
};
const videoSchemas = {
  core: {
    create: v.object({ id: v.string(), duration: v.number() }),
    where: v.object({ duration: v.number() }),
    whereUnique: v.object({ id: v.string() }),
    select: v.object({ id: v.boolean(), duration: v.boolean() }),
    include: v.object({}),
    omit: v.object({ id: v.boolean(), duration: v.boolean() }),
  },
};
const getters = {
  post: () => postSchemas,
  video: () => videoSchemas,
};

const createSchema = polymorphicCreateFactory(relation["~"].state, getters);
const updateSchema = polymorphicUpdateFactory(relation["~"].state, getters);
const filterSchema = polymorphicFilterFactory(relation["~"].state, getters);

type CreateInput = InferInput<typeof createSchema>;
type UpdateInput = InferInput<typeof updateSchema>;
type FilterInput = InferInput<typeof filterSchema>;

const mixedCreate = {
  connect: { type: "post", where: { id: "post-1" } },
  create: { type: "post", data: { id: "post-2", title: "new" } },
} as const;
// @ts-expect-error - a non-fresh payload cannot carry two create intents
const _mixedCreate: CreateInput = mixedCreate;

const mixedUpdate = {
  connect: { type: "post", where: { id: "post-1" } },
  disconnect: true,
} as const;
// @ts-expect-error - a non-fresh payload cannot connect and disconnect
const _mixedUpdate: UpdateInput = mixedUpdate;

const mixedFilter = {
  type: "post",
  is: { title: "one" },
  isNot: { title: "two" },
} as const;
// @ts-expect-error - a non-fresh correlated filter has one predicate intent
const _mixedFilter: FilterInput = mixedFilter;

const auditLog = s.model({ id: s.string().id() });
const folder = s.model({
  id: s.string().id(),
  entries: s.oneToMany(() => folderEntry).name("folderEntry"),
});
const folderEntry = s.model({
  id: s.string().id(),
  folder: s
    .polymorphic(
      { folder: () => folder },
      { values: { folder: "folder.entry.v1" } }
    )
    .name("folderEntry"),
  audit: s.polymorphic(
    { auditLog: () => auditLog },
    { values: { auditLog: "audit.log.v1" } }
  ),
});
const inverseRegistry = createSchemaRegistry({ auditLog, folder, folderEntry });
type FolderCreate = InferInput<typeof inverseRegistry.proxy.folder.core.create>;
type FolderCreateOutput = InferOutput<
  typeof inverseRegistry.proxy.folder.core.create
>;
type InverseCreateOutput = NonNullable<
  NonNullable<FolderCreateOutput["entries"]>["create"]
>;
type InverseChildOutput = InverseCreateOutput extends readonly (infer Child)[]
  ? Child
  : InverseCreateOutput;
type _injectedOwnerIsAbsentFromParsedChild = Expect<
  Equal<Extract<"folder", keyof InverseChildOutput>, never>
>;
type _remainingRelationStaysInParsedChild = Expect<
  Equal<Extract<"audit", keyof InverseChildOutput>, "audit">
>;

const validInverseCreate: FolderCreate = {
  id: "folder-1",
  entries: {
    create: {
      id: "entry-1",
      audit: { connect: { type: "auditLog", where: { id: "audit-1" } } },
    },
  },
};

const invalidInverseCreate: FolderCreate = {
  id: "folder-1",
  entries: {
    // @ts-expect-error - inverse injection removes only the folder requirement
    create: { id: "entry-1" },
  },
};

void [validInverseCreate, invalidInverseCreate];
