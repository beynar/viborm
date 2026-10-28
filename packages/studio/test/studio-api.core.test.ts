import { createClient } from "@client/client";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createStudioApi,
  MAX_EXPORT_ROWS,
  MAX_PAGE_SIZE,
  toCsv,
} from "../src/api";
import { describeSchema } from "../src/schema";

// One schema with each relation shape the studio draws and follows:
// user ↔ profile (one to one), user → post (one to many), post ↔ tag (many to many).
const user = s.model({
  id: s.int().id().increment(),
  email: s.string().unique(),
  name: s.string(),
  role: s.enum(["reader", "author"]).default("reader"),
  karma: s.bigInt().default(0n),
  avatar: s.blob().nullable(),
  profile: s.toOne(() => profile),
  posts: s.toMany(() => post),
  sessions: s.toMany(() => session),
});
// A nullable foreign key, and a format that names a domain without generating.
const session = s.model({
  id: s.int().id().increment(),
  token: s.string().ulid(),
  userId: s.int().nullable(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});
const profile = s.model({
  id: s.int().id().increment(),
  bio: s.string().nullable(),
  userId: s.int().unique(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});
const post = s.model({
  id: s.int().id().increment(),
  title: s.string(),
  rating: s.decimal({ precision: 4, scale: 2 }).nullable(),
  createdAt: s.dateTime().now(),
  authorId: s.int(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  tags: s.toMany(() => tag),
});
const tag = s.model({
  id: s.int().id().increment(),
  label: s.string().unique(),
  posts: s.toMany(() => post),
});
const membership = s
  .model({
    orgId: s.int(),
    memberId: s.int(),
    title: s.string(),
  })
  .id(["orgId", "memberId"]);

// No primary key: rows can be read, not addressed.
const reading = s.model({ value: s.int().unique() });

const schema = { user, profile, post, tag, membership, reading, session };
const client = createClient({ schema, driver: createInMemorySQLite3Driver() });
const api = createStudioApi({ client, models: schema, dialect: "sqlite" });

const call = (method: string, path: string, body?: unknown) =>
  api.handle({ method, path, body });
const FIRST_POST_LINE = /^1,Engines,4\.5,\d{4}-/;
const errorCode = (response: { body: unknown }) =>
  (response.body as { error: { code: string } }).error.code;

beforeAll(async () => {
  // A model without an id is advice at the DDL boundary (M001), not an error.
  await syncLiveSchema(client, { skipValidation: true });
  const ada = await client.user.create({
    data: { email: "ada@example.com", name: "Ada", role: "author" },
  });
  const bob = await client.user.create({
    data: { email: "bob@example.com", name: "Bob" },
  });
  await client.profile.create({ data: { bio: "Analyst", userId: ada.id } });
  await client.post.create({
    data: {
      title: "Engines",
      rating: "4.50",
      authorId: ada.id,
      tags: { create: [{ label: "math" }, { label: "history" }] },
    },
  });
  await client.post.create({ data: { title: "Notes", authorId: ada.id } });
  await client.post.create({ data: { title: "Hello", authorId: bob.id } });
  await client.membership.create({
    data: { orgId: 1, memberId: 2, title: "Owner" },
  });
  await client.reading.create({ data: { value: 7 } });
});

afterAll(() => client.$disconnect());

describe("schema extraction", () => {
  const described = describeSchema(schema, "sqlite");
  const model = (name: string) =>
    described.models.find((entry) => entry.name === name)!;

  test("columns carry type, nullability, keys and generators", () => {
    const fields = Object.fromEntries(
      model("user").fields.map((field) => [field.name, field])
    );
    expect(fields.id).toMatchObject({
      type: "int",
      id: true,
      optional: true,
      generated: "increment",
    });
    expect(fields.email).toMatchObject({ unique: true, optional: false });
    expect(fields.role).toMatchObject({
      type: "enum",
      enumValues: ["reader", "author"],
      optional: true,
    });
    expect(fields.avatar).toMatchObject({ type: "blob", nullable: true });
    const token = model("session").fields.find(
      (field) => field.name === "token"
    );
    // A compact identifier compares but has no substring to search.
    expect(token).toMatchObject({ optional: false, searchable: false });
    expect(token).not.toHaveProperty("generated");
    expect(fields.email).toMatchObject({ searchable: true });
    expect(fields.karma).toMatchObject({ searchable: false });
    // A `.now()` creation timestamp is insert-only, as the client keeps it.
    const created = model("post").fields.find(
      (field) => field.name === "createdAt"
    );
    expect([created?.updatable, fields.karma?.updatable]).toEqual([
      false,
      true,
    ]);
    expect(model("user").key).toEqual({ fields: ["id"] });
    expect(model("membership").key).toEqual({
      name: "orgId_memberId",
      fields: ["orgId", "memberId"],
    });
    expect(model("reading").key).toBeUndefined();
  });

  test("relations know their partner and who holds the key", () => {
    const relations = Object.fromEntries(
      model("post").relations.map((relation) => [relation.name, relation])
    );
    expect(relations.author).toEqual({
      name: "author",
      cardinality: "one",
      targets: ["user"],
      storage: "foreignKey",
      owner: true,
      fields: ["authorId"],
      references: ["id"],
      inverse: "posts",
      inverseCardinality: "many",
    });
    expect(relations.tags).toMatchObject({
      storage: "junction",
      targets: ["tag"],
      inverse: "posts",
      inverseCardinality: "many",
    });
  });

  test("each resolved edge is drawn once, with crow's foot ends", () => {
    const edges = Object.fromEntries(
      described.edges.map((edge) => [edge.id, edge])
    );
    expect(Object.keys(edges).sort()).toEqual([
      "post.author",
      "post.tags",
      "profile.user",
      "session.user",
    ]);
    expect(edges["session.user"]).toMatchObject({
      kind: "one-to-many",
      toEnd: "zero-or-one",
    });
    expect(edges["profile.user"]).toMatchObject({
      kind: "one-to-one",
      from: { model: "profile", columns: ["userId"] },
      to: { model: "user", relation: "profile", columns: ["id"] },
      fromEnd: "zero-or-one",
      toEnd: "one",
    });
    expect(edges["post.author"]).toMatchObject({
      kind: "one-to-many",
      fromEnd: "zero-or-many",
      toEnd: "one",
    });
    expect(edges["post.tags"]).toMatchObject({
      kind: "many-to-many",
      from: { model: "post", relation: "tags", columns: ["id"] },
      to: { model: "tag", relation: "posts", columns: ["id"] },
      junction: expect.any(String),
    });
  });

  test("the schema route answers the same description", async () => {
    const response = await call("GET", "/schema");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ...described,
      readonly: false,
      project: "",
    });
  });
});

describe("browsing", () => {
  test("a page holds rows, the total and each to-many count", async () => {
    const response = await call("POST", "/models/user/rows", {
      take: 1,
      orderBy: [{ name: "asc" }],
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 2,
      rows: [{ name: "Ada", karma: 0n, _count: { posts: 2 } }],
    });
  });

  test("where, search and orderBy reach the client", async () => {
    const filtered = await call("POST", "/models/post/rows", {
      where: { title: { startsWith: "E" } },
    });
    expect(filtered.body).toMatchObject({
      total: 1,
      rows: [{ title: "Engines", _count: { tags: 2 } }],
    });
    const searched = await call("POST", "/models/post/rows", {
      search: "ote",
    });
    expect(searched.body).toMatchObject({
      total: 1,
      rows: [{ title: "Notes" }],
    });
    const sorted = await call("POST", "/models/post/rows", {
      orderBy: { title: "desc" },
    });
    const titles = (sorted.body as { rows: { title: string }[] }).rows.map(
      (row) => row.title
    );
    expect(titles).toEqual(["Notes", "Hello", "Engines"]);
  });

  test("relations are followed through their partner slot", async () => {
    // Ada's posts, her profile, and the tags of her first post.
    const posts = await call("POST", "/models/post/rows", {
      where: { author: { is: { id: 1 } } },
    });
    expect((posts.body as { total: number }).total).toBe(2);
    const tags = await call("POST", "/models/tag/rows", {
      where: { posts: { some: { title: "Engines" } } },
    });
    expect((tags.body as { total: number }).total).toBe(2);
    const profiles = await call("POST", "/models/profile/rows", {
      where: { user: { is: { id: 1 } } },
    });
    expect(profiles.body).toMatchObject({ rows: [{ bio: "Analyst" }] });
  });

  test("a search narrows a filter, and finds nothing to search in a model without text", async () => {
    const both = await call("POST", "/models/post/rows", {
      where: { authorId: 1 },
      search: "Eng",
    });
    expect(both.body).toMatchObject({ total: 1, rows: [{ title: "Engines" }] });
    const numeric = await call("POST", "/models/reading/rows", {
      search: "7",
    });
    expect(numeric.body).toMatchObject({ total: 1, rows: [{ value: 7 }] });
    // Case is matched unless the search ignores it.
    const exact = await call("POST", "/models/post/rows", { search: "eng" });
    expect(exact.body).toMatchObject({ total: 0 });
    const folded = await call("POST", "/models/post/rows", {
      search: "eng",
      ignoreCase: true,
    });
    expect(folded.body).toMatchObject({
      total: 1,
      rows: [{ title: "Engines" }],
    });
    // A ulid column is no text to search: the search leaves it out.
    const compact = await call("POST", "/models/session/rows", {
      search: "Ada",
    });
    expect(compact.status).toBe(200);
  });

  test("an empty body reads the first page, unordered when there is no key", async () => {
    const response = await call("POST", "/models/reading/rows");
    expect(response.body).toEqual({ rows: [{ value: 7 }], total: 1 });
  });

  test("skip and take page through a stable order", async () => {
    const first = await call("POST", "/models/post/rows", { skip: 0, take: 2 });
    const second = await call("POST", "/models/post/rows", {
      skip: 2,
      take: 2,
    });
    const ids = [first, second].flatMap((page) =>
      (page.body as { rows: { id: number }[] }).rows.map((row) => row.id)
    );
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe("editing", () => {
  test("create, update and delete go through the client", async () => {
    const created = await call("POST", "/models/tag/create", {
      data: { label: "draft" },
    });
    expect(created.status).toBe(200);
    const { id } = (created.body as { row: { id: number } }).row;
    const updated = await call("POST", "/models/tag/update", {
      key: { id },
      data: { label: "final" },
    });
    expect(updated.body).toMatchObject({ row: { id, label: "final" } });
    const deleted = await call("POST", "/models/tag/delete", { key: { id } });
    expect(deleted.body).toMatchObject({ row: { id, label: "final" } });
    expect(await client.tag.findUnique({ where: { id } })).toBeNull();
  });

  test("text forms of bigint, decimal and bytes are typed for the client", async () => {
    const updated = await call("POST", "/models/user/update", {
      key: { id: 2 },
      data: { karma: "9007199254740993", avatar: "AAEC" },
    });
    expect(updated.status).toBe(200);
    const row = await client.user.findUnique({ where: { id: 2 } });
    expect(row?.karma).toBe(9_007_199_254_740_993n);
    expect(row?.avatar).toEqual(new Uint8Array([0, 1, 2]));
    const rated = await call("POST", "/models/post/update", {
      key: { id: 3 },
      data: { rating: "3.25" },
    });
    expect(
      String((rated.body as { row: { rating: unknown } }).row.rating)
    ).toBe("3.25");
  });

  test("a compound key addresses its row through the named selector", async () => {
    const updated = await call("POST", "/models/membership/update", {
      key: { orgId: 1, memberId: 2 },
      data: { title: "Admin" },
    });
    expect(updated.body).toMatchObject({ row: { title: "Admin" } });
  });

  test("defaults and generators fill what a create leaves out", async () => {
    const created = await call("POST", "/models/user/create", {
      data: { email: "cy@example.com", name: "Cy" },
    });
    expect(created.body).toMatchObject({
      row: { role: "reader", karma: 0n, _count: { posts: 0 } },
    });
  });
});

describe("refusals", () => {
  test("unknown routes, models and methods", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    const unknown = await call("POST", "/models/constructor/rows", {});
    expect([unknown.status, errorCode(unknown)]).toEqual([
      404,
      "unknown_model",
    ]);
    expect((await call("GET", "/models/user/rows")).status).toBe(405);
    expect((await call("POST", "/schema")).status).toBe(405);
  });

  test("a row without a key cannot be updated or deleted", async () => {
    const response = await call("POST", "/models/reading/delete", {
      key: { value: 7 },
    });
    expect([response.status, errorCode(response)]).toEqual([400, "no_key"]);
  });

  test("bodies, pages and searches of the wrong shape", async () => {
    for (const [body, code] of [
      [[], "invalid_body"],
      [{ take: 0 }, "invalid_take"],
      [{ take: MAX_PAGE_SIZE + 1 }, "invalid_take"],
      [{ skip: -1 }, "invalid_skip"],
      [{ skip: 1.5 }, "invalid_skip"],
      [{ where: [] }, "invalid_where"],
      [{ search: 3 }, "invalid_search"],
      [{ ignoreCase: "yes" }, "invalid_ignore_case"],
    ] as const) {
      const response = await call("POST", "/models/user/rows", body);
      expect([response.status, errorCode(response)]).toEqual([400, code]);
    }
  });

  test("the client's own validation refuses what it does not admit", async () => {
    const where = await call("POST", "/models/user/rows", {
      where: { name: "Ada", nmae: "Ada" },
    });
    expect([where.status, errorCode(where)]).toEqual([400, "V4001"]);
    const order = await call("POST", "/models/user/rows", {
      orderBy: { nope: "asc" },
    });
    expect(order.status).toBe(400);
    const data = await call("POST", "/models/user/create", {
      data: { email: "x@example.com" },
    });
    expect(data.status).toBe(400);
    const listed = await call("POST", "/models/user/rows", {
      orderBy: ["name"],
    });
    expect(listed.status).toBe(400);
    const shapeless = await call("POST", "/models/user/create", { data: 1 });
    expect([shapeless.status, errorCode(shapeless)]).toEqual([
      400,
      "invalid_data",
    ]);
  });

  test("an update or delete names exactly one row by its key", async () => {
    for (const key of [undefined, { id: 1, email: "ada@example.com" }, {}, 1]) {
      const response = await call("POST", "/models/user/delete", { key });
      expect([response.status, errorCode(response)]).toEqual([
        400,
        "invalid_key",
      ]);
    }
    const missing = await call("POST", "/models/user/delete", {
      key: { id: 999 },
    });
    expect(missing.status).toBe(404);
  });

  test("bytes must be base64 and constraint failures are conflicts", async () => {
    const bytes = await call("POST", "/models/user/update", {
      key: { id: 1 },
      data: { avatar: "not base64!" },
    });
    expect([bytes.status, errorCode(bytes)]).toEqual([400, "invalid_data"]);
    const duplicate = await call("POST", "/models/user/update", {
      key: { id: 2 },
      data: { email: "ada@example.com" },
    });
    expect(duplicate.status).toBe(409);
  });
});

describe("variant relations", () => {
  const article = s.model({
    id: s.int().id(),
    comments: s.toMany(() => comment).name("subject"),
    shelves: s.toMany(() => shelf).name("items"),
  });
  const video = s.model({ id: s.int().id() });
  const comment = s.model({
    id: s.int().id(),
    subject: s
      .toOne({ article: () => article, video: () => video })
      .name("subject"),
  });
  const shelf = s.model({
    id: s.int().id(),
    items: s
      .toMany({ article: () => article, video: () => video })
      .name("items"),
  });
  const variants = { article, video, comment, shelf };
  const variantClient = createClient({
    schema: variants,
    driver: createInMemorySQLite3Driver(),
  });
  const described = describeSchema(variants, "sqlite");
  const relation = (model: string, name: string) =>
    described.models
      .find((entry) => entry.name === model)!
      .relations.find((entry) => entry.name === name);

  test("a carrier reaches every member; a member's inverse reaches the carrier", () => {
    expect(relation("comment", "subject")).toEqual({
      name: "subject",
      cardinality: "one",
      targets: ["article", "video"],
      storage: "variant",
      owner: false,
      fields: [],
      references: [],
      variants: [
        {
          name: "article",
          target: "article",
          inverse: "comments",
          inverseCardinality: "many",
        },
        { name: "video", target: "video" },
      ],
    });
    expect(relation("article", "comments")).toEqual({
      name: "comments",
      cardinality: "many",
      targets: ["comment"],
      storage: "variant",
      owner: false,
      fields: [],
      references: [],
      inverse: "subject",
      inverseCardinality: "one",
      variant: "article",
    });
    expect(relation("shelf", "items")?.targets).toEqual(["article", "video"]);
    expect(relation("article", "shelves")).toMatchObject({
      inverse: "items",
      inverseCardinality: "many",
      variant: "article",
    });
  });

  test("a polymorphic to-one reads its variant and key; a collection is counted", async () => {
    await syncLiveSchema(variantClient);
    await variantClient.article.create({ data: { id: 1 } });
    await variantClient.video.create({ data: { id: 1 } });
    await variantClient.comment.create({
      data: {
        id: 1,
        subject: { connect: { type: "video", where: { id: 1 } } },
      },
    });
    await variantClient.comment.create({
      data: {
        id: 2,
        subject: { connect: { type: "article", where: { id: 1 } } },
      },
    });
    await variantClient.shelf.create({
      data: {
        id: 1,
        items: {
          connect: [
            { type: "article", where: { id: 1 } },
            { type: "video", where: { id: 1 } },
          ],
        },
      },
    });
    const api = createStudioApi({
      client: variantClient,
      models: variants,
      dialect: "sqlite",
    });
    const read = (model: string) =>
      api.handle({ method: "POST", path: `/models/${model}/rows`, body: {} });
    expect((await read("comment")).body).toMatchObject({
      rows: [
        { id: 1, subject: { type: "video", data: { id: 1 } } },
        { id: 2, subject: { type: "article", data: { id: 1 } } },
      ],
    });
    expect((await read("shelf")).body).toMatchObject({
      rows: [{ id: 1, _count: { items: 2 } }],
    });
  });

  test("each member is an edge from its carrier", () => {
    const edges = described.edges.filter((edge) => edge.kind === "variant");
    expect(
      edges.map((edge) => [edge.id, edge.to.relation ?? null, edge.to.columns])
    ).toEqual([
      ["comment.subject.article", "comments", ["id"]],
      ["comment.subject.video", null, ["id"]],
      ["shelf.items.article", "shelves", ["id"]],
      ["shelf.items.video", null, ["id"]],
    ]);
  });
});

describe("failures the client raises", () => {
  const failing = (thrown: unknown) =>
    createStudioApi({
      client: {
        tag: {
          create: () => Promise.reject(thrown),
        },
      },
      models: schema,
      dialect: "sqlite",
    });
  const coded = (code: string) =>
    Object.assign(new Error(`failed ${code}`), { code });

  test.each([
    ["V7001", 422],
    ["V8001", 422],
    ["V2001", 500],
  ] as const)("a %s error answers %i with its code and message", async (code, status) => {
    const response = await failing(coded(code)).handle({
      method: "POST",
      path: "/models/tag/create",
      body: { data: {} },
    });
    expect(response).toEqual({
      status,
      body: { error: { code, message: `failed ${code}` } },
    });
  });

  test("anything else is an internal failure", async () => {
    for (const [thrown, message] of [
      [new Error("socket closed"), "socket closed"],
      ["a string", "The studio request failed"],
    ] as const) {
      const response = await failing(thrown).handle({
        method: "POST",
        path: "/models/tag/create",
        body: { data: {} },
      });
      expect(response).toEqual({
        status: 500,
        body: { error: { code: "internal", message } },
      });
    }
  });
});

describe("to-one relations", () => {
  test("a page holds the key each to-one relation reaches, or null", async () => {
    const users = await call("POST", "/models/user/rows", {
      orderBy: { id: "asc" },
    });
    const [ada, bob] = (users.body as { rows: Record<string, unknown>[] }).rows;
    expect(ada?.profile).toEqual({ id: 1 });
    expect(bob?.profile).toBeNull();
    const posts = await call("POST", "/models/post/rows", { take: 1 });
    expect(posts.body).toMatchObject({ rows: [{ author: { id: 1 } }] });
  });
});

describe("export", () => {
  test("every row the filter reaches, as CSV or JSON", async () => {
    const csv = await call("POST", "/models/post/export", {
      where: { authorId: 1 },
      orderBy: { id: "asc" },
    });
    expect(csv.file).toEqual({ name: "post.csv", type: "text/csv" });
    const lines = String(csv.body).split("\r\n");
    expect(lines[0]).toBe("id,title,rating,createdAt,authorId");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(FIRST_POST_LINE);
    const json = await call("POST", "/models/user/export", {
      format: "json",
      search: "ada",
    });
    expect(json.file).toEqual({ name: "user.json", type: "application/json" });
    expect(JSON.parse(String(json.body))).toMatchObject([
      { email: "ada@example.com", karma: "0" },
    ]);
  });

  test("refuses a format it does not write", async () => {
    const response = await call("POST", "/models/user/export", {
      format: "xml",
    });
    expect([response.status, errorCode(response)]).toEqual([
      400,
      "invalid_format",
    ]);
  });

  test("writes as many rows as an export holds, and refuses one more", async () => {
    const exportOf = (count: number) =>
      createStudioApi({
        client: {
          tag: {
            findMany: async ({ skip, take }: { skip: number; take: number }) =>
              Array.from(
                { length: Math.max(0, Math.min(take, count - skip)) },
                (_, index) => ({ id: skip + index })
              ),
          },
        },
        models: schema,
        dialect: "sqlite",
      }).handle({
        method: "POST",
        path: "/models/tag/export",
        body: { format: "json" },
      });
    const full = await exportOf(MAX_EXPORT_ROWS);
    expect(full.status).toBe(200);
    expect(JSON.parse(String(full.body))).toHaveLength(MAX_EXPORT_ROWS);
    expect((await exportOf(MAX_EXPORT_ROWS + 1)).status).toBe(413);
  });

  test("CSV quotes what needs quoting and spells every type as text", () => {
    expect(
      toCsv(
        ["a", "b", "c", "d", "e", "f"],
        [
          {
            a: 'say "hi", twice',
            b: null,
            c: new Date(0),
            d: { n: 1n },
            e: new Uint8Array([0, 1, 2]),
            f: " padded",
          },
        ]
      )
    ).toBe(
      'a,b,c,d,e,f\r\n"say ""hi"", twice",,1970-01-01T00:00:00.000Z,"{""n"":""1""}",AAEC," padded"'
    );
  });
});

describe("read-only", () => {
  const readonly = createStudioApi({
    client,
    models: schema,
    dialect: "sqlite",
    readonly: true,
  });
  const ask = (path: string, body?: unknown) =>
    readonly.handle({ method: "POST", path, body });

  test("reads and exports, and says so in the schema", async () => {
    expect(readonly.schema.readonly).toBe(true);
    expect((await ask("/models/tag/rows")).status).toBe(200);
    expect((await ask("/models/tag/export")).status).toBe(200);
  });

  test.each(["create", "update", "delete"])("refuses to %s", async (action) => {
    const response = await ask(`/models/tag/${action}`, {
      data: { label: "x" },
      key: { id: 1 },
    });
    expect([response.status, errorCode(response)]).toEqual([403, "read_only"]);
  });
});
