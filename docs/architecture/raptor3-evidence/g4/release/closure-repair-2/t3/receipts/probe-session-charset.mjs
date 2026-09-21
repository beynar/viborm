// T3 measurement 5: does the introducer name the charset the DDL ARRIVED in?
// Creates and drops only its own `tm_` table, on a connection that speaks
// latin1. Nothing else in the database is touched.
import mysql from "/private/tmp/viborm-tm/node_modules/mysql2/promise.js";
const url = process.env.MYSQL_TEST_CONNECTION_STRING;
if (!url) throw new Error("no connection string");
const TABLE = "tm_session_charset";
const codes = (s) =>
  [...s].map((c) => c.codePointAt(0).toString(16).padStart(2, "0")).join(" ");

for (const charset of ["utf8mb4", "latin1"]) {
  const conn = await mysql.createConnection({ uri: url, charset });
  try {
    const [vars] = await conn.query(
      "SELECT @@character_set_client c, @@character_set_connection cc"
    );
    await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
    await conn.query(
      `CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, note TEXT NOT NULL DEFAULT ('café'))`
    );
    const [rows] = await conn.query(
      `SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'note'`,
      [TABLE]
    );
    console.log(
      `charset=${charset} session=${JSON.stringify(vars[0])} catalog=${JSON.stringify(rows[0].COLUMN_DEFAULT)} codes=${codes(rows[0].COLUMN_DEFAULT)}`
    );
    await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
  } finally {
    await conn.end();
  }
}
