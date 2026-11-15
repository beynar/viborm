SELECT day AS w0 FROM slot WHERE true GROUP BY w0;
-- [{}]

SELECT rank AS k, id[0] AS i0, id[1] AS i1, (IF true { true } ELSE { false }) AS v FROM slot WHERE day = $p1;
-- [{"p1":"2026-11-15T00:00:00.000Z"}]

RETURN array::flatten([(UPDATE $p1 SET rank = $p2 WHERE true AND day = $p3 AND rank = $p4 RETURN id), (UPDATE $p5 SET rank = $p6 WHERE true AND day = $p7 AND rank = $p8 RETURN id), (UPDATE $p9 SET rank = $p10 WHERE true AND day = $p11 AND rank = $p12 RETURN id)]);
-- [{"p1":"slot:[ s\"m\", 1 ]","p2":"12","p3":"2026-11-15T00:00:00.000Z","p4":"11","p5":"slot:[ s\"k\", 2 ]","p6":"11","p7":"2026-11-15T00:00:00.000Z","p8":"11","p9":"slot:[ s\"k\", 1 ]","p10":"10","p11":"2026-11-15T00:00:00.000Z","p12":"11"}]

COMMIT;
-- []
