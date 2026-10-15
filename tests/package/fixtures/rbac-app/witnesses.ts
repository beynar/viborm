// The witness matrix of the RBAC plan (§7), one named case per witness id,
// bound to the oracle reading it is judged against. Every case is `pending`
// until the unit that lands it sets `status: "landed"` and names the test file
// that executes it; `runRbacOracleChecks` (tests/contracts/public-client/
// rbac-app-behavior.ts) refuses a landed case whose file does not exist and a
// table that loses or duplicates an id. Plain data: no VibORM import.
//
// `reads` names what the oracle answers for the case: `rows` (the root rows an
// actor reaches at a model and action), `access` (per row, the actions held:
// `$access`), `highest` (the highest held level), or `none` for a structural
// witness (identity, a refusal at definition time, a statement count, a type),
// which compares against no row set.

export type Substrate = "S3" | "PGl" | "PG" | "My" | "D1" | "Nk";
export type OracleReading = "rows" | "access" | "highest" | "none";

export interface WitnessCase {
  readonly id: string;
  /** The capability contract it pins (plan §1.2). */
  readonly contract: string;
  readonly pins: string;
  readonly reads: OracleReading;
  /** The substrates plan §7 ticks for its row. */
  readonly substrates: readonly Substrate[];
  /** The unit of plan §6 expected to land it (planned, not ruled). */
  readonly unit: string;
  readonly status: "pending" | "landed";
  /** Repository-relative test file that executes it, once landed. */
  readonly test?: string;
}

const EVERY: readonly Substrate[] = ["S3", "PGl", "PG", "My", "D1", "Nk"];
const NO_NEKI: readonly Substrate[] = ["S3", "PGl", "PG", "My", "D1"];
const NODE_SQL: readonly Substrate[] = ["S3", "PGl", "PG", "My"];

type Row = readonly [id: string, pins: string, reads: OracleReading];

/** The domain-predicate witnesses' runner (SQLite3; PGlite, pg, MySQL2 beside). */
const DOMAIN_PREDICATES = "tests/raptor3/post-prep/row-scopes.test.ts";

/** The bound-view witnesses' runner (SQLite3, oracle-bound). */
const BOUND_VIEWS =
  "tests/contracts/public-client/extension-bound-views.core.test.ts";

/** The composition witnesses' runner (SQLite3). */
const COMPOSITION =
  "tests/contracts/public-client/extension-composition.core.test.ts";

/** Each landed case, with the test file that executes it. */
const LANDED: Readonly<Record<string, string>> = {
  "W-K1a": DOMAIN_PREDICATES,
  "W-K1b": DOMAIN_PREDICATES,
  "W-K1c": DOMAIN_PREDICATES,
  "W-K1d": DOMAIN_PREDICATES,
  "W-K1e": DOMAIN_PREDICATES,
  "W-K1f": DOMAIN_PREDICATES,
  "W-K1g": DOMAIN_PREDICATES,
  "W-K2a": DOMAIN_PREDICATES,
  "W-K2b": DOMAIN_PREDICATES,
  "W-K2c": DOMAIN_PREDICATES,
  "W-K2d": DOMAIN_PREDICATES,
  "W-K2e": DOMAIN_PREDICATES,
  "W-K2f": "tests/providers/workers/d1-rbac-app.test.ts",
  "W-K2g": DOMAIN_PREDICATES,
  "W-AS1": BOUND_VIEWS,
  "W-AS2": BOUND_VIEWS,
  "W-AS3": BOUND_VIEWS,
  "W-AS4": BOUND_VIEWS,
  "W-AS5": BOUND_VIEWS,
  "W-AS6": BOUND_VIEWS,
  "W-AS7": BOUND_VIEWS,
  "W-C5": COMPOSITION,
  "W-C8": COMPOSITION,
};

function family(
  contract: string,
  unit: string,
  substrates: readonly Substrate[],
  rows: readonly Row[]
): WitnessCase[] {
  return rows.map(([id, pins, reads]) => ({
    id,
    contract,
    pins,
    reads,
    substrates,
    unit,
    ...(LANDED[id] === undefined
      ? { status: "pending" as const }
      : { status: "landed" as const, test: LANDED[id] }),
  }));
}

export const WITNESSES: readonly WitnessCase[] = Object.freeze([
  ...family("C1", "U5", EVERY, [
    ["W-R1", "root reads, aggregates and groupBy under P(view)", "rows"],
    ["W-R2", "cursors: a cursor on a hidden row is a missing cursor", "rows"],
    ["W-R3", "includes, to-one: a hidden target reads null", "rows"],
    ["W-R4", "includes, to-many: only visible members", "rows"],
    ["W-R5", "some / every / none over visible members", "rows"],
    ["W-R6", "is / isNot over a hidden target", "rows"],
    ["W-R7", "relation counts and relation-count order", "rows"],
    ["W-R8", "recursive reads walk visible nodes only", "rows"],
    ["W-R9", "polymorphic arms under the target's P(view)", "rows"],
  ]),
  ...family("C2", "U1", EVERY, [
    [
      "W-K1a",
      "recurse: true refused; depth: false returns the closure",
      "rows",
    ],
    ["W-K1b", "a misspelt nested key refused at $extends (S-X5)", "none"],
    ["W-K1c", "the four cycles (S-B, S-X1, S-X3, S-X4) terminate", "rows"],
    ["W-K1d", "alias shadowing under nested lowering", "rows"],
    ["W-K1e", "tenancy and soft delete SQL unchanged", "none"],
    ["W-K1f", "a 101-deep tree inherits under up()", "rows"],
    [
      "W-K1g",
      'deleted: "with" / "only" and scope: "all" revive no tombstoned member, team member or grant',
      "rows",
    ],
  ]),
  ...family("C3", "U2", NO_NEKI, [
    ["W-K2a", "10,000 actors, one prepared predicate per name", "none"],
    ["W-K2b", "results equal to the v4 memo path", "rows"],
    ["W-K2c", "DC10/DC11 hold under parameters", "rows"],
    ["W-K2d", "an absent session path under NOT is false", "rows"],
    ["W-K2e", "tenancy's absent optional control still drops", "none"],
    ["W-K2f", "D1: <= 100 distinct binds and <= 100 KB per statement", "none"],
    ["W-K2g", "userId: null matches no orphaned row", "rows"],
  ]),
  ...family("C4", "U3+U5", NO_NEKI, [
    ["W-W1", "title at edit, ownerId at full", "rows"],
    ["W-W2", "an archive-only writer archives and cannot edit", "rows"],
    ["W-W3", "a grant write needs every attachment administered", "rows"],
    ["W-W4", "updateMany counts editable rows only", "rows"],
    ["W-W5", "audit's stamp takes no action (archive with updatedBy)", "rows"],
    ["W-W6", "nested verbs judged at their own action", "rows"],
    ["W-W7", "connect / set / disconnect judge both endpoints", "rows"],
    ["W-W8", "a tombstone's candidates at delete", "rows"],
    ["W-W9", "an m2m connect from the attacker's side refused", "rows"],
    ["W-W10", "a root create and its nested equivalent agree", "rows"],
  ]),
  ...family("C5", "U6+U9", NO_NEKI, [
    ["W-P1", "root create placement", "none"],
    ["W-P2", "createMany placement", "none"],
    ["W-P3", "upsert arms", "none"],
    ["W-P4", "nested create and connectOrCreate", "none"],
    ["W-P5", "a scalar-key move", "none"],
    ["W-P6", "a connect move", "none"],
    ["W-P7", "within on create", "none"],
    ["W-P8", "a concurrent revocation", "none"],
    ["W-P9", "rollback of a refused produced row", "none"],
    ["W-P10", "the grant arc, create and update forms", "none"],
    ["W-P11", "a move on a model without create:", "none"],
    ["W-P12", "a sharer cannot grant export", "none"],
    ["W-P13", "personal-page transfer per OD-14", "none"],
    ["W-P14", "a parent cycle refused", "none"],
    ["W-P15", "a self-granting insert refused", "none"],
    ["W-P16", "a hidden and a missing key target give one error", "none"],
  ]),
  ...family(
    "C6",
    "U4",
    ["S3", "PGl", "D1"],
    [
      [
        "W-AS1",
        "$as builds no chain, no RowsBinding, no PreparedDomain",
        "none",
      ],
      [
        "W-AS2",
        "interleaved requests with differing results never mix",
        "rows",
      ],
      ["W-AS3", "an interactive transaction keeps the actor", "rows"],
      ["W-AS4", "an array transaction mixes views", "rows"],
      ["W-AS5", "$extends from a bound view keeps it", "rows"],
      ["W-AS6", "bind refuses another extension's control", "none"],
      ["W-AS7", "the cache key is per actor", "none"],
    ]
  ),
  ...family("C7", "U5+U9", NODE_SQL, [
    ["W-CAN1", "can, single action", "access"],
    ["W-CAN2", "can, a list of actions in one statement", "access"],
    ["W-CAN3", "can on a hidden row is false", "access"],
    ["W-CAN4", "assert throws ForbiddenError", "access"],
    ["W-CAN5", "organization-level actions", "access"],
    ["W-CAN6", "can equals the oracle on every seeded row", "access"],
  ]),
  ...family("C8", "U7+U9", NO_NEKI, [
    ["W-EV1", "$access equals the oracle per row", "access"],
    ["W-EV2", "$access nested two levels", "access"],
    ["W-EV3", "ordered levels report the highest", "highest"],
    ["W-EV4", "one statement, by statement observation", "none"],
  ]),
  ...family("C9", "U7+U9", NODE_SQL, [
    ["W-F1", "a read-gated field is omitted below its action", "access"],
    ["W-F2", "present at its action", "access"],
    ["W-F3", "an explicit select of it fails", "access"],
    ["W-F4", "filter, order and aggregate read it as absent", "access"],
    ["W-F5", "nested include", "access"],
    ["W-F6", "no row is dropped", "rows"],
    ["W-F7", "write results", "access"],
    ["W-F8", "unique and relation positions", "access"],
  ]),
  ...family("C10", "U9", NO_NEKI, [
    ["W-L1", "a key's actions narrow", "rows"],
    ["W-L2", "a key's ids narrow through the tree", "rows"],
    ["W-L3", "an actor with no key is unaffected", "rows"],
    ["W-L4", "array parameters per dialect", "rows"],
    ["W-L5", "a model the key does not list reaches nothing", "rows"],
    ["W-L6", "a view-only key cannot create, move or connect", "none"],
    ["W-L7", 'a ["share"] key views and shares', "rows"],
    ["W-L8", "absent resources deny", "rows"],
    ["W-N1", 'as: "given" is P(view) ∧ given(view)', "rows"],
    ["W-N2", 'as: "edit" is P(view) ∧ P(edit)', "rows"],
    ["W-N3", "an unknown domain name is a ValidationError", "none"],
    ["W-N4", "a mode never replaces a verb", "rows"],
  ]),
  ...family(
    "C11",
    "U5",
    ["S3", "PGl"],
    [
      ["W-D1", "no actor: refused before any statement", "none"],
      ["W-D2", "an unlisted model is refused", "none"],
      ["W-D3", "an undeclared action is false", "rows"],
      ["W-D4", "an absent actor field folds false", "rows"],
      ["W-D5", "session() per OD-6", "rows"],
      [
        "W-D6",
        "a definition-time false root call refused before any statement",
        "none",
      ],
      ["W-D7", "a revoked or expired key reaches nothing", "rows"],
      ["W-D8", "the §1.1 policy and the blog are admitted", "none"],
      ["W-D9", "a per-call fold gives the ordinary outcome", "rows"],
      ["W-D10", "an unknown actor path is refused at rbac()", "none"],
      ["W-D11", "a null actor value matches nothing", "rows"],
      ["W-D12", "a create with no actor is refused on every model", "none"],
    ]
  ),
  ...family("C12", "U4+U8", NODE_SQL, [
    ["W-C1", "soft delete + rbac per OD-1", "rows"],
    ["W-C2", "tenancy + rbac", "rows"],
    ["W-C3", "audit + rbac", "rows"],
    ["W-C4", "a tombstoned grant grants nothing", "rows"],
    ["W-C5", "a duplicate control name is refused", "none"],
    ["W-C6", "(not described by plan §7, which names seven of eight)", "none"],
    ["W-C7", "a cached read on a governed view is refused", "none"],
    ["W-C8", "audit stamps rbac's actor path", "none"],
  ]),
  ...family(
    "C13",
    "U10",
    ["S3"],
    [["W-X1", "$queryRaw on the governed client returns every row", "rows"]]
  ),
  ...family("§3.3", "U5+U9", NODE_SQL, [
    [
      "W-H1",
      "each helper selects the hand-written rule's rows (rules.ts)",
      "rows",
    ],
    ["W-A1", "R1 per action", "rows"],
    ["W-A2", "stored grant actions", "rows"],
    ["W-A3", "the role ceiling", "rows"],
    ["W-A4", "a request fact, both folds", "rows"],
    ["W-A5", "a row attribute: a plan downgrade is seen at once", "rows"],
    ["W-A6", "the stored ceiling equals the declared one on the seed", "rows"],
  ]),
]);
