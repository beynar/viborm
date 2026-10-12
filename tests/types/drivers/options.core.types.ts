import {
  MySQL2Driver,
  type MySQL2DriverOptions,
  type MySQL2Options,
} from "@drivers/mysql2";
import { PGliteDriver, type PGliteDriverOptions } from "@drivers/pglite";

const options: PGliteDriverOptions = {};
const driver = new PGliteDriver(options);

const executeRaw: typeof driver._executeRaw = driver._executeRaw.bind(driver);

// Provider option exports stay source-compatible; unsupported row-shape modes
// are refused at the runtime boundary before mysql2 creates a connection.
const mysqlOptions: MySQL2Options = {
  rowsAsArray: true,
  nestTables: ".",
};
const mysqlDriverOptions: MySQL2DriverOptions = { options: mysqlOptions };
const mysqlDriver = new MySQL2Driver(mysqlDriverOptions);

export { executeRaw, mysqlDriver };
