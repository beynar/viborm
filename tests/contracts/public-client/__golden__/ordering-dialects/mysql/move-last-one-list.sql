SELECT `q0`.`id`, `q0`.`rank` FROM `item` AS `q0` WHERE TRUE ORDER BY `q0`.`rank` DESC, `q0`.`id` DESC LIMIT 2;
-- []

SELECT `q0`.`id` FROM `item` AS `q0` WHERE `q0`.`id` = ? ORDER BY `q0`.`id` ASC LIMIT 1 FOR UPDATE;
-- ["b"]

UPDATE `item` SET `rank` = ? WHERE (`item`.`id` IN (?) AND BINARY `item`.`id` IN (?));
-- ["14963074","b","b"]

SELECT `q0`.`id`, `q0`.`rank` FROM `item` AS `q0` WHERE `q0`.`id` = ? ORDER BY CASE WHEN `q0`.`id` = ? THEN 0 ELSE 1 END;
-- ["b","b"]
