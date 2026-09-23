// T3 repair round, measurement 6: is the introducer FROZEN in the stored
// expression at CREATE time — i.e. does an ordinary utf8mb4 session read
// `_latin1` back from a column another session created? Creates and drops only
// its own `tm_` table. Nothing else in the database is touched.
import mysql from "/private/tmp/viborm-tm/node_modules/mysql2/promise.js";
const url = process.env.MYSQL_TEST_CONNECTION_STRING;
if (!url) throw new Error("no connection string");
const TABLE = "tm_frozen_introducer";
const codes = (s) =>
  [...s].map((c) => c.codePointAt(0).toString(16).padStart(2, "0")).join(" ");

// 1. CREATE over a latin1 session (another tool, another pool, an older estate).
const creator = await mysql.createConnection({ uri: url, charset: "latin1" });
try {
  await creator.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
  await creator.query(
    `CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, note TEXT NOT NULL DEFAULT ('plain'), accent TEXT NOT NULL DEFAULT ('café'))`
  );
} finally {
  await creator.end();
}

// 2. READ over the ordinary connection the driver opens (no charset option).
const reader = await mysql.createConnection({ uri: url });
try {
  const [vars] = await reader.query(
    "SELECT @@character_set_client c, @@character_set_connection cc, @@character_set_results r"
  );
  const [rows] = await reader.query(
    `SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [TABLE]
  );
  console.log(`reader session=${JSON.stringify(vars[0])}`);
  for (const row of rows) {
    if (row.COLUMN_DEFAULT === null) continue;
    console.log(
      `${row.COLUMN_NAME}: ${JSON.stringify(row.COLUMN_DEFAULT)} codes=${codes(row.COLUMN_DEFAULT)}`
    );
  }
  const [create] = await reader.query(`SHOW CREATE TABLE \`${TABLE}\``);
  console.log(`SHOW CREATE: ${JSON.stringify(create[0]["Create Table"])}`);
} finally {
  await reader.end();
}

const cleaner = await mysql.createConnection({ uri: url });
try {
  await cleaner.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
} finally {
  await cleaner.end();
}
