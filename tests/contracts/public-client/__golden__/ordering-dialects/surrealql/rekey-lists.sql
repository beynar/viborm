SELECT columnId AS w0 FROM card WHERE true GROUP BY w0;
-- [{}]

SELECT rank AS k, id AS i0, title AS o0, (IF true { true } ELSE { false }) AS v FROM card WHERE columnId = NONE;
-- [{}]

SELECT rank AS k, id AS i0, title AS o0, (IF true { true } ELSE { false }) AS v FROM card WHERE columnId = $p1;
-- [{"p1":"column:c1"}]

RETURN array::flatten([(UPDATE $p1 SET rank = $p2 WHERE true AND columnId = NONE AND rank = $p3 RETURN id), (UPDATE $p4 SET rank = $p5 WHERE true AND columnId = NONE AND rank = $p6 RETURN id), (UPDATE $p7 SET rank = $p8 WHERE true AND columnId = NONE AND rank = NONE RETURN id), (UPDATE $p9 SET rank = $p10 WHERE true AND columnId = NONE AND rank = $p11 RETURN id), (UPDATE $p12 SET rank = $p13 WHERE true AND columnId = $p14 AND rank = $p15 RETURN id)]);
-- [{"p1":"card:a","p2":"10","p3":"11","p4":"card:b","p5":"12","p6":"12","p7":"card:e","p8":"13","p9":"card:f","p10":"11","p11":"13","p12":"card:d","p13":"12963074","p14":"column:c1","p15":"13"}]

COMMIT;
-- []
