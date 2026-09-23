// T3 measurement 6: an estate created under the BASE enum spelling, then
// re-declared under the repaired one. Creates and drops only its own `tm_`
// table. The session's sql_mode is read, never set.
import mysql from "/private/tmp/viborm-tm/node_modules/mysql2/promise.js";
const url = process.env.MYSQL_TEST_CONNECTION_STRING;
if (!url) throw new Error("no connection string");
const conn = await mysql.createConnection({ uri: url });
const TABLE = "tm_upgrade_probe";
const codes = (s) =>
  [...s].map((c) => c.codePointAt(0).toString(16).padStart(2, "0")).join(" ");

const [mode] = await conn.query("SELECT @@SESSION.sql_mode AS mode");
console.log(`sql_mode = ${mode[0].mode}`);

await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
// The BASE spelling: quote doubling only, so `a\b` reaches MySQL as an escape.
await conn.query(
  `CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, kind ENUM('plain', 'a\\b') NOT NULL DEFAULT 'a\\b')`
);
const [created] = await conn.query(
  `SELECT COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'kind'`,
  [TABLE]
);
console.log(
  `base COLUMN_TYPE = ${JSON.stringify(created[0].COLUMN_TYPE)} codes=${codes(created[0].COLUMN_TYPE)}`
);
await conn.query(`INSERT INTO \`${TABLE}\` (id) VALUES (1)`);
const [row] = await conn.query(`SELECT kind FROM \`${TABLE}\` WHERE id = 1`);
console.log(`base stored member codes = ${codes(row[0].kind)}`);

// The REPAIRED spelling, as the next push would MODIFY it.
try {
  await conn.query(
    `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`kind\` ENUM('plain', 'a\\\\b') NOT NULL DEFAULT 'a\\\\b'`
  );
  console.log("MODIFY accepted");
} catch (e) {
  console.log(`MODIFY refused: errno=${e.errno} ${e.code} — ${e.sqlMessage}`);
}
const [after] = await conn.query(
  `SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'kind'`,
  [TABLE]
);
console.log(`after COLUMN_TYPE = ${JSON.stringify(after[0].COLUMN_TYPE)}`);
const [rowAfter] = await conn.query(
  `SELECT kind FROM \`${TABLE}\` WHERE id = 1`
);
console.log(`after stored member codes = ${codes(rowAfter[0].kind)}`);

// And the same MODIFY with NO row holding the old member.
await conn.query(`DELETE FROM \`${TABLE}\``);
try {
  await conn.query(
    `ALTER TABLE \`${TABLE}\` MODIFY COLUMN \`kind\` ENUM('plain', 'a\\\\b') NOT NULL DEFAULT 'a\\\\b'`
  );
  console.log("MODIFY on an empty table accepted");
} catch (e) {
  console.log(`MODIFY on an empty table refused: errno=${e.errno} ${e.code}`);
}
const [empty] = await conn.query(
  `SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'kind'`,
  [TABLE]
);
console.log(`empty-table COLUMN_TYPE = ${JSON.stringify(empty[0].COLUMN_TYPE)}`);

await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
await conn.end();
