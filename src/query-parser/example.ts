import { createClient } from "../client/client";
import { s } from "../schema";
import { PostgresAdapter } from "../adapters/databases/postgres/postgres-adapter";
import { QueryParser } from "./query-parser";
import {
  boolean,
  object,
  pipe,
  string,
  transform,
  union,
  custom,
  lazy,
  ZodMiniType,
} from "zod/v4-mini";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().array(),
  createdAt: s.dateTime(),
  tags: s.string().array().nullable(),
  age: s.int().nullable(),
  metadata: s.json().nullable(),
  role: s.enum(["ADMIN", "USER"] as const).nullable(),
  posts: s.oneToMany(() => post),
}).map("User");

const post = s.model({
  id: s.string(),
  title: s.string(),
  content: s.string(),
  authorId: s.string(),
  author: s.manyToOne(() => user).fields("authorId").references("id"),
}).map("Post");

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
    posts: {
      select: {
        title: true,
      },
    },
  },
};

// const res = client.user.findFirst({
//   where: {
//     email: [1, 2],
//   },
// });
// const sql = QueryParser.parse("findFirst", user, query, new PostgresAdapter());

// console.log("here", sql.toStatement());

// async function main() {
//   const prisma = new PrismaClient({
//     log: ["query", "info", "warn", "error"],
//     datasources: {
//       db: {
//         url: `postgresql://postgres:password@localhost:2222/baseorm`,
//       },
//     },
//   });

//   const res = await prisma.user.update({
//     where: {
//       id: "test",
//     },
//     select: {
//       posts: {
//         take: 2,
//       },
//     },
//     data: {
//       bio: "test",
//     },
//   });

//   console.log("res", res);

//   // testPrisma().catch(console.error);

//   const queryParserO = `SELECT "t0"."id" FROM "User" AS "t0" WHERE EXISTS(SELECT "t1"."authorId" FROM "Post" AS "t1" WHERE ("t1"."title" = 'test' AND ("t0"."id") = ("t1"."authorId") AND "t1"."authorId" IS NOT NULL)) LIMIT 1`;

//   const prismaOutput = `SELECT "t0"."id" FROM "User" AS "t0" WHERE EXISTS(SELECT "t1"."authorId" FROM "Post" AS "t1" WHERE ("t1"."title" = 'test' AND ("t0"."id") = ("t1"."authorId") AND "t1"."authorId" IS NOT NULL)) LIMIT 1`;

//   const prismaResult = await prisma.$queryRaw(Prisma.raw(queryParserO));

//   console.log("prismaResult", prismaResult);
// }

// main().catch(console.error);

import { filterValidators } from "@types";
import { dataInputValidators } from "@types";

const stringTest = filterValidators.string.base["~standard"].validate({
  contains: "test",
});
const stringTest2 = filterValidators.string.base["~standard"].validate({
  equals: "test",
});
const stringTest3 = filterValidators.string.base["~standard"].validate({});

console.log("stringTest", stringTest);
console.log("stringTest2", stringTest2);
console.log("stringTest3", stringTest3);

const standardSchema = string();

const customStandardSchema = string().check((ctx) => {
  const result = standardSchema["~standard"]["validate"](ctx.value);
  console.log("result", result);

  ctx.value = "result";
  // return {
  //   value: "result",
  // };
});
// const customStandardSchema = custom((data) => {
//   const result = standardSchema["~standard"]["validate"](data);
//   console.log("result", result);

//   return {
//     value: "result",
//   };
// });

console.log("customStandardSchema", customStandardSchema.parse("test"));

const rawTransformer = (schema: ZodMiniType) =>
  pipe(
    schema,
    transform((value) => {
      return {
        set: value,
      };
    })
  );

const withRaw = rawTransformer(customStandardSchema);

console.log("with transform", withRaw.parse("test"));
