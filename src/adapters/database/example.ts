import { createClient } from "../../client";
import { s } from "../../schema";
import { PostgresAdapter } from "./postgres/postgres-adapter";
import { QueryParser } from "./query-parser";

const user = s.model("User", {
  name: s.string(),
  email: s.string(),
  age: s.int(),
  dogs: s.relation({ onField: "id", refField: "ownerId" }).oneToMany(() => dog),
});

const dog = s.model("dog", {
  name: s.string(),
  age: s.int(),
  ownerId: s.string(),
  owner: s
    .relation({ onField: "ownerId", refField: "id" })
    .manyToOne(() => user),
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
    age: 10,
    dogs: {
      some: {
        name: {
          contains: "10",
        },
      },
    },
  },
  select: {
    name: true,
    age: true,
  },
};

// const res = client.user.findUnique(query);
const sql = QueryParser.parse("findUnique", user, query, new PostgresAdapter());

console.log(sql.toStatement());
`SELECT "t0"."name", "t0"."age" FROM "User" AS "t0" WHERE "t0"."email" = ?1 AND "t0"."age" = ?2 AND ("?3"."?4" LIKE ?5 AND "?6"."?7" = ANY(?8)) AND ("t0"."age" = ?9 OR "t0"."age" = ?10) LIMIT 1`;
