import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { describe, expect, test, vi } from "vitest";
import { createStudioApi } from "../src/api";
import { describeSchema } from "../src/schema";

// A view that projects its source's key and reads a relation as a JSON column,
// and one that projects no key.
const user = s.model({
  id: s.int().id().increment(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.int().id().increment(),
  title: s.string(),
  published: s.boolean(),
  authorId: s.int(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const publishedPost = s
  .view(() => post, {
    where: { published: true },
    select: { id: true, title: true, author: { select: { name: true } } },
  })
  .map("published_posts");
const postTitle = s.view(() => post, { select: { title: true } });
const schema = { user, post, publishedPost, postTitle };
// What the loaded config's client did when it was created.
hydrateSchemaNames(schema);

const described = describeSchema(schema, "sqlite");
const model = (name: string) =>
  described.models.find((entry) => entry.name === name)!;

/** A client whose delegates record what the studio asks of them. */
function recordingClient() {
  const transaction = vi.fn(async () => undefined);
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  return {
    client: {
      $transaction: transaction,
      publishedPost: { findMany, count },
    },
    transaction,
    findMany,
  };
}

describe("a database view in the studio", () => {
  test("is described as a view, with its derived key and its JSON columns", () => {
    expect(model("publishedPost")).toMatchObject({
      kind: "view",
      table: "published_posts",
      key: { fields: ["id"] },
      relations: [],
    });
    expect(model("publishedPost").fields.map((field) => field.name)).toEqual([
      "id",
      "title",
      "author",
    ]);
    expect(
      model("publishedPost").fields.find((field) => field.name === "author")
    ).toEqual({
      name: "author",
      column: "author",
      type: "json",
      nullable: false,
      list: false,
      id: false,
      unique: false,
      searchable: false,
      optional: true,
      updatable: false,
      document: true,
    });
    expect(model("postTitle").key).toBeUndefined();
    expect(model("post")).not.toHaveProperty("kind");
  });

  test("a save that names a view is refused before anything is written", async () => {
    const { client, transaction } = recordingClient();
    const api = createStudioApi({ client, models: schema, dialect: "sqlite" });
    for (const change of [
      { model: "publishedPost", action: "create", data: { title: "x" } },
      {
        model: "publishedPost",
        action: "update",
        key: { id: 1 },
        data: { title: "x" },
      },
      { model: "publishedPost", action: "delete", key: { id: 1 } },
    ]) {
      const response = await api.handle({
        method: "POST",
        path: "/changes",
        body: {
          changes: [
            { model: "post", action: "delete", key: { id: 1 } },
            change,
          ],
        },
      });
      expect(response).toMatchObject({
        status: 403,
        body: { error: { code: "read_only_view", at: 1 } },
      });
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  test("its rows are read with their JSON columns, in key order", async () => {
    const { client, findMany } = recordingClient();
    const api = createStudioApi({ client, models: schema, dialect: "sqlite" });
    const response = await api.handle({
      method: "POST",
      path: "/models/publishedPost/rows",
      body: { take: 10 },
    });
    expect(response).toEqual({ status: 200, body: { rows: [], total: 0 } });
    expect(findMany).toHaveBeenCalledWith({
      orderBy: [{ id: "asc" }],
      skip: 0,
      take: 10,
      select: { id: true, title: true, author: true },
    });
  });
});
