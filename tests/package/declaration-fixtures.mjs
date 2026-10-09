/** Public producer/consumer fixtures shared by package gates and backend qualification. */
export function chainSource(count, ring = false) {
  const models = Array.from({ length: count }, (_, i) => {
    const previous =
      i > 0 || ring
        ? `parentId: s.string(), parent: s.toOne(() => m${(i + count - 1) % count}).fields("parentId").references("id"),`
        : "";
    const next =
      i < count - 1 || ring
        ? `children: s.toMany(() => m${(i + 1) % count}),`
        : "";
    return `export const m${i} = s.model({ id: s.string().id(), active: s.boolean(), rank: s.int(), ${previous} ${next} });`;
  });
  return `import { createClient, s } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
${models.join("\n")}
export const schema = { ${models.map((_, i) => `m${i}`).join(", ")} };
export const db = createClient({ schema, driver: new SQLite3Driver() });
export const load = () => db.m0.findUnique({ where: { id: "first" }, include: { children: { where: { active: true }, orderBy: { rank: "asc" }, take: 5 } } });
`;
}
export function backreferenceSource(entry = "./chain5.js", binding = "db") {
  return `import { ${binding} as db } from "${entry}";
type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type ClientNotAny = AssertFalse<IsAny<typeof db>>;
void db.m0.findMany({ where: { children: { some: { parent: { is: { id: "first" } } } } } });
// @ts-expect-error - the returned-to parent retains its string ID domain
void db.m0.findMany({ where: { children: { some: { parent: { is: { id: 123 } } } } } });
// @ts-expect-error - a nested field typo beside a real ID is structurally refused
void db.m0.findMany({ where: { children: { some: { parent: { is: { id: "first", idTypo: "wrong" } } } } } });
const heldWhere = { children: { some: { parent: { is: { id: "first", idTypo: "wrong" } } } } };
// @ts-expect-error - holding the filter cannot hide its nested field typo
void db.m0.findMany({ where: heldWhere });
void db.m0.findMany({ where: { AND: [{ children: { some: { parent: { is: { id: "first" } } } } }], OR: [{ id: "first" }], NOT: { id: "last" } } });
// @ts-expect-error - a logical array keeps the nested target's field keys
void db.m0.findMany({ where: { AND: [heldWhere] } });
void db.m0.findMany({ where: {} });
void db.m0.findMany({ where: { AND: [] } });
void db.m0.findMany({ where: undefined });
void db.m0.findMany({ where: { AND: undefined } });
void db.m0.findMany({ where: { children: undefined } });
declare const choose: boolean;
const heldGoodMaybe = choose ? { children: { some: { parent: { is: { id: "first" } } } } } : undefined;
void db.m0.findMany({ where: heldGoodMaybe });
const heldBadMaybe = choose ? heldWhere : undefined;
// @ts-expect-error - an optional held filter cannot hide its nested field typo
void db.m0.findMany({ where: heldBadMaybe });
void db.m1.findMany({ where: { parent: { id: "first" } } });
void db.m1.findMany({ where: { parent: { isNot: { id: "first" } } } });
// @ts-expect-error - shorthand to-one filters retain exact target field keys
void db.m1.findMany({ where: { parent: { id: "first", idTypo: "wrong" } } });
// @ts-expect-error - isNot filters retain exact target field keys
void db.m1.findMany({ where: { parent: { isNot: { id: "first", idTypo: "wrong" } } } });
export async function readBackreference() {
  const base = await db.m0.findMany();
  // @ts-expect-error - a relation is absent unless selected or included
  void base[0]!.children;
  const rows = await db.m0.findMany({ include: { children: { include: { parent: true } } } });
  const parent = rows[0]!.children[0]!.parent;
  type ParentNotAny = AssertFalse<IsAny<typeof parent>>;
  type IdNotAny = AssertFalse<IsAny<typeof parent.id>>;
  type NoExtraResultKey = AssertFalse<"idTypo" extends keyof typeof parent ? true : false>;
  const id: string = parent.id;
  const active: boolean = parent.active;
  const rank: number = parent.rank;
  // @ts-expect-error - the nested parent ID output remains a string
  const wrong: number = parent.id;
  // @ts-expect-error - nested parent results retain their declared field set
  const missing: string = parent.idTypo;
  return { id, active, rank, wrong, missing };
}
`;
}

export function factorySource() {
  return (
    chainSource(5) +
    `
import type { AnyDriver } from "viborm/driver";
import { createClient as createSQLiteClient } from "viborm/sqlite3";
export const makeClient = () => createClient({ schema, driver: new SQLite3Driver() });
export const makeClientWith = <D extends AnyDriver>(driver: D) => createClient({ schema, driver });
export const makeSQLiteClient = () => createSQLiteClient({ schema });
`
  );
}

export function factoryProbe(entry = "./factories.js") {
  return (
    `import { makeClient, makeClientWith, makeSQLiteClient } from "${entry}";
import { SQLite3Driver } from "viborm/sqlite3";
const plain = makeClient();
const generic = makeClientWith(new SQLite3Driver());
const wrapped = makeSQLiteClient();
` +
    backreferenceSource(entry).replace(
      `import { db as db } from "${entry}";`,
      "const db = plain;"
    ) +
    `
void generic.m0.findMany({ where: { children: { some: { parent: { is: { id: "first" } } } } } });
void wrapped.m0.findMany({ where: { children: { some: { parent: { is: { id: "first" } } } } } });
// @ts-expect-error - generic driver factories retain the target ID domain
void generic.m0.findMany({ where: { children: { some: { parent: { is: { id: 123 } } } } } });
// @ts-expect-error - provider convenience factories retain the target ID domain
void wrapped.m0.findMany({ where: { children: { some: { parent: { is: { id: 123 } } } } } });
export async function factoryResults() {
  const genericRows = await generic.m0.findMany({ include: { children: { include: { parent: true } } } });
  const wrappedRows = await wrapped.m0.findMany({ include: { children: { include: { parent: true } } } });
  const genericId: string = genericRows[0]!.children[0]!.parent.id;
  const wrappedId: string = wrappedRows[0]!.children[0]!.parent.id;
  const genericActive: boolean = genericRows[0]!.children[0]!.parent.active;
  const wrappedActive: boolean = wrappedRows[0]!.children[0]!.parent.active;
  const genericRank: number = genericRows[0]!.children[0]!.parent.rank;
  const wrappedRank: number = wrappedRows[0]!.children[0]!.parent.rank;
  type GenericFieldsNotAny = AssertFalse<IsAny<typeof genericRows[number]["children"][number]["parent"]["id"]> | IsAny<typeof genericRows[number]["children"][number]["parent"]["active"]> | IsAny<typeof genericRows[number]["children"][number]["parent"]["rank"]>>;
  type WrappedFieldsNotAny = AssertFalse<IsAny<typeof wrappedRows[number]["children"][number]["parent"]["id"]> | IsAny<typeof wrappedRows[number]["children"][number]["parent"]["active"]> | IsAny<typeof wrappedRows[number]["children"][number]["parent"]["rank"]>>;
  // @ts-expect-error - generic factory IDs cannot widen to number
  const wrongGenericId: number = genericRows[0]!.children[0]!.parent.id;
  // @ts-expect-error - provider factory IDs cannot widen to number
  const wrongWrappedId: number = wrappedRows[0]!.children[0]!.parent.id;
  // @ts-expect-error - generic factory results cannot gain undeclared fields
  void genericRows[0]!.children[0]!.parent.idTypo;
  // @ts-expect-error - provider factory results cannot gain undeclared fields
  void wrappedRows[0]!.children[0]!.parent.idTypo;
  return { genericId, wrappedId, genericActive, wrappedActive, genericRank, wrappedRank, wrongGenericId, wrongWrappedId };
}
`
  );
}

export const selfJunctionSource = `import { createClient, s } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
export const node = s.model({ id: s.string().id(), label: s.string(), parentId: s.string().nullable(), parent: s.toOne(() => node).name("tree").fields("parentId").references("id"), children: s.toMany(() => node).name("tree"), peers: s.toMany(() => node).name("peers"), peerOf: s.toMany(() => node).name("peers"), tags: s.toMany(() => tag) });
export const tag = s.model({ id: s.int().id(), label: s.string(), nodes: s.toMany(() => node) });
export const schema = { node, tag };
export const db = createClient({ schema, driver: new SQLite3Driver() });
`;

export const selfJunctionProbe = `import { db } from "./self-junction.js";
void db.node.findMany({ where: { children: { some: { parent: { is: { id: "root" } } } }, peers: { some: { peerOf: { some: { id: "peer" } } } } } });
// @ts-expect-error - self relation filters retain scalar domains
void db.node.findMany({ where: { children: { some: { parent: { is: { id: 123 } } } } } });
void db.node.findMany({ where: { tags: { some: { nodes: { some: { id: "node" } } } } } });
// @ts-expect-error - a cross-model junction backreference retains the node ID domain
void db.node.findMany({ where: { tags: { some: { nodes: { some: { id: 123 } } } } } });
// @ts-expect-error - the tag endpoint retains its distinct numeric ID domain
void db.node.findMany({ where: { tags: { some: { id: "wrong" } } } });
export async function selfResults() {
  const rows = await db.node.findMany({ include: { children: { include: { parent: true } }, peers: { include: { peerOf: true } }, tags: { include: { nodes: true } } } });
  const parent = rows[0]!.children[0]!.parent;
  const parentId: string | undefined = parent?.id;
  const peerId: string = rows[0]!.peers[0]!.peerOf[0]!.id;
  const tagId: number = rows[0]!.tags[0]!.id;
  const nodeId: string = rows[0]!.tags[0]!.nodes[0]!.id;
  // @ts-expect-error - cross-model junction results retain their endpoint domain
  const wrongNodeId: number = rows[0]!.tags[0]!.nodes[0]!.id;
  // @ts-expect-error - cross-model junction results retain exact fields
  void rows[0]!.tags[0]!.nodes[0]!.idTypo;
  // @ts-expect-error - nullable owning references stay nullable
  const requiredParentId: string = parent.id;
  // @ts-expect-error - self relation results retain exact fields
  void rows[0]!.peers[0]!.peerOf[0]!.idTypo;
  return { parentId, peerId, tagId, nodeId, wrongNodeId, requiredParentId };
}
`;

export const variantSource = `import { createClient, s } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
export const author = s.model({ id: s.string().id(), name: s.string(), posts: s.toMany(() => post) });
export const post = s.model({ id: s.string().id(), title: s.string(), authorId: s.string(), author: s.toOne(() => author).fields("authorId").references("id"), comments: s.toMany(() => comment).name("subject") });
export const video = s.model({ id: s.string().id(), duration: s.int(), comments: s.toMany(() => comment).name("subject") });
export const comment = s.model({ id: s.string().id(), body: s.string(), subject: s.toOne({ post: () => post, video: () => video }, { values: { post: "content.post.v1", video: "content.video.v1" } }).name("subject") });
export const collection = s.model({ id: s.string().id(), label: s.string(), items: s.toMany({ post: () => post, video: () => video }, { values: { post: "collection.post.v1", video: "collection.video.v1" } }) });
export const schema = { author, post, video, comment, collection };
export const db = createClient({ schema, driver: new SQLite3Driver() });
`;

export const variantProbe = `import { db } from "./variants.js";
type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
void db.comment.findMany({ where: { subject: { type: "post", is: { author: { is: { id: "author" } } } } } });
void db.comment.findMany({ where: { subject: { type: "video", is: { id: "video" } } } });
// @ts-expect-error - variants retain their declared compatible string ID domain
void db.comment.findMany({ where: { subject: { type: "video", is: { id: 123 } } } });
export async function variantResults() {
  const rows = await db.comment.findMany({ include: { subject: { post: { include: { author: true } }, video: true } } });
  const subject = rows[0]!.subject;
  if (subject.type === "post") {
    const id: string = subject.data.id;
    const authorId: string = subject.data.author.id;
    // @ts-expect-error - a post variant cannot gain a video field
    void subject.data.duration;
    return { id, authorId };
  }
  const id: string = subject.data.id;
  const duration: number = subject.data.duration;
  // @ts-expect-error - the video variant ID output remains a string
  const wrongId: number = subject.data.id;
  // @ts-expect-error - a video variant cannot gain a post field
  void subject.data.title;
  return { id, duration, wrongId };
}
void db.collection.findMany({ where: { items: { some: { type: "post", is: { author: { is: { id: "author" } } } } } } });
void db.collection.findMany({ where: { items: { some: { type: "video", is: { id: "video" } } } } });
// @ts-expect-error - collection variants retain their string ID input domain
void db.collection.findMany({ where: { items: { some: { type: "video", is: { id: 123 } } } } });
// @ts-expect-error - a collection cannot invent a discriminator
void db.collection.findMany({ where: { items: { some: { type: "podcast", is: { id: "wrong" } } } } });
export async function collectionVariantResults() {
  const rows = await db.collection.findMany({ include: { items: { variants: { post: { include: { author: true } }, video: true } } } });
  const item = rows[0]!.items[0]!;
  type ItemNotAny = AssertFalse<IsAny<typeof item>>;
  type DiscriminatorNotAny = AssertFalse<IsAny<typeof item.type>>;
  type DataNotAny = AssertFalse<IsAny<typeof item.data>>;
  if (item.type === "post") {
    const id: string = item.data.id;
    const title: string = item.data.title;
    const authorId: string = item.data.author.id;
    type PostIdNotAny = AssertFalse<IsAny<typeof item.data.id>>;
    type AuthorIdNotAny = AssertFalse<IsAny<typeof item.data.author.id>>;
    // @ts-expect-error - the post collection arm cannot gain video fields
    void item.data.duration;
    // @ts-expect-error - a collection backreference keeps its declared ID output
    const wrongAuthorId: number = item.data.author.id;
    return { id, title, authorId, wrongAuthorId };
  }
  const id: string = item.data.id;
  const duration: number = item.data.duration;
  type VideoIdNotAny = AssertFalse<IsAny<typeof item.data.id>>;
  // @ts-expect-error - the video collection arm cannot gain post fields
  void item.data.title;
  // @ts-expect-error - collection member IDs cannot widen to number
  const wrongId: number = item.data.id;
  return { id, duration, wrongId };
}
`;

// The same complete probe first passes on producer source, then demonstrates
// exactly what is lost when an application rebuilds from emitted plain models.
export const lossyModelsControl = backreferenceSource().replace(
  'import { db as db } from "./chain5.js";',
  `import { schema } from "./chain5.js";
import { createClient } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
const db = createClient({ schema, driver: new SQLite3Driver() });`
);

export const modifierSource = `import { createClient, defineExtension, s } from "viborm";
import { defaultOmit } from "viborm/client";
import { cache } from "viborm/cache";
import { MemoryCache } from "viborm/cache/memory";
import { SQLite3Driver } from "viborm/sqlite3";
export const parent = s.model({ tenantId: s.string(), localId: s.string(), email: s.string(), name: s.string(), modelSecret: s.string(), children: s.toMany(() => child) }).id(["tenantId", "localId"], { name: "parent_pk" }).unique(["tenantId", "email"], { name: "tenant_email" }).omit({ modelSecret: true }).index(["name"], { name: "parent_name", type: "btree" }).index(["tenantId", "name"], { name: "parent_tenant_name", unique: true }).map("linked_parents");
export const child = s.model({ id: s.string().id(), tenantId: s.string(), parentId: s.string(), title: s.string(), secret: s.string(), parent: s.toOne(() => parent).fields("tenantId", "parentId").references("tenantId", "localId") }).index(["tenantId", "parentId"], { name: "child_parent" }).map("linked_children");
export const schema = { parent, child };
export const db = createClient({ schema, driver: new SQLite3Driver() }).$extends(defaultOmit<typeof schema>()({ child: { secret: true } })).$extends(defineExtension({ name: "ready", client: () => ({ $ready: () => true }) })).$extends(cache({ driver: new MemoryCache() }));
`;

export const modifierProbe = `import { db } from "./modifiers.js";
import type { RelationLinks } from "viborm";
type IsAny<T> = 0 extends (1 & T) ? true : false;
type AssertFalse<T extends false> = T;
type Assert<T extends true> = T;
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type ClientLinks = RelationLinks<typeof db.$schema>;
type ChildrenTarget = Assert<Same<ClientLinks["parent"]["children"], "child">>;
type ParentTarget = Assert<Same<ClientLinks["child"]["parent"], "parent">>;
// @ts-expect-error - index state cannot widen the literal target key
const wrongChildKey: ClientLinks["parent"]["children"] = "parent";
type ParentIndexes = typeof db.$schema.parent["~"]["state"]["indexes"];
type LastTwo = ParentIndexes extends [...unknown[], infer A, infer B] ? [A, B] : never;
type FirstIndexKeys = Assert<Same<LastTwo[0]["fields"], ["name"]>>;
type SecondIndexKeys = Assert<Same<LastTwo[1]["fields"], ["tenantId", "name"]>>;
type FirstIndexName = Assert<Same<LastTwo[0]["options"]["name"], string>>;
type FirstIndexKind = Assert<Same<LastTwo[0]["options"]["type"], "btree">>;
type SecondIndexName = Assert<Same<LastTwo[1]["options"]["name"], string>>;
type SecondIndexUnique = Assert<Same<LastTwo[1]["options"]["unique"], true>>;
type ChildIndexes = typeof db.$schema.child["~"]["state"]["indexes"];
type LastChild = ChildIndexes extends [...unknown[], infer I] ? I : never;
type ChildIndexKeys = Assert<Same<LastChild["fields"], ["tenantId", "parentId"]>>;
const ready: boolean = db.$ready();
const table: "linked_parents" = db.$schema.parent["~"].state.tableName;
void db.parent.findUnique({ where: { parent_pk: { tenantId: "tenant", localId: "parent" } } });
void db.parent.findUnique({ where: { tenant_email: { tenantId: "tenant", email: "p@example.test" } } });
// @ts-expect-error - compound selectors retain each scalar domain
void db.parent.findUnique({ where: { parent_pk: { tenantId: "tenant", localId: 123 } } });
export async function modifiedResults() {
  const rows = await db.parent.findMany({ include: { children: { include: { parent: true } } } });
  const nested = rows[0]!.children[0]!.parent;
  const id: string = nested.localId;
  type ParentNotAny = AssertFalse<IsAny<typeof nested>>;
  type IdNotAny = AssertFalse<IsAny<typeof nested.localId>>;
  // @ts-expect-error - indexed backreferences retain their exact ID domain
  const wrongId: number = nested.localId;
  // @ts-expect-error - model omit is preserved through linked backreferences
  void nested.modelSecret;
  // @ts-expect-error - official default omit applies to included children
  void rows[0]!.children[0]!.secret;
  const cached = await db.$withCache().child.findMany({ include: { parent: true } });
  const cachedId: string = cached[0]!.parent.localId;
  // @ts-expect-error - cache view retains official default omit
  void cached[0]!.secret;
  const transaction = await db.$transaction(async (tx) => {
    const children = await tx.child.findMany({ include: { parent: true } });
    const parentId: string = children[0]!.parent.localId;
    // @ts-expect-error - callback transaction view retains default omit
    void children[0]!.secret;
    // @ts-expect-error - callback transaction view retains model omit
    void children[0]!.parent.modelSecret;
    return parentId;
  });
  const transactionId: string = transaction;
  return { id, cachedId, transactionId, ready, table };
}
`;

/** Construct all public views while refusing even a first provider initialization. */
export function constructionSource(fixture) {
  return `import assert from "node:assert/strict";
import { SQLite3Driver } from "viborm/sqlite3";
const prototype = SQLite3Driver.prototype;
const initialize = Object.getOwnPropertyDescriptor(prototype, "initClient");
assert.ok(initialize, "the fixture must guard the actual provider initialization entry");
let initializationCalls = 0;
Object.defineProperty(prototype, "initClient", {
  ...initialize,
  value() { initializationCalls++; throw new Error("Construction attempted provider I/O"); },
});
try {
  const fixture = await import("./${fixture}.ts");
  const check = (client, driver = client.$driver) => {
    assert.equal(client.$schema, fixture.schema);
    assert.equal(client.$driver, driver);
    assert.ok(driver instanceof SQLite3Driver);
    assert.equal(driver.dialect, "sqlite");
    assert.equal(typeof client.$transaction, "function");
    assert.equal(typeof client.$queryRaw, "function");
    assert.equal(typeof client.$connect, "function");
    assert.equal(typeof client.$disconnect, "function");
    assert.deepEqual(Object.keys(client.$schema), Object.keys(fixture.schema));
    for (const [name, model] of Object.entries(fixture.schema)) {
      assert.equal(client.$schema[name], fixture[name]);
      assert.equal(client.$schema[name], model);
      assert.equal(typeof client[name].findMany, "function");
    }
  };
  check(fixture.db);
  const extended = fixture.db.$extends({ name: "construction-check", client: () => ({ $constructionCheck: () => true }) });
  check(extended, fixture.db.$driver);
  assert.equal(extended.$constructionCheck(), true);
  assert.equal(fixture.db.$constructionCheck, undefined);
  ${
    fixture === "factories"
      ? `const driver = new SQLite3Driver();
  check(fixture.makeClient());
  check(fixture.makeClientWith(driver), driver);
  check(fixture.makeSQLiteClient());`
      : fixture === "modifiers"
        ? `assert.equal(fixture.db.$ready(), true);
  assert.equal(extended.$ready(), true);
  assert.equal(fixture.db.$schema.parent["~"].state.tableName, "linked_parents");
  assert.equal(fixture.db.$schema.child["~"].state.tableName, "linked_children");
  assert.deepEqual(fixture.parent["~"].state.indexes, [
    { fields: ["name"], options: { name: "parent_name", type: "btree" } },
    { fields: ["tenantId", "name"], options: { name: "parent_tenant_name", unique: true } },
  ]);
  assert.deepEqual(fixture.child["~"].state.indexes, [
    { fields: ["tenantId", "parentId"], options: { name: "child_parent" } },
  ]);
  assert.equal(typeof fixture.db.$withCache, "function");
  const cached = fixture.db.$withCache();
  assert.notEqual(cached, fixture.db);
  assert.equal(typeof cached.parent.findMany, "function");
  assert.equal(typeof cached.child.findMany, "function");`
        : "assert.equal(fixture.db.$withCache, undefined);"
  }
  assert.equal(initializationCalls, 0);
  console.log("${fixture} topology: pass");
} finally {
  Object.defineProperty(prototype, "initClient", initialize);
}
`;
}

/** Recursive JSON results retain their broad and finite declared domains. */
export const jsonSource = `import { createClient, s, type JsonValue } from "viborm";
import { SQLite3Driver } from "viborm/sqlite3";
import type { StandardSchemaV1 } from "@standard-schema/spec";
const broad: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": { version: 1, vendor: "json-result-probe", validate: () => Promise.reject(new Error("unsupported async validator")) },
};
const finite: StandardSchemaV1<JsonValue, { mode: "stored"; nested: { enabled: boolean } }> = {
  "~standard": { version: 1, vendor: "json-result-probe", validate: () => ({ value: { mode: "stored", nested: { enabled: true } } }) },
};
const document = s.model({ id: s.int().id(), payload: s.json().schema(broad), nullablePayload: s.json().schema(broad).nullable(), finite: s.json().schema(finite) }).map("json_result_documents");
export const db = createClient({ schema: { document }, driver: new SQLite3Driver() });
export const makeClient = () => createClient({ schema: { document }, driver: new SQLite3Driver() });
export const read = async () => (await db.document.findUnique({ where: { id: 1 } }))?.payload;
export const readMany = async () => (await db.document.findMany()).map(row => row.payload);
`;

export const jsonProbe = `import { db, makeClient, read, readMany } from "./json.js";
import type { JsonValue } from "viborm";
type IsAny<T> = 0 extends 1 & T ? true : false;
declare const payload: Awaited<ReturnType<typeof read>>;
declare const many: Awaited<ReturnType<typeof readMany>>;
declare const payloadIsAny: IsAny<typeof payload>;
declare const manyLeafIsAny: IsAny<(typeof many)[number]>;
const noAny: false = payloadIsAny;
const noManyAny: false = manyLeafIsAny;
const admitted: JsonValue | undefined = payload;
const manyDomain: JsonValue[] = many;
const sameDomain: typeof payload = { nested: [null, { deep: [true, 1, "value"] }] };
const absent: typeof payload = undefined;
// @ts-expect-error - recursive JSON domain rejects foreign value objects
const badDocument: typeof payload = new Date();
// @ts-expect-error - JSON result is not an arbitrary scalar number
const badScalar: number = payload;
export async function inspect() {
  const full = await makeClient().document.findUnique({ where: { id: 1 } });
  const nullable: JsonValue | undefined = full?.nullablePayload;
  const refined: "stored" | undefined = full?.finite.mode;
  // @ts-expect-error - finite custom JSON retains its refinement
  const badRefined: "wrong" | undefined = full?.finite.mode;
  const selected = await db.document.findUnique({ where: { id: 1 }, select: { payload: true } });
  // @ts-expect-error - preserved JSON does not widen a selected result
  const excluded = selected?.finite;
  // @ts-expect-error - exact public selector retains number scalar domain
  await db.document.findUnique({ where: { id: "one" } });
  return { nullable, refined, selected };
}
void [noAny, noManyAny, admitted, manyDomain, sameDomain, absent, badDocument, badScalar];
`;
