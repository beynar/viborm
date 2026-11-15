SELECT "q0"."id" AS "id", "q0"."columnId" AS "columnId", "q0"."rank" AS "rank" FROM "dbo"."card" AS "q0" WHERE "q0"."id" = @p1 ORDER BY "q0"."id" ASC OFFSET 0 ROWS;
-- ["a"]

SELECT "q0"."id" AS "id", "q0"."columnId" AS "columnId", "q0"."rank" AS "rank" FROM "dbo"."card" AS "q0" WHERE ("q0"."columnId" = @p1 AND ("q0"."rank" <= (SELECT TOP (@p2) "q1"."rank" FROM "dbo"."card" AS "q1" WHERE "q1"."id" = @p3) AND EXISTS (SELECT CAST(1 AS BIT) AS "__viborm_true" FROM (SELECT TOP (@p4) "q1"."rank" AS "0viborm_cursor_0", "q1"."id" AS "0viborm_cursor_1" FROM "dbo"."card" AS "q1" WHERE "q1"."id" = @p5) AS "q2" WHERE ((("q2"."0viborm_cursor_0" IS NULL AND "q0"."rank" IS NOT NULL) OR ("q2"."0viborm_cursor_0" IS NOT NULL AND ("q0"."rank" IS NOT NULL AND "q0"."rank" < "q2"."0viborm_cursor_0"))) OR ((("q0"."rank" IS NULL AND "q2"."0viborm_cursor_0" IS NULL) OR ("q0"."rank" IS NOT NULL AND "q2"."0viborm_cursor_0" IS NOT NULL AND "q0"."rank" = "q2"."0viborm_cursor_0")) AND (("q2"."0viborm_cursor_1" IS NULL AND "q0"."id" IS NOT NULL) OR ("q2"."0viborm_cursor_1" IS NOT NULL AND ("q0"."id" IS NOT NULL AND "q0"."id" < "q2"."0viborm_cursor_1")))) OR ((("q0"."rank" IS NULL AND "q2"."0viborm_cursor_0" IS NULL) OR ("q0"."rank" IS NOT NULL AND "q2"."0viborm_cursor_0" IS NOT NULL AND "q0"."rank" = "q2"."0viborm_cursor_0")) AND (("q0"."id" IS NULL AND "q2"."0viborm_cursor_1" IS NULL) OR ("q0"."id" IS NOT NULL AND "q2"."0viborm_cursor_1" IS NOT NULL AND "q0"."id" = "q2"."0viborm_cursor_1"))))))) ORDER BY "q0"."rank" DESC, "q0"."id" DESC OFFSET 0 ROWS FETCH NEXT @p6 ROWS ONLY;
-- ["c1",1,"a",1,"a",3]

SELECT "q0"."id" AS "id", "q0"."columnId" AS "columnId", "q0"."rank" AS "rank", "q0"."title" AS "title" FROM "dbo"."card" AS "q0" WITH (UPDLOCK, HOLDLOCK, ROWLOCK) WHERE ("q0"."id" = @p1 AND "q0"."columnId" = @p2) ORDER BY "q0"."id" ASC OFFSET 0 ROWS;
-- ["b","c1"]

UPDATE "dbo"."card" SET "rank" = @p1 WHERE "card"."id" IN (@p2);
-- ["12963074","b"]

SELECT "q0"."id" AS "id", "q0"."columnId" AS "columnId", "q0"."rank" AS "rank", "q0"."title" AS "title" FROM "dbo"."card" AS "q0" WHERE "q0"."id" = @p1 ORDER BY CASE WHEN "q0"."id" = @p2 THEN 0 ELSE 1 END OFFSET 0 ROWS;
-- ["b","b"]
