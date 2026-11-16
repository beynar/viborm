SELECT `q0`.`board`, `q0`.`position`, `q0`.`day`, `q0`.`rank` FROM `slot` AS `q0` WHERE ((`q0`.`board` = ? AND `q0`.`position` = ?) AND (`q0`.`rank` = ? AND BINARY `q0`.`rank` = ?));
-- ["k",1,"11","11"]

SELECT `q0`.`board`, `q0`.`position`, `q0`.`day`, `q0`.`rank` FROM `slot` AS `q0` WHERE (`q0`.`day` = ? AND (`q0`.`rank`, `q0`.`board`, `q0`.`position`) >= (SELECT `q1`.`rank`, `q1`.`board`, `q1`.`position` FROM `slot` AS `q1` WHERE (`q1`.`board` = ? AND `q1`.`position` = ?) LIMIT 1)) ORDER BY `q0`.`rank` ASC, `q0`.`board` ASC, `q0`.`position` ASC LIMIT 3;
-- ["2026-11-15 00:00:00.000","k",1]

SELECT `q0`.`board`, `q0`.`position`, `q0`.`day`, `q0`.`rank` FROM `slot` AS `q0` WHERE ((`q0`.`board` = ? AND `q0`.`position` = ?) AND `q0`.`day` = ?) ORDER BY `q0`.`board` ASC, `q0`.`position` ASC FOR UPDATE;
-- ["k",2,"2026-11-15 00:00:00.000"]

UPDATE `slot` SET `rank` = ? WHERE ((`slot`.`board` = ? AND BINARY `slot`.`board` = ?) AND `slot`.`position` = ?);
-- ["12963074","k","k",2]

SELECT `q0`.`board`, `q0`.`position`, `q0`.`day`, `q0`.`rank` FROM `slot` AS `q0` WHERE (`q0`.`board` = ? AND `q0`.`position` = ?) ORDER BY CASE WHEN (`q0`.`board` = ? AND `q0`.`position` = ?) THEN 0 ELSE 1 END;
-- ["k",2,"k",2]
