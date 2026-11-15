SELECT "q0"."id" FROM "public"."tomb" AS "q0" WHERE ("q0"."id" = $1 AND "q0"."deletedAt" IS NULL) ORDER BY "q0"."id" ASC LIMIT $2 FOR UPDATE;
-- ["a",1]

SELECT 1 / CASE WHEN NOT EXISTS (SELECT "q0"."id" FROM "public"."tomb" AS "q0" WHERE (("q0"."id" = $1 AND "q0"."deletedAt" IS NULL) AND EXISTS (SELECT 1 FROM "public"."tomb" AS "q1" WHERE ("q0"."id" = "q1"."parentId" AND "q1"."deletedAt" IS NULL))) ORDER BY "q0"."id" ASC LIMIT $2) THEN 1 ELSE 0 END AS "__viborm_assert__";
-- ["b",1]

UPDATE "public"."tomb" SET "deletedAt" = $1 WHERE ("tomb"."parentId" = $2 AND ("tomb"."id" = ANY($3) AND "tomb"."deletedAt" IS NULL));
-- ["<now>","a","{\"b\"}"]

SELECT "q0"."id", "q0"."deletedAt", "q0"."parentId" FROM "public"."tomb" AS "q0" WHERE "q0"."id" = $1 ORDER BY "q0"."id" ASC;
-- ["a"]
