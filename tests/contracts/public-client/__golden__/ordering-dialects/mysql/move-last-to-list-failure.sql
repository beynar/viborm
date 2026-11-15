SELECT `q0`.`id`, `q0`.`columnId`, `q0`.`rank` FROM `card` AS `q0` WHERE (`q0`.`columnId` = ? AND BINARY `q0`.`columnId` = ?) ORDER BY (`q0`.`columnId` IS NULL) DESC, `q0`.`columnId` DESC, `q0`.`rank` DESC, `q0`.`id` DESC LIMIT 2;
-- ["c2","c2"]

SELECT `q0`.`id`, `q0`.`columnId`, `q0`.`rank`, `q0`.`title` FROM `card` AS `q0` WHERE (`q0`.`id` = ? AND NOT ((`q0`.`columnId` = ? AND BINARY `q0`.`columnId` = ?))) ORDER BY `q0`.`id` ASC FOR UPDATE;
-- ["b","c2","c2"]
