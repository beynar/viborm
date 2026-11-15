SELECT VALUE { id: id } FROM item WHERE id = $p1 LIMIT 1;
-- [{"p1":"item:a"}]

SELECT rank AS k, id AS i0, (IF true { true } ELSE { false }) AS v FROM item;
-- [{}]

RETURN array::flatten([(UPDATE $p1 SET rank = $p2 WHERE true AND rank = $p3 RETURN id), (UPDATE $p4 SET rank = $p5 WHERE true AND rank = $p6 RETURN id)]);
-- [{"p1":"item:a","p2":"10","p3":"11","p4":"item:b","p5":"11","p6":"11"}]

COMMIT;
-- []

SELECT VALUE { id: id } FROM item WHERE id = $p1 LIMIT 1;
-- [{"p1":"item:zz"}]

RETURN [];
-- [{}]

COMMIT;
-- []
