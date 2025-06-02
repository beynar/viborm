import { createClient } from "../client";
import { s } from "../schema";
import { PostgresAdapter } from "../adapters/databases/postgres/postgres-adapter";
import { QueryParser } from "./index";
import { Prisma, PrismaClient } from "../../generated/prisma";

const user = s.model("User", {
  id: s.string(),
  name: s.string(),
  email: s.string(),
  age: s.int(),
  friends: s
    .relation({ onField: "id", refField: "friendId" })
    .manyToMany(() => user),
  posts: s
    .relation({ onField: "id", refField: "authorId" })
    .oneToMany(() => post),
});

const post = s.model("Post", {
  id: s.string(),
  title: s.string(),
  content: s.string(),
  authorId: s.string(),
  author: s
    .relation({ onField: "authorId", refField: "id" })
    .manyToOne(() => user),
});

const client = createClient({
  schema: {
    user,
    post,
  },
  adapter: {} as any,
});

const query = {
  where: {
    posts: {
      some: {
        title: "test",
      },
    },
  },
  select: {
    id: true,
  },
};

// const res = client.user.findUnique(query);
const sql = QueryParser.parse("findFirst", user, query, new PostgresAdapter());

console.log("here", sql.toStatement());

async function main() {
  const prisma = new PrismaClient({
    log: ["query", "info", "warn", "error"],
    datasources: {
      db: {
        url: `postgresql://postgres:password@localhost:2222/baseorm`,
      },
    },
  });

  const res = await prisma.user.update({
    where: {
      id: "test",
    },
    select: {
      posts: {
        take: 2,
      },
    },
    data: {
      bio: "test",
    },
  });

  console.log("res", res);

  // testPrisma().catch(console.error);

  const queryParserO = `SELECT "t0"."id" FROM "User" AS "t0" WHERE EXISTS(SELECT "t1"."authorId" FROM "Post" AS "t1" WHERE ("t1"."title" = 'test' AND ("t0"."id") = ("t1"."authorId") AND "t1"."authorId" IS NOT NULL)) LIMIT 1`;

  const prismaOutput = `SELECT "t0"."id" FROM "User" AS "t0" WHERE EXISTS(SELECT "t1"."authorId" FROM "Post" AS "t1" WHERE ("t1"."title" = 'test' AND ("t0"."id") = ("t1"."authorId") AND "t1"."authorId" IS NOT NULL)) LIMIT 1`;

  const prismaResult = await prisma.$queryRaw(Prisma.raw(queryParserO));

  console.log("prismaResult", prismaResult);
}

main().catch(console.error);
