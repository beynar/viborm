/**
 * SQL Server's error numbers, as the SQLSTATE classes the shared driver error
 * mapping (`../error-mapping.ts`) already reads.
 *
 * tedious reports a server error as `number` (the SQL Server message id) with
 * no SQLSTATE, and several ids are MySQL errnos with another meaning (1205 is a
 * deadlock here and a lock wait timeout there), so the id is never handed on
 * as an errno: this module translates it once, at the provider boundary, into
 * the class the rest of VibORM speaks, and names the constraint and table the
 * message carries the way PostgreSQL reports them.
 */

const SQLSTATE_BY_NUMBER: Readonly<Record<number, string>> = {
  // Duplicate key: a PRIMARY KEY or UNIQUE constraint, and a unique index.
  2627: "23505",
  2601: "23505",
  515: "23502",
  2628: "22001",
  8152: "22001",
  220: "22003",
  232: "22003",
  8115: "22003",
  8134: "22012",
  1205: "40P01",
  1222: "55P03",
  3960: "40001",
  208: "42P01",
  207: "42703",
};

/** `'dbo.users'` or `"dbo.users"` → `users`: the table without its schema. */
const objectName = (qualified: string): string =>
  qualified.slice(qualified.lastIndexOf(".") + 1);

const QUOTED = /['"]([^'"]+)['"]/g;

/** The constraint, table and column a server message names, in its own order. */
function namedObjects(
  number: number,
  message: string
): { constraint?: string; table?: string; column?: string } {
  const quoted = [...message.matchAll(QUOTED)].map((match) => match[1]!);
  switch (number) {
    // "Violation of UNIQUE KEY constraint 'c'. … in object 'dbo.t'. …"
    case 2627:
      return { constraint: quoted[0], table: quoted[1] && objectName(quoted[1]) };
    // "Cannot insert duplicate key row in object 'dbo.t' with unique index 'i'."
    case 2601:
      return { table: quoted[0] && objectName(quoted[0]), constraint: quoted[1] };
    // "… conflicted with the FOREIGN KEY constraint "c". … database "d", table "dbo.t", column 'x'."
    case 547:
      return {
        constraint: quoted[0],
        table: quoted[2] && objectName(quoted[2]),
        column: quoted[3],
      };
    // "Cannot insert the value NULL into column 'c', table 'd.dbo.t'; …"
    case 515:
      return { column: quoted[0], table: quoted[1] && objectName(quoted[1]) };
    default:
      return {};
  }
}

function sqlStateOf(number: number, message: string): string | undefined {
  // A batch premise's own refusal (`assertions.exists`): the conversion of
  // its sentinel, reported in the class PostgreSQL's premise fails with.
  if (message.includes("'__viborm_assert__'")) return "22012";
  if (number === 547) {
    if (message.includes("CHECK constraint")) return "23514";
    return "23503";
  }
  return SQLSTATE_BY_NUMBER[number];
}

/**
 * A tedious `RequestError` (or the `mssql` wrapper around one) carrying the
 * SQLSTATE, constraint, table and column of its server error; anything else
 * is returned unchanged.
 */
export function normalizeMssqlError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const number = readErrorNumber(error);
  if (number === undefined) return error;
  const sqlstate = sqlStateOf(number, error.message);
  if (sqlstate === undefined) return error;
  const shaped = new Error(error.message, { cause: error });
  Object.assign(shaped, { sqlstate, ...namedObjects(number, error.message) });
  return shaped;
}

/** The SQL Server message number of a tedious or `mssql` request error. */
export function readErrorNumber(error: unknown): number | undefined {
  return (
    readNumber(error, "number") ??
    readNumber(readObject(readObject(error, "originalError"), "info"), "number")
  );
}

function readObject(value: unknown, key: string): object | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const member: unknown = Reflect.get(value, key);
  return typeof member === "object" && member !== null ? member : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const member: unknown = Reflect.get(value, key);
  return typeof member === "number" ? member : undefined;
}
