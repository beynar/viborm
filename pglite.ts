import { PGlite } from "@electric-sql/pglite";
import { s } from "./src/schema/index.ts";
import { push } from "./src/migrations/push.ts";
const db = new PGlite();

const user = s.model({
  name: s.string(),
  email: s.string(),
  post: s.oneToMany(() => post),
});

const post = s.model({
  title: s.string(),
  content: s.string(),
  user: s.manyToOne(() => user),
});

await push({}, { user, post });
