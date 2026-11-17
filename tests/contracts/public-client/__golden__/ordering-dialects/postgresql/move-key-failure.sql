WITH "__viborm_mutation" AS (UPDATE "public"."card" SET "rank" = $1 WHERE "card"."id" = $2 RETURNING *) SELECT "q0"."id", "q0"."columnId", "q0"."rank", "q0"."title", (SELECT json_build_array("q2"."id") FROM (SELECT "q1"."id" FROM "public"."column" AS "q1" WHERE "q0"."columnId" = "q1"."id" LIMIT $3) AS "q2") AS "column" FROM "__viborm_mutation" AS "q0" ORDER BY "q0"."id" ASC;
-- ["15","b",1]
