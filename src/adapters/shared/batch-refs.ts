import { type Sql, sql } from "@sql";
import type { BatchReferenceSqlAdapter } from "../database-adapter";

interface OnConflictBatchRefsConfig {
  table: Sql;
  batchIdColumn: Sql;
  keyColumn: Sql;
  valueColumn: Sql;
  createTable: Sql;
  castValue: (valueSql: Sql) => Sql;
  lastInsertId?: () => Sql;
}

interface MySqlBatchRefsConfig extends OnConflictBatchRefsConfig {
  duplicateValue: Sql;
}

export function createOnConflictBatchRefs(
  config: OnConflictBatchRefsConfig
): BatchReferenceSqlAdapter {
  return createBatchRefs({
    ...config,
    store: (batchId, key, valueSql) => {
      const value = config.castValue(valueSql);
      return sql`INSERT INTO ${config.table} (${config.batchIdColumn}, ${config.keyColumn}, ${config.valueColumn}) VALUES (${batchId}, ${key}, ${value}) ${sql.raw`ON CONFLICT`} (${config.batchIdColumn}, ${config.keyColumn}) DO UPDATE SET ${config.valueColumn} = EXCLUDED.${config.valueColumn}`;
    },
  });
}

export function createMySqlBatchRefs(
  config: MySqlBatchRefsConfig
): BatchReferenceSqlAdapter {
  return createBatchRefs({
    ...config,
    store: (batchId, key, valueSql) => {
      const value = config.castValue(valueSql);
      return sql`INSERT INTO ${config.table} (${config.batchIdColumn}, ${config.keyColumn}, ${config.valueColumn}) VALUES (${batchId}, ${key}, ${value}) ${sql.raw`ON DUPLICATE KEY UPDATE`} ${config.valueColumn} = ${config.duplicateValue}`;
    },
  });
}

function createBatchRefs(
  config: OnConflictBatchRefsConfig & {
    store: (batchId: string, key: string, valueSql: Sql) => Sql;
  }
): BatchReferenceSqlAdapter {
  const lastInsertId = config.lastInsertId;
  const deleteBatch = (batchId: string): Sql =>
    sql`DELETE FROM ${config.table} WHERE ${config.batchIdColumn} = ${batchId}`;

  return {
    setup: (_batchId) => [config.createTable],
    clear: deleteBatch,
    cleanup: deleteBatch,
    store: config.store,
    read: (batchId, key) =>
      sql`(SELECT ${config.valueColumn} FROM ${config.table} WHERE ${config.batchIdColumn} = ${batchId} AND ${config.keyColumn} = ${key} ${sql.raw`LIMIT 1`})`,
    ...(lastInsertId
      ? {
          storeLastInsertId: (batchId: string, key: string) =>
            config.store(batchId, key, lastInsertId()),
        }
      : {}),
  };
}
