// U4 measurement: exactly what bytes/codepoints the catalog hands back for a
// non-ASCII default, on the ordinary mysql2 connection and on one that asks
// for utf8mb4 explicitly. Creates and drops only its own `sm_` table.
import mysql from "/private/tmp/viborm-sm/node_modules/mysql2/promise.js";

const url = process.env.MYSQL_TEST_CONNECTION_STRING;
if (!url) throw new Error("no connection string");

const codes = (s) =>
  s === null || s === undefined
    ? String(s)
    : typeof s === "string"
    ? [...s].map((c) => c.codePointAt(0).toString(16)).join(" ")
    : `BUFFER ${Buffer.from(s).toString("hex")}`;

const run = async (label, extra) => {
  const conn = await mysql.createConnection(
    extra === undefined ? url : { uri: url, ...extra }
  );
  const table = "sm_unicode_probe";
  await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
  await conn.query(
    `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, note TEXT NOT NULL DEFAULT ('cafe ☕ naïve'), keyed VARCHAR(20) NOT NULL DEFAULT 'cafe ☕')`
  );
  await conn.query(`INSERT INTO \`${table}\` (id) VALUES (1)`);
  const [rows] = await conn.query(
    "SELECT COLUMN_NAME, COLUMN_DEFAULT, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table]
  );
  const [stored] = await conn.query(`SELECT * FROM \`${table}\` WHERE id = 1`);
  for (const r of rows) {
    console.log(
      `${label} | ${r.COLUMN_NAME} | catalog=${codes(r.COLUMN_DEFAULT)} | cs=${r.CHARACTER_SET_NAME}`
    );
  }
  console.log(
    `${label} | stored note=${codes(stored[0].note)} keyed=${codes(stored[0].keyed)}`
  );
  await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
  await conn.end();
};

await run("default-conn");
await run("utf8mb4-conn", { charset: "utf8mb4" });
