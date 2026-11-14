/** A plain schema for the client pages that only mention extensions. */
import { createClient } from "viborm/pglite";
import { s } from "viborm/schema";

export const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique().nullable(),
  age: s.int().default(0),
  active: s.boolean().default(true),
  status: s.string().default("active"),
  deletedAt: s.dateTime().nullable(),
  posts: s.toMany(() => post),
  managed: s.toMany(() => account),
});
export const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s.toOne(() => user).fields("authorId").references("id"),
});
export const page = s.model({
  id: s.string().id(),
  title: s.string(),
  ownerId: s.string(),
});
export const account = s.model({
  id: s.int().id(),
  managerId: s.string(),
  manager: s.toOne(() => user).fields("managerId").references("id"),
  logins: s.toMany(() => login),
});
export const login = s.model({
  id: s.int().id(),
  status: s.string(),
  accountId: s.int(),
  account: s.toOne(() => account).fields("accountId").references("id"),
});
export const author = s.model({
  id: s.string().id(),
  books: s.toMany(() => book),
});
export const book = s.model({
  isbn: s.string().id(),
  title: s.string(),
  status: s.string(),
  authorId: s.string(),
  author: s.toOne(() => author).fields("authorId").references("id"),
  printings: s.toMany(() => printing),
});
export const printing = s.model({
  id: s.int().id(),
  bookIsbn: s.string(),
  book: s.toOne(() => book).fields("bookIsbn").references("isbn"),
});
export const schema = { user, post, page, account, login, author, book, printing };
export const client = createClient({ schema });
