import type { InferDatabase, OperationResult } from "@client/exports";
import { s } from "@src/index";

const author = s
  .model({
    id: s.string().id(),
    secret: s.string(),
    posts: s.toMany(() => post),
  })
  .omit({ secret: true });
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  views: s.int().default(0),
  publishedAt: s.dateTime().nullable(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});
const schema = { author, post };
type DB = InferDatabase<typeof schema>;

const create: DB["post"]["Create"] = {
  id: "post-1",
  title: "Hello",
  publishedAt: null,
  authorId: "author-1",
};
// @ts-expect-error Numeric input must remain numeric beside valid fields.
const _invalidCreate: DB["post"]["Create"] = { ...create, views: "1" };
// @ts-expect-error Required create fields must remain required.
const _missingCreate: DB["post"]["Create"] = { id: "post-1" };
const _update: DB["post"]["Update"] = { views: { increment: 1 } };
const where: DB["post"]["Where"] = { views: { gt: 1 } };
const _args: DB["post"]["FindMany"] = {
  where,
  select: { title: true },
};
const row: DB["post"]["Row"] = {
  id: "post-1",
  title: "Hello",
  views: 0,
  publishedAt: new Date(),
  authorId: "author-1",
};
// @ts-expect-error Database DateTime results are Date, not strings.
const _invalidDate: DB["post"]["Row"] = { ...row, publishedAt: "2026-01-01" };
const _invalidRelation: DB["post"]["Row"] = {
  ...row,
  // @ts-expect-error Relations are not included in the default scalar row.
  author: { id: "author-1" },
};
const authorRow: DB["author"]["Row"] = { id: "author-1" };
// @ts-expect-error Schema-level omitted fields stay excluded.
const _invalidOmit: DB["author"]["Row"] = { ...authorRow, secret: "hidden" };
// @ts-expect-error Model keys come from the schema, not a string index.
type _UnknownModel = DB["unknown"];

type WithAuthor = OperationResult<
  "findMany",
  typeof post,
  { include: { author: true } }
>[number];
const _withAuthor: WithAuthor = { ...row, author: authorRow };
