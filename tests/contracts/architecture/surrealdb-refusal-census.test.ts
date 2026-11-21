/**
 * Every refusal the SurrealDB driver and its migrations can state, and why it stands.
 *
 * A refusal here is a feature another database has and this one does not, so a new one
 * is a decision: it names itself here, or the census fails. What these say is in
 * docs/architecture/query-backend-frontier.md and the driver's page.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** What the engine and the schema never ask of this driver: each only ends a switch. */
const NEVER_ASKED = "never asked";

const CENSUS: Readonly<Record<string, string>> = {
  // Statements only SQL's plan writes: this driver answers these in its own.
  "an assignment spelled apart from its statement": NEVER_ASKED,
  "a condition spelled apart from its statement": NEVER_ASKED,
  "a read over a write's own rows": NEVER_ASKED,
  "a write that reads before it writes, in a batch":
    "NEVER: a call here is sent in a transaction, where each answer is heard",
  "'…'": NEVER_ASKED,
  "a '…' projection": NEVER_ASKED,
  "a '…' filter": NEVER_ASKED,
  "a '…' operand": NEVER_ASKED,
  "this filter target": NEVER_ASKED,
  "the '…' operator": NEVER_ASKED,
  "the '…' operator in a having": NEVER_ASKED,
  "the '…' update": NEVER_ASKED,
  "a junction here": NEVER_ASKED,
  "a declared junction as an edge": NEVER_ASKED,
  "this junction": NEVER_ASKED,
  "the link column '…'": NEVER_ASKED,
  "ordering by '…' with this specification": NEVER_ASKED,
  "ordering by '…'": NEVER_ASKED,
  // The schema's validation refuses these on every database.
  "ordering by a count through '…'": "validation refuses it everywhere",
  "ordering by a distance through a relation":
    "validation refuses it everywhere",
  // Lowered on the SQL databases only, by the owner's decision (2026-11-17).
  "ordering by '…' of the relation '…'":
    "NOT YET: an aggregate of a relation's rows is a SQL database's",
  "the aggregates of a relation's rows ('_aggregate')":
    "NOT YET: an aggregate of a relation's rows is a SQL database's",
  // Reached only through a path, which a filter reading further never takes.
  "a recursive filter through a to-one link": NEVER_ASKED,
  "a filter through a to-one link into a declared junction": NEVER_ASKED,
  "a to-many filter through a to-one link": NEVER_ASKED,
  // Migrations: a snapshot that does not hold together, which the differ never plans.
  "a field of type '…'": NEVER_ASKED,
  "a native enum": "NEVER: supportsNativeEnums is false",
  // A view (DEFINE TABLE … AS SELECT) follows writes to its source table alone.
  "selects '…' through a relation":
    "LIMIT: a view follows writes to its source table only, so what it reads of another goes stale",
  "filters through a relation":
    "LIMIT: a view follows writes to its source table only, so what it reads of another goes stale",
  "takes a window":
    "LIMIT: ORDER BY, LIMIT and START do not parse in DEFINE TABLE … AS",
  "skips rows":
    "LIMIT: ORDER BY, LIMIT and START do not parse in DEFINE TABLE … AS",
  "orders its rows":
    "LIMIT: ORDER BY, LIMIT and START do not parse in DEFINE TABLE … AS",
  "keeps one row per distinct value":
    "LIMIT: a view holds one row per row of its source",
  // An aggregated view (DEFINE TABLE … AS SELECT … GROUP BY) keeps what the
  // database maintains for each write to its source, and nothing else.
  "keeps the groups a having holds":
    "LIMIT: a view of groups has no filter of the groups themselves (no HAVING)",
  "groups by a time step": "LIMIT: groupBy reads no time step here",
  "… the double '…'":
    "LIMIT: a view's sum is kept by adding and subtracting each write, which drifts on doubles",
  "… '…', which holds a record":
    "LIMIT: a key or a link is a record, which a view's math reads as no number",
  "… '…', which is no number and no dateTime":
    "LIMIT: a view keeps math::min/max of numbers and time::min/max of dateTimes only",
  "pages from a cursor": "SAME AS SQL: a paging anchor is not a row set",
  "filters with an SQL fragment":
    "SAME AS SQL: a view's query holds plain values, written as literals",
  "its source does not take": "SAME AS SQL: its source's findMany refuses it",
  "the junction '…'": NEVER_ASKED,
  "a junction over anything but a record's own key":
    "a generated junction is over each record's key; a declared one is a model",
  "renaming the table '…', which is not there": NEVER_ASKED,
  "renaming a field of '…', which is not there": NEVER_ASKED,
  "renaming the unknown field '….…'": NEVER_ASKED,
  "a foreign key on '…', which is not there": NEVER_ASKED,
  "the foreign key '…' over an unknown field": NEVER_ASKED,
  "a new key on '…', which is not there": NEVER_ASKED,
  // What is true of this database or of any, and is the caller's to change.
  "changing the key of '…', whose unique … has no value to stand in":
    "LIMIT: a unique over booleans or lists has no value that frees it while a record moves",
  "the name '…'":
    "LIMIT: a name holding a backtick cannot be written in SurrealQL",
  "a key the database generates":
    "SAME AS SQL: only an increment is generated; anything else needs its value",
  "arithmetic on a key of type '…'": "SAME AS SQL: arithmetic reads numbers",
  "setNull on a key that holds another":
    "SAME AS SQL: a key part cannot hold nothing",
  "setNull on '…', whose columns are all the row's key":
    "SAME AS SQL: a key part cannot hold nothing",
  "the partial index '…'":
    "LIMIT: a predicate past comparisons, IN, IS NULL, AND, OR and NOT is SQL only the database reads",
  "the unique '…' over a part of a key that cannot be named":
    "LIMIT: an id part is indexed by its name, and a decimal part has none",
  "a new key on '…', which '…' still references":
    "SAME AS SQL: what holds a record by its key goes first",
  "leaving '…' without a key: a record's key is its id":
    "LIMIT: a record always has an id",
  "ordering by the relation '…' through another relation":
    "LIMIT: a to-one that is no record link cannot be walked on from a row a path reached",
  "a new key on '…' holding a field the raw index '…' names":
    "LIMIT: a raw index's text names fields, and a key's parts are in the id",
};

const SOURCES = [
  "src/drivers/surrealdb/queries.ts",
  "src/drivers/surrealdb/writer.ts",
  "src/drivers/surrealdb/read-backend.ts",
  "src/migrations/drivers/surrealql/index.ts",
  "src/migrations/drivers/surrealql/view.ts",
];
const REFUSAL = /\brefuse(?:Until)?\(\s*(`[^`]*`|"[^"]*")/g;
const INTERPOLATION = /\$\{(?:[^{}]|\{[^{}]*\})*\}/g;

const stated = () =>
  new Set(
    SOURCES.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(REFUSAL)].map(([, text]) =>
        text!.slice(1, -1).replace(INTERPOLATION, "…")
      )
    )
  );

describe("the SurrealDB refusal census", () => {
  it("names every refusal the sources state", () => {
    expect([...stated()].filter((text) => !(text in CENSUS))).toEqual([]);
  });

  it("names none they no longer state", () => {
    const refusals = stated();
    expect(Object.keys(CENSUS).filter((text) => !refusals.has(text))).toEqual(
      []
    );
  });
});
