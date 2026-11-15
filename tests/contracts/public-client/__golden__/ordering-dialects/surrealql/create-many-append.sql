SELECT rank AS key, id FROM card WHERE columnId = NONE AND string::matches(rank, $p1) ORDER BY key DESC LIMIT 1;
-- [{"p1":"^[0-9]{2,}$"}]

SELECT rank AS key, id FROM card WHERE columnId = $p1 AND string::matches(rank, $p2) ORDER BY key DESC LIMIT 1;
-- [{"p1":"column:c1","p2":"^[0-9]{2,}$"}]

INSERT INTO card $p1 RETURN id;
-- [{"p1":[{"id":"card:b","rank":"10963074"},{"id":"card:c","columnId":"column:c1","rank":"12852963"}]}]

COMMIT;
-- []
