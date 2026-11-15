UPDATE `node` SET `tags` = JSON_MERGE_PRESERVE(COALESCE(`tags`, JSON_ARRAY()), CAST(? AS JSON)), `parentId` = ? WHERE `node`.`id` IN (SELECT * FROM (SELECT `q0`.`id` FROM `node` AS `q0` WHERE (`q0`.`id` = ? AND TRUE) GROUP BY `q0`.`id` HAVING MIN((SELECT CASE WHEN NOT EXISTS (WITH RECURSIVE `__q3_recursive` AS (
        SELECT `q4`.`id` AS `__q3_child_0` FROM `node` AS `q4` WHERE `q1`.`parentId` = `q4`.`id`
        UNION
        SELECT `q7`.`id` AS `__q3_child_0` FROM `__q3_recursive` AS `q5` INNER JOIN `node` AS `q6` ON `q6`.`id` = `q5`.`__q3_child_0` INNER JOIN `node` AS `q7` ON `q6`.`parentId` = `q7`.`id`
      ) SELECT 1 FROM `__q3_recursive` AS `q5` WHERE `q1`.`id` = `q5`.`__q3_child_0`) THEN 1 ELSE JSON_EXTRACT('{}', '__viborm_refused__') END AS `__viborm_judged__` FROM (SELECT `q2`.`id`, `q2`.`ownerId`, `q2`.`tags`, `q2`.`parentId` FROM `node` AS `q2` WHERE FALSE UNION ALL SELECT `q0`.`id`, `q0`.`ownerId`, `q0`.`tags`, ?) AS `q1`)) = 1) AS `q8`);
-- ["[\"t\"]",2,1,2]
