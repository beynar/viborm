import { s } from "@src/schema";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    secret: s.string(),
    posts: s.toMany(() => post),
  })
  .omit({ secret: true });
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  published: s.boolean(),
  views: s.bigInt(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const membership = s
  .model({ userId: s.string(), teamId: s.string(), role: s.string() })
  .id(["userId", "teamId"]);

// The state holds the scalars the selection names, and the declaration.
const publishedPost = s
  .view(() => post, {
    where: { published: true, author: { is: { name: "Ann" } } },
    select: {
      id: true,
      title: true,
      authorId: true,
      author: { select: { name: true } },
    },
  })
  .map("published_posts");
type Published = (typeof publishedPost)["~"]["state"];
const _publishedScalars: (keyof Published["scalars"])[] = [
  "id",
  "title",
  "authorId",
];
// @ts-expect-error - a scalar the selection does not name is not a column
const _notProjected: keyof Published["scalars"] = "views";
// @ts-expect-error - a selected relation is a JSON column, not a scalar
const _document: keyof Published["scalars"] = "author";
const _table: Published["tableName"] = "published_posts";
const _declaredSelection: Published["view"]["query"]["select"]["id"] = true;

// Without a selection: every projectable scalar but the omitted ones.
const directory = s.view(() => user, { omit: { email: true } });
type Directory = (typeof directory)["~"]["state"];
const _directoryScalars: (keyof Directory["scalars"])[] = ["id", "name"];
// @ts-expect-error - omitted by the query
const _omittedByQuery: keyof Directory["scalars"] = "email";
// @ts-expect-error - omitted by the model
const _omittedByModel: keyof Directory["scalars"] = "secret";

// A compound key follows only with every member.
const seats = s.view(() => membership, {});
const _compound: keyof NonNullable<(typeof seats)["~"]["state"]["compoundId"]> =
  "userId_teamId";
const roles = s.view(() => membership, { select: { role: true } });
// @ts-expect-error - no compound key without its members
const _noCompound: keyof (typeof roles)["~"]["state"]["compoundId"] =
  "userId_teamId";

// A view reads a view.
const second = s.view(() => publishedPost, { where: { title: "x" } });
const _secondScalars: (keyof (typeof second)["~"]["state"]["scalars"])[] = [
  "id",
  "title",
  "authorId",
];

// The query is what findMany takes on the source, without cursor.
// @ts-expect-error - a key findMany does not take
s.view(() => post, { wher: { published: true } });
// @ts-expect-error - a paging anchor is not a row set
s.view(() => post, { cursor: { id: "x" } });
// @ts-expect-error - unknown field in where
s.view(() => post, { where: { nope: true } });
// @ts-expect-error - unknown field in a nested selection
s.view(() => post, { select: { author: { select: { nope: true } } } });
// @ts-expect-error - a field the model omits cannot be selected
s.view(() => user, { select: { secret: true } });
// @ts-expect-error - a view filters on its own columns only
s.view(() => publishedPost, { where: { views: 1n } });
