import { createClient } from "../../client";
import { s } from "../../schema";
import { PostgresAdapter } from "./postgres/postgres-adapter";
import { QueryParser } from "./query-parser";

const user = s.model("User", {
  name: s.string(),
  email: s.string(),
  age: s.int(),
  dogs: s.relation().oneToMany(() => dog),
});

const dog = s.model("dog", {
  name: s.string(),
  age: s.int(),
  owner: s.relation().manyToOne(() => user),
});

const client = createClient({
  schema: {
    user,
    dog,
  },
  adapter: {} as any,
});

const query = {
  where: {
    email: "10",
    dogs: {
      some: {
        age: 10,
      },
    },
  },
  select: {
    name: true,
    age: true,
  },
};

// const res = client.user.findFirst({
//   where: {
//     dogs: {
//       some: {
//         age: 10,
//       },
//     },
//   },
// });
const sql = QueryParser.parse("findFirst", user, query, new PostgresAdapter());

console.log(sql.toStatement());
`SELECT "t0"."name", "t0"."age" FROM "User" AS "t0" WHERE "t0"."email" = ?1 AND "t0"."age" = ?2 AND ("t0"."email" LIKE ?3 AND "t0"."age" = ANY(?4)) AND ("t0"."age" = ?5 OR "t0"."age" = ?6) LIMIT 1`;
