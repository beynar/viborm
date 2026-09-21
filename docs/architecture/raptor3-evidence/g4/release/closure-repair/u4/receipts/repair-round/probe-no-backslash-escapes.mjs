// U4 repair round: what the two spellings store on a STRICT session that also
// carries NO_BACKSLASH_ESCAPES. The mode is set on THIS probe connection only
// (SET SESSION); the server's global sql_mode is never touched. Creates and
// drops only its own `sm_` table.
import mysql from "/private/tmp/viborm-sm/node_modules/mysql2/promise.js";

const url = process.env.MYSQL_TEST_CONNECTION_STRING;
if (!url) throw new Error("no connection string");

const codes = (s) =>
  s === null || s === undefined
    ? String(s)
    : [...String(s)].map((c) => c.codePointAt(0).toString(16)).join(" ");

const conn = await mysql.createConnection(url);
const table = "sm_nbe_probe";

const run = async (label) => {
  const [modeRows] = await conn.query("SELECT @@SESSION.sql_mode AS m");
  const mode = modeRows[0].m;
  console.log(
    `${label} | strict=${/STRICT_(TRANS|ALL)_TABLES/.test(mode)} no_backslash_escapes=${mode.includes("NO_BACKSLASH_ESCAPES")}`
  );
  await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
  // SQL text: base = DEFAULT 'a\b' ; repaired = DEFAULT 'a\\b'
  await conn.query(
    `CREATE TABLE \`${table}\` (id INT PRIMARY KEY, base VARCHAR(20) NOT NULL DEFAULT 'a\\b', repaired VARCHAR(20) NOT NULL DEFAULT 'a\\\\b')`
  );
  await conn.query(`INSERT INTO \`${table}\` (id) VALUES (1)`);
  const [cat] = await conn.query(
    "SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    [table]
  );
  const [stored] = await conn.query(`SELECT * FROM \`${table}\` WHERE id = 1`);
  for (const r of cat) {
    if (r.COLUMN_NAME === "id") continue;
    console.log(`${label} | catalog ${r.COLUMN_NAME}=${codes(r.COLUMN_DEFAULT)}`);
  }
  console.log(
    `${label} | raw-insert base=${codes(stored[0].base)} repaired=${codes(stored[0].repaired)}`
  );
  await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
};

await run("default session      ");
await conn.query(
  "SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')"
);
await run("NO_BACKSLASH_ESCAPES ");
await conn.end();
