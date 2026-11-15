INSERT INTO "dbo"."card" ("id", "columnId", "rank", "title") VALUES (@p1, @p2, ((SELECT CASE WHEN n > 999999999 THEN NULL ELSE CONCAT(LEN(CAST(n AS VARCHAR(10))), n, RTRIM(RIGHT(CONCAT('00000', ABS(CHECKSUM(NEWID()) % 1000000)), 6), '0')) END FROM (SELECT CASE WHEN k IS NULL OR LEFT(k, 1) = '0' THEN 0 ELSE CAST(SUBSTRING(k, 2, CAST(LEFT(k, 1) AS INT)) AS BIGINT) + 1 END AS n FROM (SELECT MAX("rank") AS k FROM "dbo"."card" WHERE "columnId" = @p3 AND LEN("rank") >= 2 AND "rank" NOT LIKE '%[^0-9]%') AS m) AS x)), NULL);
-- ["b","c1","c1"]

SELECT "q0"."id" AS "id", "q0"."columnId" AS "columnId", "q0"."rank" AS "rank", "q0"."title" AS "title" FROM "dbo"."card" AS "q0" WHERE "q0"."id" = @p1 ORDER BY "q0"."id" ASC OFFSET 0 ROWS;
-- ["b"]
