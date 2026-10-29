/**
 * Whether this database's own `LOWER` folds `É`. `mode: "insensitive"` ignores
 * case the way the database does, so a non-ASCII letter follows its answer:
 * PostgreSQL with a libc or ICU locale and MySQL fold it; SQLite and a
 * `C`-locale PostgreSQL (PGlite) fold `A`-`Z` only.
 */
export async function foldsNonAscii(client: {
  $queryRawUnsafe(query: string): Promise<unknown>;
}): Promise<boolean> {
  const rows = (await client.$queryRawUnsafe(
    "SELECT LOWER('É') AS folded"
  )) as { folded: string }[];
  return rows[0]?.folded === "é";
}
