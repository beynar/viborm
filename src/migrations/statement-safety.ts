/**
 * The ONE lexical classifier for migration-artifact execution safety.
 *
 * VibORM opens an enclosing boundary around every artifact it executes: an
 * apply/down/reset transaction on PostgreSQL, and a session lock on both
 * PostgreSQL and MySQL. This module refuses the DIRECT statements that would
 * end or reframe it — a `COMMIT` inside an artifact ends the rollback scope
 * VibORM promised, and a `RELEASE_LOCK`/`pg_advisory_unlock` inside one frees
 * the lock that is excluding every other migration command (§3.5).
 *
 * It refuses direct lexical controls and is NOT a sandbox for procedural or
 * dynamic SQL. That distinction is the module's contract, not a caveat on it.
 * Manual migration SQL is trusted last-mile authority: its author owns what it
 * does, this included. A dollar-quoted body is DATA to this scan — it has to
 * be, or every ordinary `CREATE FUNCTION` is refused — and the same bytes are a
 * statement to the server, so `DO $$ BEGIN PERFORM pg_advisory_unlock_all();
 * END $$` frees the migration lock while the command holds it. A pre-existing
 * safe-named function, a function the artifact creates, and `EXECUTE` over a
 * built string are the same escape by another route. It is executed rather than
 * asserted: `tests/unit/migrations/pinned-migration-session.core.test.ts` runs
 * that exact artifact through `apply()` on a real PostgreSQL and pins the lock
 * gone. Do not answer a procedural escape with another spelling here — the
 * enumeration does not close, and every addition costs valid author SQL.
 *
 * What the refusals do buy is the ACCIDENT and the audit: an author who typed a
 * `COMMIT` or a `pg_advisory_unlock(...)` straight into an artifact learns
 * before any of it runs, and a deliberate escape has to be WRITTEN as one, in
 * the artifact, where a reviewer sees it. The deliberate case is answered
 * afterwards instead, by the release proof in `pinned-session.ts`: a lock the
 * command acquired and no longer holds fails that command loudly and discards
 * the session, rather than letting it report a migration that ran outside the
 * boundary it published.
 *
 * The scanner is comment- and string-safe, which is the whole reason this is a
 * classifier rather than a regular expression: `-- COMMIT`, `'COMMIT'`, a
 * column named `"commit"`, and a dollar-quoted body that merely mentions
 * `pg_advisory_unlock` are all valid SQL and must stay valid. Only executable
 * tokens are classified.
 *
 * Executable is not enough on its own, because a spelling is not a role. A
 * table named `pg_advisory_notes`, a column named `release_lock`, and MySQL's
 * `@autocommit` user variable are executable tokens that call nothing and set
 * nothing, and refusing them refused valid author SQL over a resemblance. So
 * every scanned word carries the role its POSITION gives it, and the lock
 * refusals key on a call — one owner deciding it for bare and quoted
 * identifiers alike.
 *
 * Comment- and string-safety is DIALECT-SPECIFIC, so the scan takes the dialect
 * rather than reading one lexical grammar into both servers. Every arm below
 * that branches exists because the two servers disagree about what is data:
 * MySQL's `#` line comments and its `--` whitespace rule, its executable
 * `/*!…` comments whose contents the server RUNS, its backslash escapes inside
 * string literals, PostgreSQL's `E'…'` escape strings, and PostgreSQL's nested
 * block comments. Reading one server's grammar on the other either blinds the
 * scanner to a real statement or refuses an artifact that is entirely a
 * comment.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { MigrationTarget } from "./types";

/**
 * Statement-leading PHRASES that open, close, or reframe a transaction.
 *
 * The test is on the LEADING word because that is what makes the word a
 * statement rather than a name: `END` opens nothing in `CREATE TABLE end_state`,
 * and `RELEASE` is only `RELEASE SAVEPOINT` at the start of a statement.
 *
 * `PREPARE TRANSACTION` is the entry that needs a second word, and it needs it
 * in both directions. It DETACHES the running transaction from this session for
 * a later `COMMIT PREPARED`, so where the server allows it at all
 * (`max_prepared_transactions > 0`) the entry's DDL is left unresolved while
 * the tracking write that records it lands in the autocommit that follows. And
 * `PREPARE plan AS SELECT …` begins with the same word while controlling
 * nothing, so refusing the leader alone would ban ordinary author SQL. The
 * phrase is the unit of the test; `PREPARE` alone is not an entry. Its two
 * siblings need no entry of their own — `COMMIT PREPARED` and
 * `ROLLBACK PREPARED` already lead with a refused word.
 */
const POSTGRES_TRANSACTION_LEADERS = new Set([
  "ABORT",
  "BEGIN",
  "COMMIT",
  "END",
  "PREPARE TRANSACTION",
  "RELEASE",
  "ROLLBACK",
  "SAVEPOINT",
  "START",
]);

const MYSQL_TRANSACTION_LEADERS = new Set([
  "BEGIN",
  "COMMIT",
  "LOCK",
  "RELEASE",
  "ROLLBACK",
  "SAVEPOINT",
  "START",
  "UNLOCK",
  "XA",
]);

/**
 * PostgreSQL's advisory-lock family, by prefix.
 *
 * A prefix rather than a list because the family is closed by naming
 * convention and open by variant: session and transaction scope, shared and
 * exclusive, blocking and `try_`. Enumerating them invites the one that is
 * missed.
 *
 * Being this wide is only safe because the prefix is read at a CALL and nowhere
 * else. `pg_advisory_notes` is a table an author may have kept for years, and
 * `pg_advisory_note` a column in it; the family's spelling makes neither of them
 * a function, and refusing them refused valid SQL over a resemblance.
 */
const POSTGRES_ADVISORY_PREFIXES = ["PG_ADVISORY", "PG_TRY_ADVISORY"];

/**
 * Words after which an identifier is the NAME of the object a statement
 * defines, never a function it calls — even with a `(` right behind it.
 *
 * `CREATE TABLE pg_advisory_notes (id INT)` opens a COLUMN list, and
 * `CREATE FUNCTION "pg_advisory_unlock_all"()` an argument declaration; neither
 * calls anything. These are the only words a `(`-followed identifier can sit
 * behind without being a call, and the two servers agree on them: neither has
 * an expression in which a called function's name follows the bare word TABLE,
 * VIEW, FUNCTION, PROCEDURE, AGGREGATE, or the EXISTS of `IF NOT EXISTS`.
 *
 * MySQL's inline index names — `UNIQUE KEY get_lock (id)` — are the one
 * definition this set does not reach, and `KEY`/`INDEX` stay out of it on
 * purpose: unlike the six above, each is also an ordinary column name, so the
 * set would start being reached from expressions and exempt what follows one.
 * A refused index name costs its author a rename; that exemption costs the
 * boundary.
 */
const OBJECT_NAME_KEYWORDS = new Set([
  "AGGREGATE",
  "EXISTS",
  "FUNCTION",
  "PROCEDURE",
  "TABLE",
  "VIEW",
]);

/** MySQL's named-lock family: acquisition, release, and both probes. */
const MYSQL_LOCK_FUNCTIONS = new Set([
  "GET_LOCK",
  "IS_FREE_LOCK",
  "IS_USED_LOCK",
  "RELEASE_ALL_LOCKS",
  "RELEASE_LOCK",
]);

/** The tag body of a PostgreSQL dollar quote: `$tag$`. */
const DOLLAR_TAG_PART = /[A-Za-z0-9_]/;
/** The optional server-version prefix of a MySQL executable comment. */
const VERSION_DIGIT = /[0-9]/;

/**
 * MySQL's SYSTEM-variable sigil, which the bare spelling of the same name also
 * reaches: `SET @@autocommit = 0` and `SET autocommit = 0` change one setting,
 * so the sigil folds away and both meet the same refusal.
 *
 * ONE `@` does not fold. `@autocommit` is a user variable — a slot with a name
 * that happens to read like the setting, which no server behavior consults —
 * and folding it refused `SET @autocommit = 0`, valid MySQL, as a commit-
 * boundary change. `SELECT @release_lock` was refused as a lock call the same
 * way.
 */
const SYSTEM_VARIABLE_SIGIL = /^@@/;

/**
 * The two dialects this classifier reads.
 *
 * SQLite is deliberately absent: it has neither an advisory lock nor a manual
 * transaction-control problem this can express, so
 * {@link assertArtifactExecutionSafe} returns before any scan begins.
 */
export type ClassifiedDialect = "postgresql" | "mysql";

/**
 * The characters that make a bare word, per dialect.
 *
 * `@` is the whole difference and it is not cosmetic. In MySQL the sigil is
 * part of the identifier — `@name` and `@@name` are two different names, and
 * neither is the bare one. PostgreSQL has no variable sigil at all: `@` is an
 * operator character there, so joining it to the word behind it would read
 * `SELECT @pg_advisory_unlock(1)` as one name the advisory prefix no longer
 * matches, hiding a call the server still makes.
 */
const WORD_CHARACTERS: Record<
  ClassifiedDialect,
  { readonly start: RegExp; readonly part: RegExp }
> = {
  mysql: { start: /[A-Za-z_@]/, part: /[A-Za-z0-9_$@]/ },
  postgresql: { start: /[A-Za-z_]/, part: /[A-Za-z0-9_$]/ },
};

/**
 * One executable word and the syntactic role its POSITION gives it.
 *
 * The role is the point. A lock-function refusal that reads spelling alone
 * refuses `CREATE TABLE get_lock (id INT)` and `CREATE TABLE t (release_lock
 * INT)`, which call nothing and are the author's to keep. `calls` is decided
 * once, by {@link callsArguments}, for bare and quoted identifiers alike.
 */
type ScannedWord = {
  /**
   * The folded spelling. A bare word arrives uppercased, minus MySQL's system
   * sigil; a called quoted identifier arrives in its own lowercase spelling,
   * which is the only one that names a PostgreSQL built-in.
   */
  readonly text: string;
  /** Whether an argument list opens behind it, in a position that may call. */
  readonly calls: boolean;
};

/**
 * What sits immediately in front of the cursor, whitespace and comments apart.
 *
 * `qualifier` is the `.` of a qualified name, and it is why the role of
 * `alpha.pg_advisory_notes` is decided by the word in front of `alpha`:
 * `CREATE TABLE` defines that name and `SELECT` calls it, and the qualifier
 * between them changes neither.
 */
type PrecedingToken = "word" | "qualifier" | "other";

/**
 * The EXECUTABLE bare words of an artifact chunk, grouped per statement.
 *
 * Grouping on the top-level `;` is load-bearing, not cosmetic: VibORM's
 * artifact parser splits on its own breakpoint marker, so ONE parsed chunk
 * routinely holds several SQL statements. A classifier that only looked at the
 * first word of the chunk would read `CREATE TABLE t; COMMIT;` as a `CREATE`
 * and let the `COMMIT` through — which is precisely the statement that ends the
 * transaction VibORM promised.
 *
 * Quoted identifiers are excluded rather than included WHEN THEY ARE NAMED: a
 * table or column the author quoted is a name, never a keyword, so
 * `CREATE TABLE "commit"` and a column named `` `get_lock` `` stay valid. Text
 * inside comments, single-quoted literals and PostgreSQL dollar-quoted bodies
 * is skipped for the same reason — it is data, not a statement.
 *
 * A quoted identifier the statement CALLS is the exception: quoting a
 * function's name does not stop PostgreSQL calling it, so
 * `pg_catalog."pg_advisory_unlock_all"()` frees the lock excluding every other
 * migration command while every word the scan retained says
 * `SELECT pg_catalog`. Which of the two a quoted run is comes from
 * {@link callsArguments}, the same owner that decides it for bare words.
 *
 * The dialect decides which runs are data. A MySQL executable comment is the
 * clearest case: its contents are not data at all, and the server runs them.
 */
export function readExecutableStatements(
  sql: string,
  dialect: ClassifiedDialect
): string[][] {
  return scanStatements(sql, dialect).map((words) =>
    words.map((word) => word.text)
  );
}

/**
 * The scan itself: executable words with the role their position gives them,
 * grouped per statement.
 *
 * {@link readExecutableStatements} is this without the roles, which is all the
 * enum-boundary question needs; {@link classifyOne} needs them, because a
 * spelling in a name position is not the call it refuses.
 */
function scanStatements(
  sql: string,
  dialect: ClassifiedDialect
): ScannedWord[][] {
  const characters = WORD_CHARACTERS[dialect];
  const statements: ScannedWord[][] = [];
  let words: ScannedWord[] = [];
  let index = 0;
  let preceding: PrecedingToken = "other";
  /** The previous identifier RUN, whether or not the scan retained it. */
  let previousWord: string | undefined;
  /** The word governing the identifier position the cursor stands in. */
  let governing: string | undefined;

  while (index < sql.length) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (char === "-" && next === "-" && opensLineComment(sql, index, dialect)) {
      index = skipLine(sql, index);
      continue;
    }
    // MySQL's second line-comment spelling. PostgreSQL has none: `#` is an
    // operator character there, and skipping to end of line on it would blind
    // the scan to whatever followed on that line.
    if (dialect === "mysql" && char === "#") {
      index = skipLine(sql, index);
      continue;
    }
    if (char === "/" && next === "*") {
      if (dialect === "mysql" && sql[index + 2] === "!") {
        index = openExecutableComment(sql, index);
        continue;
      }
      index = skipBlockComment(sql, index, dialect);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quoteEnd = skipQuoted(
        sql,
        index,
        char,
        escapesWithBackslash(dialect, char)
      );
      governing = governingWord(preceding, previousWord, governing);
      const name = readQuotedIdentifier(sql, index, quoteEnd, char, dialect);
      if (name !== null && callsArguments(sql, quoteEnd, governing, dialect)) {
        words.push({ text: name, calls: true });
      }
      // A quoted run ends the reach of whatever governed it: nothing that
      // follows a closing quote directly is the name of a defined object.
      preceding = "other";
      index = quoteEnd;
      continue;
    }
    if (char === "$") {
      const dollarEnd = skipDollarQuoted(sql, index);
      if (dollarEnd !== null) {
        index = dollarEnd;
        preceding = "other";
        continue;
      }
    }
    if (char === ";") {
      if (words.length > 0) {
        statements.push(words);
        words = [];
      }
      index += 1;
      preceding = "other";
      continue;
    }
    if (characters.start.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && characters.part.test(sql[index] ?? "")) {
        index += 1;
      }
      const text = sql
        .slice(start, index)
        .toUpperCase()
        .replace(SYSTEM_VARIABLE_SIGIL, "");
      // PostgreSQL's `E'…'` escape string. The `E` is the literal's prefix, not
      // a bare word, and it is the ONE PostgreSQL string form where a backslash
      // escapes the closing quote — reading it as a standard literal closes it
      // early at `\'` and hides every statement up to the next quote.
      if (dialect === "postgresql" && text === "E" && sql[index] === "'") {
        index = skipQuoted(sql, index, "'", true);
        preceding = "other";
        continue;
      }
      governing = governingWord(preceding, previousWord, governing);
      words.push({
        text,
        calls: callsArguments(sql, index, governing, dialect),
      });
      previousWord = text;
      preceding = "word";
      continue;
    }
    if (char.trim() !== "") {
      preceding = char === "." ? "qualifier" : "other";
    }
    index += 1;
  }

  if (words.length > 0) {
    statements.push(words);
  }
  return statements;
}

/**
 * The word that governs the identifier position at the cursor, or undefined
 * when no word reaches it.
 *
 * Directly in front of an identifier, a word governs it: the `TABLE` of
 * `CREATE TABLE get_lock (…)` says that name is being defined. Across a `.`
 * the governor is inherited rather than replaced, so a qualified name is
 * decided by whatever opened the chain — `CREATE TABLE alpha.pg_advisory_notes
 * (…)` defines, `SELECT pg_catalog."pg_advisory_unlock_all"()` calls.
 *
 * Any other punctuation ends the reach, and that is the half that keeps the
 * exemption honest: a comma away from a column named `view`,
 * `SELECT view, "pg_advisory_unlock"(1)` is a call, and reading the previous
 * WORD alone admitted it as a definition.
 */
function governingWord(
  preceding: PrecedingToken,
  previousWord: string | undefined,
  chainGovernor: string | undefined
): string | undefined {
  if (preceding === "word") {
    return previousWord;
  }
  if (preceding === "qualifier") {
    return chainGovernor;
  }
  return undefined;
}

/**
 * The unquoted-equivalent spelling of a quoted identifier, or null when the
 * quoted run is a literal or a spelling no built-in answers to.
 *
 * PostgreSQL is the only dialect that reaches a decision here. MySQL's `"` is a
 * STRING quote, so the same bytes are data there, and its backtick-quoted names
 * resolve to stored functions rather than to the built-in named-lock family —
 * `` SELECT `release_lock`('k') `` does not run MySQL's `RELEASE_LOCK`.
 *
 * A quoted identifier is CASE-SENSITIVE, so only the folded spelling names the
 * built-in: `"PG_ADVISORY_UNLOCK_ALL"` is a function PostgreSQL does not have,
 * and refusing it would ban a name over a call that cannot happen. The name is
 * returned in that folded (lowercase) spelling, which is also what keeps it out
 * of every keyword test in this module — bare words arrive uppercased.
 */
function readQuotedIdentifier(
  sql: string,
  start: number,
  end: number,
  quote: string,
  dialect: ClassifiedDialect
): string | null {
  if (dialect !== "postgresql" || quote !== '"') {
    return null;
  }
  // An UNTERMINATED quote ran to the end of the input; nothing follows it, so
  // nothing calls it.
  if (end - start < 2 || sql[end - 1] !== '"') {
    return null;
  }
  const name = sql.slice(start + 1, end - 1).replaceAll('""', '"');
  return name === name.toLowerCase() ? name : null;
}

/**
 * The ONE call-position owner: whether the identifier ending at `end` is CALLED
 * where it stands.
 *
 * Two halves, and both are needed. A governing keyword makes the identifier the
 * name of an object being defined, `(` behind it or not — that is what keeps
 * `CREATE TABLE pg_advisory_notes (id INT)` and
 * `CREATE TABLE "pg_advisory_unlock_all" (id INT)` valid, since both open a
 * column list. Otherwise an argument list has to actually open, modulo what
 * sits between a function's name and its `(`: whitespace is the obvious case
 * and comments are the one that matters, because
 * `pg_catalog."pg_advisory_unlock_all"/**\/()` is one call to the server and a
 * lookahead that stopped at the first non-space would read it as a name.
 *
 * A qualifier is not read: `myschema."pg_advisory_unlock"()` is a call too,
 * because a `search_path` this classifier cannot see decides what that name
 * resolves to. Whitespace before the `(` is admitted on MySQL as well, where
 * only `IGNORE_SPACE` makes the server accept it — refusing a call the server
 * might make is the direction this classifier can afford to be wrong in.
 */
function callsArguments(
  sql: string,
  end: number,
  governing: string | undefined,
  dialect: ClassifiedDialect
): boolean {
  if (governing !== undefined && OBJECT_NAME_KEYWORDS.has(governing)) {
    return false;
  }
  let cursor = end;
  while (cursor < sql.length) {
    const char = sql[cursor] ?? "";
    if (
      char === "-" &&
      sql[cursor + 1] === "-" &&
      opensLineComment(sql, cursor, dialect)
    ) {
      cursor = skipLine(sql, cursor);
      continue;
    }
    if (dialect === "mysql" && char === "#") {
      cursor = skipLine(sql, cursor);
      continue;
    }
    if (char === "/" && sql[cursor + 1] === "*") {
      cursor = skipBlockComment(sql, cursor, dialect);
      continue;
    }
    if (char.trim() !== "") {
      return char === "(";
    }
    cursor += 1;
  }
  return false;
}

/**
 * Whether the `--` at `start` opens a line comment.
 *
 * PostgreSQL's always does. MySQL's requires whitespace (or a control
 * character, or end of input) after the second dash, so
 * `SELECT 1--RELEASE_LOCK('viborm_migration_…')` is arithmetic over a REAL
 * function call there rather than a comment. Reading it as a comment hides
 * exactly the statement this classifier exists to refuse.
 */
function opensLineComment(
  sql: string,
  start: number,
  dialect: ClassifiedDialect
): boolean {
  if (dialect === "postgresql") {
    return true;
  }
  const after = sql[start + 2];
  if (after === undefined) {
    return true;
  }
  return after.trim() === "" || after.charCodeAt(0) < 0x20;
}

/** Past a line comment, including its newline. */
function skipLine(sql: string, start: number): number {
  const lineEnd = sql.indexOf("\n", start);
  return lineEnd < 0 ? sql.length : lineEnd + 1;
}

/**
 * Past the OPENING of a MySQL executable comment (`/*!`, optionally followed by
 * a server-version prefix), leaving its contents to be scanned as statements.
 *
 * MySQL RUNS what is inside these — that is what they are for — so skipping
 * them the way an ordinary comment is skipped admits
 * `/*!50000 DO RELEASE_LOCK('viborm_migration_…')`, which frees the lock the
 * running command holds, and `/*!40101 SET AUTOCOMMIT=0`, which reframes the
 * commit boundary of everything after it. The closing delimiter needs no arm of
 * its own: neither of its characters starts a word.
 */
function openExecutableComment(sql: string, start: number): number {
  let cursor = start + 3;
  while (cursor < sql.length && VERSION_DIGIT.test(sql[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

/**
 * Past a block comment.
 *
 * PostgreSQL NESTS them, so an outer comment holding a complete inner one is
 * entirely a comment there; stopping at the first close would leave the outer
 * comment's tail scanned as SQL and refuse a valid artifact over a `COMMIT` no
 * server ever sees. MySQL does not nest, so its depth never rises and it stops
 * at the first close — which is also where the server stops.
 */
function skipBlockComment(
  sql: string,
  start: number,
  dialect: ClassifiedDialect
): number {
  let cursor = start + 2;
  let depth = 1;
  while (cursor < sql.length) {
    if (sql[cursor] === "*" && sql[cursor + 1] === "/") {
      depth -= 1;
      cursor += 2;
      if (depth === 0) {
        return cursor;
      }
      continue;
    }
    if (
      dialect === "postgresql" &&
      sql[cursor] === "/" &&
      sql[cursor + 1] === "*"
    ) {
      depth += 1;
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  return sql.length;
}

/**
 * Whether a backslash escapes the next character inside this quote.
 *
 * MySQL's default mode treats `\` as an escape inside both string quotes, so
 * `'a\'b'` is ONE literal there; its backtick identifiers take no escapes.
 * PostgreSQL's strings are standard-conforming, so a backslash is an ordinary
 * character in `'…'` and `"…"` — its one escape-bearing form, `E'…'`, is
 * recognised at the `E` in the scan above.
 */
function escapesWithBackslash(
  dialect: ClassifiedDialect,
  quote: string
): boolean {
  return dialect === "mysql" && quote !== "`";
}

/**
 * Past a quoted run, honoring the doubling escape every admitted dialect uses
 * (`''`, `""`, ` `` `) and, where the dialect has them, backslash escapes. An
 * unterminated quote consumes the rest of the statement, which is what a
 * database would also do with it.
 */
function skipQuoted(
  sql: string,
  start: number,
  quote: string,
  backslashEscapes: boolean
): number {
  let cursor = start + 1;
  while (cursor < sql.length) {
    if (backslashEscapes && sql[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (sql[cursor] !== quote) {
      cursor += 1;
      continue;
    }
    if (sql[cursor + 1] === quote) {
      cursor += 2;
      continue;
    }
    return cursor + 1;
  }
  return sql.length;
}

/**
 * Past a PostgreSQL dollar-quoted body (`$$…$$`, `$tag$…$tag$`), or null when
 * this `$` does not open one.
 *
 * Function bodies are the common shape of a hand-written PostgreSQL artifact,
 * and their contents are a string, not statements. Reading them as statements
 * would refuse a perfectly ordinary `CREATE FUNCTION` whose body happens to
 * contain `COMMIT` or `BEGIN`.
 */
function skipDollarQuoted(sql: string, start: number): number | null {
  let cursor = start + 1;
  while (cursor < sql.length && DOLLAR_TAG_PART.test(sql[cursor] ?? "")) {
    cursor += 1;
  }
  if (sql[cursor] !== "$") {
    return null;
  }
  const tag = sql.slice(start, cursor + 1);
  const bodyEnd = sql.indexOf(tag, cursor + 1);
  return bodyEnd < 0 ? sql.length : bodyEnd + tag.length;
}

/** The refusal a classified statement raises, naming its artifact and cause. */
function refuse(
  artifact: string,
  statement: string,
  reason: string
): MigrationError {
  return new MigrationError(
    `Migration "${artifact}" contains a statement VibORM cannot execute inside the boundary it publishes: ${reason}. ` +
      `The offending statement begins "${statement.trim().slice(0, 80)}". ` +
      "Manual migration SQL owns its object effects; VibORM refuses only the direct controls over its rollback scope, its migration lock, and its tracking boundary, so write the migration without them.",
    VibORMErrorCode.MIGRATION_INVALID_STATE,
    { meta: { migrationName: artifact } }
  );
}

/**
 * Refuses an artifact that DIRECTLY reframes the execution boundary.
 *
 * Runs BEFORE any of the artifact's effects, so a refusal leaves the estate
 * exactly as it was. SQLite has neither an advisory lock nor a manual
 * transaction-control problem this can express — its migration path owns a
 * single connection and its own queue — so it classifies nothing.
 */
export function assertArtifactExecutionSafe(
  statements: readonly string[],
  dialect: MigrationTarget["dialect"],
  artifact: string
): void {
  if (dialect === "sqlite") {
    return;
  }

  for (const chunk of statements) {
    for (const words of scanStatements(chunk, dialect)) {
      classifyOne(words, chunk, dialect, artifact);
    }
  }
}

/**
 * The refusable leading phrase of one statement, or undefined.
 *
 * Two lookups, because an entry is one word or two and the longer one decides:
 * `COMMIT PREPARED 'g'` is refused for its `COMMIT`, `PREPARE TRANSACTION 'g'`
 * for the pair, and `PREPARE plan AS …` for neither. These are the statement's
 * EXECUTABLE words, so the pair is already case-folded and already free of
 * whatever whitespace or comment the author wrote between the two.
 */
function leadingTransactionCommand(
  words: readonly ScannedWord[],
  leaders: ReadonlySet<string>
): string | undefined {
  const first = words[0]?.text;
  const second = words[1]?.text;
  const pair = second === undefined ? undefined : `${first} ${second}`;
  if (pair !== undefined && leaders.has(pair)) {
    return pair;
  }
  return first !== undefined && leaders.has(first) ? first : undefined;
}

/** Classifies ONE statement's executable words. */
function classifyOne(
  words: readonly ScannedWord[],
  statement: string,
  dialect: ClassifiedDialect,
  artifact: string
): void {
  const leader = words[0]?.text;
  if (leader === undefined) {
    return;
  }

  if (dialect === "postgresql") {
    const control = leadingTransactionCommand(
      words,
      POSTGRES_TRANSACTION_LEADERS
    );
    if (control !== undefined) {
      throw refuse(
        artifact,
        statement,
        `the transaction-control statement "${control}", which would end the transaction this migration runs inside`
      );
    }
    // One fold reaches both forms the scan retains: a bare word arrives
    // uppercased, and a called quoted identifier arrives in its own folded
    // spelling, which is the only spelling that names the built-in.
    const advisory = words.find(
      (word) =>
        word.calls &&
        POSTGRES_ADVISORY_PREFIXES.some((prefix) =>
          word.text.toUpperCase().startsWith(prefix)
        )
    );
    if (advisory !== undefined) {
      throw refuse(
        artifact,
        statement,
        `a call to "${advisory.text.toLowerCase()}", which would change the advisory-lock state this migration command holds`
      );
    }
    return;
  }

  const control = leadingTransactionCommand(words, MYSQL_TRANSACTION_LEADERS);
  if (control !== undefined) {
    throw refuse(
      artifact,
      statement,
      `the transaction- or table-lock statement "${control}", which would change the boundary this migration runs inside`
    );
  }
  // `SET autocommit` reframes every following statement's commit boundary, and
  // it is a SET, not a leader of its own — hence the word test. The scan folds
  // `@@autocommit` to that same word and leaves `@autocommit` under its own
  // name, so the setting is reached under both its spellings and the user
  // variable under neither.
  if (leader === "SET" && words.some((word) => word.text === "AUTOCOMMIT")) {
    throw refuse(
      artifact,
      statement,
      "a change to `autocommit`, which would change the commit boundary of every statement that follows"
    );
  }
  const named = words.find(
    (word) => word.calls && MYSQL_LOCK_FUNCTIONS.has(word.text)
  );
  if (named !== undefined) {
    throw refuse(
      artifact,
      statement,
      `a call to "${named.text.toLowerCase()}", which would change the named-lock state this migration command holds`
    );
  }
}

/**
 * Whether a generated PostgreSQL history needs a commit boundary mid-replay.
 *
 * `ALTER TYPE ... ADD VALUE` cannot be used by a statement in the same
 * transaction that added it, so a history where one migration adds an enum
 * value and a later one uses it is replayable one-commit-per-entry (which is
 * what `apply()` does) but NOT inside migration reset's single transaction.
 * Reset refuses such a history before clearing anything, rather than
 * discovering it after the estate is empty.
 *
 * The question is PostgreSQL's alone — no other dialect has the statement — so
 * the scan reads PostgreSQL's lexical grammar rather than taking a dialect its
 * two callers would each have to answer for.
 */
export function needsEnumAdditionCommitBoundary(
  statements: readonly string[]
): boolean {
  for (const chunk of statements) {
    for (const words of readExecutableStatements(chunk, "postgresql")) {
      if (
        words[0] === "ALTER" &&
        words[1] === "TYPE" &&
        words.includes("ADD") &&
        words.includes("VALUE")
      ) {
        return true;
      }
    }
  }
  return false;
}
