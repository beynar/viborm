SELECT COUNT(*) AS "_count" FROM (SELECT TRUE FROM "public"."post" AS "q0" WHERE ("q0"."id" = ANY($1) AND "q0"."deletedAt" IS NULL) FOR UPDATE) AS "q1";
-- ["{\"a\",\"b\"}"]

SELECT 1 / CASE WHEN NOT EXISTS (SELECT "q0"."id" FROM "public"."post" AS "q0" WHERE (("q0"."id" = ANY($1) AND "q0"."deletedAt" IS NULL) AND EXISTS (SELECT 1 FROM "public"."comment" AS "q1" WHERE "q0"."id" = "q1"."postId")) ORDER BY "q0"."id" ASC LIMIT $2) THEN 1 ELSE 0 END AS "__viborm_assert__";
-- ["{\"a\",\"b\"}",1]

UPDATE "public"."post" SET "deletedAt" = $1 WHERE ("post"."id" = ANY($2) AND "post"."deletedAt" IS NULL);
-- ["<now>","{\"a\",\"b\"}"]
