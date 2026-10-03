export type { DatabaseAdapter } from "./database-adapter";

import { MySQLAdapter } from "./databases/mysql/mysql-adapter";
import { PostgresAdapter } from "./databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "./databases/sqlite/sqlite-adapter";

export { MySQLAdapter, PostgresAdapter, SQLiteAdapter };

// The ready-made instances live in this entry only: a driver builds its own
// adapter, so an application that never imports `viborm/adapters` does not
// construct three adapters while its modules load.
export const mysqlAdapter = new MySQLAdapter();
export const postgresAdapter = new PostgresAdapter();
export const sqliteAdapter = new SQLiteAdapter();
