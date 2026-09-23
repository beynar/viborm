// T3 measurement: WHERE the encoding of a non-ASCII default is lost.
// Creates and drops only its own `tm_` table.
import mysql from "/private/tmp/viborm-tm/node_modules/mysql2/promise.js";

const url = process.env.MYSQL_TEST_CONNECTION_STRING;
if (!url) throw new Error("no connection string");

const codes = (s) =>
  s === null || s === undefined
    ? String(s)
    : typeof s === "string"
      ? [...s].map((c) => c.codePointAt(0).toString(16)).join(" ")
      : `BUFFER ${Buffer.from(s).toString("hex")}`;

const VALUE = "café ☕";
const TABLE = "tm_unicode_probe";

const run = async (label, extra) => {
  const conn = await mysql.createConnection(
    extra === undefined ? { uri: url } : { uri: url, ...extra }
  );
  try {
    const [vars] = await conn.query(
      "SELECT @@character_set_client c, @@character_set_connection cc, @@character_set_results cr, @@collation_connection col"
    );
    console.log(`${label} | session ${JSON.stringify(vars[0])}`);
    await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
    await conn.query(
      `CREATE TABLE \`${TABLE}\` (id INT PRIMARY KEY, note TEXT NOT NULL DEFAULT ('${VALUE}'), keyed VARCHAR(20) NOT NULL DEFAULT '${VALUE}')`
    );
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_DEFAULT, EXTRA,
              HEX(COLUMN_DEFAULT) AS hex_default,
              CHARSET(COLUMN_DEFAULT) AS cs, COLLATION(COLUMN_DEFAULT) AS coll,
              LENGTH(COLUMN_DEFAULT) AS bytes, CHAR_LENGTH(COLUMN_DEFAULT) AS chars,
              HEX(CONVERT(COLUMN_DEFAULT USING binary)) AS hex_binary,
              HEX(CONVERT(CONVERT(COLUMN_DEFAULT USING binary) USING utf8mb4)) AS hex_reinterpreted,
              CHARACTER_SET_NAME AS col_cs
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [TABLE]
    );
    for (const r of rows) {
      console.log(
        `${label} | ${r.COLUMN_NAME} extra=${r.EXTRA} col_cs=${r.col_cs}\n` +
          `    client-sees = ${codes(r.COLUMN_DEFAULT)}\n` +
          `    server HEX(COLUMN_DEFAULT) = ${r.hex_default}\n` +
          `    server CHARSET = ${r.cs} / ${r.coll} bytes=${r.bytes} chars=${r.chars}\n` +
          `    HEX(CONVERT USING binary) = ${r.hex_binary}\n` +
          `    HEX(binary->utf8mb4)      = ${r.hex_reinterpreted}`
      );
    }
    const [create] = await conn.query(`SHOW CREATE TABLE \`${TABLE}\``);
    const ddl = create[0]["Create Table"];
    console.log(`${label} | SHOW CREATE (note clause) = ${JSON.stringify(ddl.split("\n").filter((l) => l.includes("note") || l.includes("keyed")).join(" | "))}`);
    const [ddlHex] = await conn.query(
      `SELECT HEX(SUBSTRING_INDEX(SUBSTRING_INDEX(?, 'DEFAULT ', -2), ')', 1)) h`,
      [ddl]
    );
    console.log(`${label} | SHOW CREATE bytes around default: ${ddlHex[0].h}`);
    await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``);
  } finally {
    await conn.end();
  }
};

await run("default-conn");
await run("utf8mb4-conn", { charset: "utf8mb4" });
console.log("mysql2 version:", (await import("/private/tmp/viborm-tm/node_modules/mysql2/package.json", { with: { type: "json" } })).default.version);
