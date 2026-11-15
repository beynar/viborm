SELECT (SELECT MAX(`rank`) AS k FROM `card` WHERE `columnId` = ? AND `rank` REGEXP '^[0-9]{2,}$') AS g0;
-- ["c1"]

INSERT INTO `card` (`id`, `columnId`, `rank`, `title`) VALUES (?, ?, ?, NULL);
-- ["b","c1","12963074"]

SELECT `q0`.`id`, `q0`.`columnId`, `q0`.`rank`, `q0`.`title` FROM `card` AS `q0` WHERE `q0`.`id` = ? ORDER BY `q0`.`id` ASC;
-- ["b"]
