import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma";

const connectionString = `postgresql://postgres:password@localhost:2222/baseorm`;

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({
  adapter,
  log: ["query", "info", "warn", "error"],
});

const res = await prisma.user.findMany({
  where: {
    id: "test",
    tags: {
      equals: ["ez"],
    },
  },
  orderBy: {
    metadata: "asc",
    posts: {
      _count: "asc",
    },
    mentor: {
      mentee: {},
    },
  },
  // data: {
  //   metadata:{
  //     jelk:"ez"
  //   }
  // },
});

const res2 = await prisma.user.findUnique({
  where: {
    id: "123",
  },
});
// await prisma.user.create({
//   data: {
//     id: "test",
//     email: "test",
//     password: "test",
//     name: "test",
//     bio: "test",
//     metadata: {
//       test: "test",
//     },
//     tags: ["test"],
//     comments: {
//       create: {
//         content: "rlkrre",

//         post: {
//           create: {
//             title: "test",
//             author: {
//               connect: {
//                 id: "test",
//               },
//             },
//             content: "test",
//           },
//         },
//       },
//     },
//   },
// });

console.log(res);

const generatedSql = /*SQL*/ `
SELECT "t0"."id", "t0"."email", "t0"."name", "t0"."password", "t0"."metadata", "t0"."tags", "t0"."bio", "t0"."createdAt", "t0"."updatedAt", "User_comments"."__prisma_data__" AS "comments" FROM "public"."User" AS "t0" LEFT JOIN LATERAL (SELECT COALESCE(JSONB_AGG("__prisma_data__"), '[]') AS "__prisma_data__" FROM (SELECT "t3"."__prisma_data__" FROM (SELECT JSONB_BUILD_OBJECT('id', "t2"."id", 'content', "t2"."content", 'createdAt', "t2"."createdAt", 'updatedAt', "t2"."updatedAt", 'authorId', "t2"."authorId", 'postId', "t2"."postId") AS "__prisma_data__" FROM (SELECT "t1".* FROM "public"."Comment" AS "t1" WHERE "t0"."id" = "t1"."authorId" /* root select */) AS "t2" /* inner select */) AS "t3" /* middle select */) AS "t4" /* outer select */) AS "User_comments" ON true WHERE "t0"."email" = 'test' LIMIT 1`;

const withSubqueryMysql = `
-- Main SELECT clause with subquery for comments
SELECT 
  t0.id, 
  t0.email, 
  t0.name, 
  t0.password, 
  t0.metadata, 
  t0.tags, 
  t0.bio, 
  t0.createdAt, 
  t0.updatedAt,
  (
    -- Subquery to get aggregated comments
    SELECT COALESCE(JSON_ARRAYAGG(__prisma_data__), '[]')
    FROM (
      -- Subquery to build JSON object for each comment
      SELECT JSON_OBJECT(
        'id', t1.id,
        'content', t1.content, 
        'createdAt', t1.createdAt,
        'updatedAt', t1.updatedAt,
        'authorId', t1.authorId,
        'postId', t1.postId
      ) AS __prisma_data__
      FROM Comment AS t1
      WHERE t1.authorId = t0.id
    ) AS comment_data
  ) AS comments

-- Main FROM clause
FROM User AS t0

-- Main WHERE clause
WHERE t0.email = 'test'

-- Limit clause
LIMIT 1
`;

const withSubquery = `
-- Main SELECT clause with subquery for comments
SELECT 
  "t0"."id", 
  "t0"."email", 
  "t0"."name", 
  "t0"."password", 
  "t0"."metadata", 
  "t0"."tags", 
  "t0"."bio", 
  EXTRACT(EPOCH FROM "t0"."createdAt") * 1000 AS "createdAt",
  EXTRACT(EPOCH FROM "t0"."updatedAt") * 1000 AS "updatedAt",
  (
    -- Subquery to get aggregated comments
    SELECT COALESCE(JSONB_AGG("__prisma_data__"), '[]')
    FROM (
      -- Subquery to build JSON object for each comment
      SELECT JSONB_BUILD_OBJECT(
        'id', "t1"."id",
        'content', "t1"."content", 
        'createdAt', EXTRACT(EPOCH FROM "t1"."createdAt") * 1000,
        'updatedAt', EXTRACT(EPOCH FROM "t1"."updatedAt") * 1000,
        'authorId', "t1"."authorId",
        'postId', "t1"."postId"
      ) AS "__prisma_data__"
      FROM "public"."Comment" AS "t1"
      WHERE "t1"."authorId" = "t0"."id"
    ) AS "comment_data"
  ) AS "comments"

-- Main FROM clause
FROM "public"."User" AS "t0"

-- Main WHERE clause
WHERE "t0"."email" = 'test'

-- Limit clause
LIMIT 1
`;

// const res2 = await prisma.$queryRaw(Prisma.raw(generatedSql), [
//   "eza@eza.com",
//   10,
// ]);

// // Convert Unix timestamps back to Date objects
// const processedRes2 = (res2 as any[]).map((row: any) => ({
//   ...row,
//   createdAt: new Date(row.createdAt),
//   updatedAt: new Date(row.updatedAt),
//   comments:
//     row.comments?.map((comment: any) => ({
//       ...comment,
//       createdAt: new Date(comment.createdAt),
//       updatedAt: new Date(comment.updatedAt),
//     })) || [],
// }));

// console.log("withSubquery");
// console.dir(res2, { depth: null });

const query = Prisma.sql`
SELECT "t0"."name", "t0"."email" FROM "User" AS "t0" WHERE "t0"."email" = 'test' LIMIT 1
`;

const res3 = await prisma.$queryRaw(query);

console.log(res3);
