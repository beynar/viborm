SELECT `q0`.`id`, `q0`.`columnId`, `q0`.`rank` FROM `card` AS `q0` WHERE (`q0`.`columnId` = ? AND BINARY `q0`.`columnId` = ?) ORDER BY (`q0`.`columnId` IS NULL) ASC, `q0`.`columnId` ASC, `q0`.`rank` ASC, `q0`.`id` ASC LIMIT 2;
-- ["c3","c3"]

SELECT `q0`.`id`, `q0`.`columnId`, `q0`.`rank`, `q0`.`title` FROM `card` AS `q0` WHERE (`q0`.`id` = ? AND NOT ((`q0`.`columnId` = ? AND BINARY `q0`.`columnId` = ?))) ORDER BY `q0`.`id` ASC FOR UPDATE;
-- ["b","c3","c3"]

UPDATE `card` SET `columnId` = ?, `rank` = ? WHERE (`card`.`id` IN (?) AND BINARY `card`.`id` IN (?));
-- ["c3","10963074","b","b"]

SELECT `q0`.`id`, `q0`.`columnId`, `q0`.`rank`, `q0`.`title` FROM `card` AS `q0` WHERE `q0`.`id` = ? ORDER BY CASE WHEN `q0`.`id` = ? THEN 0 ELSE 1 END;
-- ["b","b"]
