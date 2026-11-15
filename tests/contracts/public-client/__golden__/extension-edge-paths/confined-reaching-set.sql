WITH RECURSIVE "__shared_0" AS (SELECT "q9"."id" AS "k0" FROM "public"."node" AS "q4" INNER JOIN "public"."node" AS "q9" ON ("q9"."id" = "q4"."parentId" AND "q9"."tenant" = $1) WHERE "q4"."flag" = $2 UNION SELECT "q12"."id" AS "k0" FROM "__shared_0" AS "q10" INNER JOIN "public"."node" AS "q11" ON "q11"."id" = "q10"."k0" INNER JOIN "public"."node" AS "q12" ON ("q12"."id" = "q11"."parentId" AND "q12"."tenant" = $3)), "__shared_3" AS (SELECT ARRAY(SELECT "__shared_0"."k0" FROM "__shared_0") AS "f0") SELECT "q0"."id" FROM "public"."node" AS "q0" CROSS JOIN "__shared_3" AS "q61" WHERE (EXISTS (WITH RECURSIVE "__q2_recursive" AS (
        SELECT "q3"."id" AS "__q2_child_0" FROM "public"."node" AS "q3" WHERE ("q0"."id" = "q3"."parentId" AND COALESCE("q3"."id" = ANY("q61"."f0"), FALSE))
        UNION
        SELECT "q14"."id" AS "__q2_child_0" FROM "__q2_recursive" AS "q13" INNER JOIN "public"."node" AS "q14" ON ("q13"."__q2_child_0" = "q14"."parentId" AND COALESCE("q14"."id" = ANY("q61"."f0"), FALSE))
      ) SELECT 1 FROM "__q2_recursive" AS "q13" INNER JOIN "public"."node" AS "q1" ON "q1"."id" = "q13"."__q2_child_0" WHERE "q1"."flag" = $4) AND EXISTS (WITH RECURSIVE "__q33_recursive" AS (
        SELECT "q34"."id" AS "__q33_child_0" FROM "public"."node" AS "q34" WHERE ("q0"."id" = "q34"."parentId" AND COALESCE("q34"."id" = ANY("q61"."f0"), FALSE))
        UNION
        SELECT "q41"."id" AS "__q33_child_0" FROM "__q33_recursive" AS "q40" INNER JOIN "public"."node" AS "q41" ON ("q40"."__q33_child_0" = "q41"."parentId" AND COALESCE("q41"."id" = ANY("q61"."f0"), FALSE))
      ) SELECT 1 FROM "__q33_recursive" AS "q40" INNER JOIN "public"."node" AS "q32" ON "q32"."id" = "q40"."__q33_child_0" WHERE "q32"."flag" = $5)) ORDER BY "q0"."id" ASC;
-- ["b",true,"b",true,true]
