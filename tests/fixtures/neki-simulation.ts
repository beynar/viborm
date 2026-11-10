/**
 * PGlite made to refuse what PlanetScale's Neki refuses (measured on Neki's
 * PostgreSQL 18.6, `.probes/hosted/neki-apply-1.2.0.md` and
 * `neki-boundaries-1.2.2.md`; `taint`: Pyxel's production branch,
 * 2026-10-26). See `tests/unit/migrations/postgres-neki-apply.test.ts`.
 */
import type { PGlite, Transaction } from "@electric-sql/pglite";

const TEMPORARY = /\bTEMP(?:ORARY)?\s+(?:VIEW|TABLE)\b/i;
const NAME = String.raw`(?:"[^"]+"\.)?("[^"]+")`;
const CREATED = new RegExp(
  String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|VIEW|TYPE|SEQUENCE|FUNCTION|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`,
  "i"
);
const ALTERED = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${NAME}\s+([\s\S]*)$`,
  "i"
);
const ADDED = /\bADD\s+(?:COLUMN\s+)?(?!CONSTRAINT\b)("[^"]+")/gi;
const RENAMED = /\bRENAME\s+(?:COLUMN\s+)?("[^"]+")\s+TO\s+("[^"]+")/gi;
const RENAMED_TO = /^RENAME\s+TO\s+("[^"]+")/i;
const RETYPED =
  /\bALTER\s+(?:COLUMN\s+)?("[^"]+")\s+(?:SET\s+DATA\s+)?TYPE\b/gi;
const DROPPED = /\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("[^"]+")/gi;
const ROWS = /^(?:INSERT|UPDATE|DELETE|MERGE|SELECT|WITH|DO)\b/i;
const SCHEMA = /^(?:CREATE|ALTER|DROP|COMMENT)\b/i;
export const SESSION_LOCK = /\bpg_try_advisory_lock\(/;
export const XACT_LOCK = /\bpg_try_advisory_xact_lock\(/;
const UNLOCK = /\bpg_advisory_unlock\(/;
const UNLOCK_ALL = /\bpg_advisory_unlock_all\(/;
export const COMPUTED_SETTING = /\bset_config\(\s*name\b/i;
const ROUTINE = /^\s*DO\b/i;
const VERB = /^\s*(\w+)/;

/** What one transaction changed that Neki's planner does not see. */
interface Unseen {
  /** Names it introduced, renamed, retyped or dropped. */
  readonly names: Set<string>;
  /** Relations whose columns it changed: their `*` is stale. */
  readonly columns: Set<string>;
  /** Relations it created or renamed: Neki has not registered them. */
  readonly fresh: Set<string>;
}

const nothingUnseen = (): Unseen => ({
  names: new Set(),
  columns: new Set(),
  fresh: new Set(),
});

/** Records what `text`, a schema statement, changed, or refuses it (NK316). */
function track(text: string, unseen: Unseen, refuse: (code: string) => never) {
  const created = CREATED.exec(text);
  if (created) {
    unseen.names.add(created[2]!);
    if (created[1]!.toUpperCase() === "TABLE") unseen.fresh.add(created[2]!);
    return;
  }
  const altered = ALTERED.exec(text);
  if (!altered) return;
  const [, table = "", clause = ""] = altered;
  const added = [...clause.matchAll(ADDED)].map((match) => match[1]!);
  const renamed = [...clause.matchAll(RENAMED)].flatMap((match) => [
    match[1]!,
    match[2]!,
  ]);
  const retyped = [...clause.matchAll(RETYPED)].map((match) => match[1]!);
  const dropped = [...clause.matchAll(DROPPED)].map((match) => match[1]!);
  if (
    unseen.fresh.has(table) &&
    [...renamed, ...retyped, ...dropped].length > 0
  ) {
    refuse("NK316");
  }
  const to = RENAMED_TO.exec(clause.trim())?.[1];
  if (to) {
    unseen.names.add(to);
    unseen.fresh.add(to);
  }
  for (const name of [...added, ...renamed, ...retyped, ...dropped]) {
    unseen.names.add(name);
  }
  if ([...added, ...renamed, ...dropped].length > 0) unseen.columns.add(table);
}

/**
 * Makes `database` refuse what Neki refuses while `enabled` is set, records
 * the refusals it made, and logs every statement it is sent. `fail` makes
 * the next statement that includes it, past `skip` of them, fail as a
 * provider would; `before.sql` runs once, before the session's statement
 * that is `before.text` past `before.skip` of them.
 */
export function asNeki(database: PGlite): {
  enabled: boolean;
  /**
   * The router of Pyxel's production branch (`checkTaint`, 2026-10-26):
   * once its transaction changed the schema, no statement is planned against
   * any relation, VibORM's own ledger and marker writes included (`NK013`).
   */
  taint: boolean;
  refusals: string[];
  log: string[];
  fail?: string;
  /** A statement containing this text is never answered (once). */
  hang?: string;
  /** Every statement containing `text` answers only after `ms`. */
  slow?: { readonly text: string; readonly ms: number };
  skip: number;
  before?: { readonly text: string; skip: number; readonly sql: string };
} {
  const simulation = {
    enabled: false,
    taint: false,
    refusals: [] as string[],
    log: [] as string[],
    fail: undefined as string | undefined,
    hang: undefined as string | undefined,
    slow: undefined as
      | { readonly text: string; readonly ms: number }
      | undefined,
    skip: 0,
    before: undefined as
      | { readonly text: string; skip: number; readonly sql: string }
      | undefined,
  };
  const { refusals, log } = simulation;
  let unseen = nothingUnseen();
  // Whether the open transaction ran a schema statement (`checkTaint`).
  let tainted = false;
  // The session's advisory locks: session ones held, and whether the open
  // transaction took a transaction one.
  let sessionLocks = 0;
  let transactionLock = false;
  const refuse = (code: string, message = code): never => {
    refusals.push(code);
    throw Object.assign(new Error(message), { code });
  };
  const check = (text: string, inTransaction: boolean) => {
    log.push(text);
    if (simulation.fail && text.includes(simulation.fail)) {
      if (simulation.skip === 0) {
        simulation.fail = undefined;
        throw Object.assign(new Error("injected failure"), { code: "XX000" });
      }
      simulation.skip -= 1;
    }
    const verb = VERB.exec(text)?.[1]?.toUpperCase();
    if (verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK") {
      transactionLock = false;
    }
    if (UNLOCK_ALL.test(text)) sessionLocks = 0;
    else if (UNLOCK.test(text)) sessionLocks = Math.max(0, sessionLocks - 1);
    if (!simulation.enabled) {
      if (SESSION_LOCK.test(text)) sessionLocks += 1;
      return;
    }
    if (TEMPORARY.test(text)) refuse("NK013", "temporary relations");
    if (COMPUTED_SETTING.test(text)) {
      if (ROUTINE.test(text)) {
        refuse(
          "42501",
          "set_config with a non-constant setting name is not allowed in a routine body"
        );
      }
      refuse("NK013", "not implemented: [101]");
    }
    const mixed =
      "not implemented: [61] Mixing session and transaction advisory locks is unavailable.";
    if (XACT_LOCK.test(text)) {
      if (sessionLocks > 0) refuse("NK013", mixed);
      if (inTransaction) transactionLock = true;
    }
    if (SESSION_LOCK.test(text)) {
      if (transactionLock) refuse("NK013", mixed);
      sessionLocks += 1;
    }
    if (verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK") {
      unseen = nothingUnseen();
      tainted = false;
      return;
    }
    if (!inTransaction) return;
    const statement = text.trim();
    if (simulation.taint && tainted && ROWS.test(statement)) {
      refuse(
        "NK013",
        "not implemented: [817] Planning against relation is unavailable: earlier DDL in this transaction is not reflected in the router's schema view."
      );
    }
    if (SCHEMA.test(statement)) tainted = true;
    if (ROWS.test(statement)) {
      const name = [...unseen.names].find((item) => statement.includes(item));
      if (name) refuse("42703", `relation or column ${name} does not exist`);
      const stale = [...unseen.columns].find((item) =>
        statement.includes(item)
      );
      if (stale && statement.includes("*")) refuse("42703", "stale *");
      return;
    }
    track(statement, unseen, refuse);
  };
  // Neki's version string; PGlite's own is kept everywhere else.
  const version = (text: string) =>
    simulation.enabled && text.includes("'%(Neki)%'")
      ? text.replace("pg_catalog.version()", "'PostgreSQL 18.6 (Neki)'")
      : text;
  let open = false;
  const query = database.query.bind(database);
  const transaction = database.transaction.bind(database);
  Object.defineProperty(database, "query", {
    value: async (text: string, params?: unknown[], options?: object) => {
      if (simulation.hang && text.includes(simulation.hang)) {
        simulation.hang = undefined;
        return new Promise(() => undefined);
      }
      if (simulation.slow && text.includes(simulation.slow.text)) {
        const { ms } = simulation.slow;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      const { before } = simulation;
      if (before && text === before.text && before.skip-- === 0) {
        simulation.before = undefined;
        await query(before.sql);
      }
      const verb = VERB.exec(text)?.[1]?.toUpperCase();
      if (verb === "BEGIN") open = true;
      if (verb === "COMMIT" || verb === "ROLLBACK") open = false;
      check(text, open);
      return query(version(text), params, options);
    },
  });
  Object.defineProperty(database, "transaction", {
    value: <T>(callback: (tx: Transaction) => Promise<T>) =>
      transaction((tx) => {
        unseen = nothingUnseen();
        tainted = false;
        const inner = tx.query.bind(tx);
        Object.defineProperty(tx, "query", {
          value: (text: string, params?: unknown[], options?: object) => {
            check(text, true);
            return inner(version(text), params, options);
          },
        });
        return callback(tx).finally(() => {
          unseen = nothingUnseen();
          tainted = false;
        });
      }),
  });
  return simulation;
}
