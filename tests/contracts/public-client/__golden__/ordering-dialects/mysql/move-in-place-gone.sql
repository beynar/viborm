SELECT `q0`.`id`, `q0`.`columnId`, `q0`.`rank` FROM `card` AS `q0` WHERE `q0`.`id` = ?;
-- ["a"]

SELECT `q0`.`id`, `q0`.`columnId`, `q0`.`rank` FROM `card` AS `q0` WHERE ((`q0`.`columnId` = ? AND BINARY `q0`.`columnId` = ?) AND (`q0`.`rank`, `q0`.`id`) <= (SELECT `q1`.`rank`, `q1`.`id` FROM `card` AS `q1` WHERE `q1`.`id` = ? LIMIT 1)) ORDER BY `q0`.`rank` DESC, `q0`.`id` DESC LIMIT 3;
-- ["c1","c1","a"]

SELECT `q0`.`id`, `q0`.`columnId`, `q0`.`rank`, `q0`.`title` FROM `card` AS `q0` WHERE `q0`.`id` = ?;
-- ["b"]
