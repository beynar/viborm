// U4 repair round: where a backslash-bearing ENUM value that is ALSO the
// column's default is refused, before and after the repair's spelling.
// `mysqlEnumType` doubles the apostrophe only; `escapeValue` now goes through
// `mysqlStringLiteral`, which also escapes the backslash. Creates and drops
// only its own `sm_` table.
import mysql from "/private/tmp/viborm-sm/node_modules/mysql2/promise.js";

const url = process.env.MYSQL_TEST_CONNECTION_STRING;
if (!url) throw new Error("no connection string");

const codes = (s) =>
  s === null || s === undefined
    ? String(s)
    : [...String(s)].map((c) => c.codePointAt(0).toString(16)).join(" ");

const conn = await mysql.createConnection(url);
const table = "sm_enum_default_probe";

const attempt = async (label, ddl) => {
  await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
  try {
    await conn.query(ddl);
  } catch (error) {
    console.log(`${label} | REFUSED errno=${error.errno} code=${error.code} | ${error.sqlMessage}`);
    return;
  }
  const [rows] = await conn.query(
    "SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'flavour'",
    [table]
  );
  const r = rows[0];
  console.log(
    `${label} | CREATED | COLUMN_TYPE=${r.COLUMN_TYPE} (${codes(r.COLUMN_TYPE)}) | COLUMN_DEFAULT=${codes(r.COLUMN_DEFAULT)}`
  );
};

// SQL text sent: ENUM('a\b') NOT NULL DEFAULT 'a\b'   (base: both quote-doubled only)
await attempt(
  "base spelling      ",
  `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, flavour ENUM('a\\b') NOT NULL DEFAULT 'a\\b')`
);
// SQL text sent: ENUM('a\b') NOT NULL DEFAULT 'a\\b'  (after: mysqlEnumType unchanged, default via mysqlStringLiteral)
await attempt(
  "repaired spelling  ",
  `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, flavour ENUM('a\\b') NOT NULL DEFAULT 'a\\\\b')`
);
// SQL text sent: ENUM('a\b') NOT NULL          (a backslash-bearing enum value with NO default)
await attempt(
  "no default         ",
  `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, flavour ENUM('a\\b') NOT NULL)`
);
// SQL text sent: ENUM('a\\b') NOT NULL DEFAULT 'a\\b'  (what an escaped enum member WOULD be)
await attempt(
  "both escaped       ",
  `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, flavour ENUM('a\\\\b') NOT NULL DEFAULT 'a\\\\b')`
);

await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
await conn.end();
