// biome-ignore-all lint/style/useFilenamingConvention: UpdateManyRecordSeries is the architecture name (plan §4.6).
import { QueryEngineError, UnsupportedOperationError } from "@errors";
import type { Model } from "@schema/model";
import { buildPrimaryKeyWhereUnique } from "../builders/correlation-utils";
import { buildParsedRelationPrograms } from "../builders/relation-mutation-parser";
import { getPrimaryKeyFields } from "../context";
import { createQueryScope } from "../context/query-scope";
import { buildFind, buildFindUnique } from "../operations";
import type { QueryEngine } from "../query-engine";
import { findSingleTargetMembershipMove } from "../relation-key-legality";
import { ResultParser } from "../result/ResultParser";
import type { Operation, QueryScope } from "../types";
import { validate } from "../validator";
import { exactlyOneRow } from "./fragment-builders";
import type { ExecutableOperation } from "./OperationExecutor";
import {
  type OperationFragment,
  type PlanningFragment,
  type ReadStep,
  ref,
} from "./OperationFragment";
import { planningKey } from "./Part";
import type { RecordSeriesOperation } from "./record-series";
import { StepScope } from "./StepScope";
import { getStepModelName, isRecord } from "./shared";
import { sortCapturedRowKeys } from "./target-projection";
import { UpdateOperation } from "./UpdateOperation";

/**
 * ROOT `updateMany` WHOSE `data` CARRIES RELATIONS (plan §5.2, §6 K).
 *
 * The portable meaning of such a payload is stated by the plan as a seven-step
 * recipe, and this class is that recipe and nothing else: evaluate `where` and the
 * provider `limit` ONCE, lock and capture the complete root row keys, sort them into
 * a deterministic engine order, then run ONE ORDINARY SELECTED-RECORD UPDATE per
 * captured root, sequentially, in one transaction, and shape the results after every
 * effect. It owns no mutation language — every member is an ordinary
 * {@link UpdateOperation} with its own locate, its own `RecordUpdateCompiler`, its
 * own branch selection, its own guards and its own failure — and the
 * {@link RecordSeriesOperation} form is what lets N of them be one routed operation
 * (plan §4.4).
 *
 * ### Why not one set-based UPDATE plus relation Parts
 *
 * That shape exists in this engine already — `ManyAndReturnOperation`'s
 * non-returning arm is literally "one scalar UPDATE addressed by captured keys, then
 * a re-read" — and §5.2 forbids REUSING it here, for reasons that are all about what
 * a per-root update owns and a set-based one cannot: a parent-held to-one fold
 * belongs INSIDE each root's own `UPDATE` (it is a column of that row); a
 * primary-key or referenced-key transition needs that root's OLD value to address its
 * descendants and its NEW value to write them; before-root and after-root descendant
 * ordering is decided per root; and a failure has to be attributable to one captured
 * root rather than to a set. Splitting scalars from relations would make each of
 * those a second owner's problem.
 *
 * ### What the capture is, and what it is not
 *
 * It is a locked read of the complete row keys of the rows the caller's `where`
 * selects, capped by the caller's `limit`. It is the ONLY evaluation of that `where`:
 * every member addresses its root by the captured row key, so no later statement can
 * re-ask "which rows matched" and get a different answer after the earlier members
 * have written. The lock is the existing `forUpdate` flag, which each dialect lowers
 * as it can — `FOR UPDATE` on PostgreSQL and MySQL, deliberately nothing on SQLite,
 * which locks the database rather than rows. §6 K3's "locks when the substrate
 * supports the required lock" is therefore satisfied structurally; this class adds no
 * locking of its own.
 *
 * It selects the row key ALONE. §6 K3 also says "and any root field needed to derive
 * final identity", which is over-specified against the engine as built: each member's
 * own locate re-reads its row through the compiler's `TargetProjection` and publishes
 * the FINAL row key itself, so widening the capture would make this class a second
 * owner of final-identity derivation while changing no answer.
 *
 * ### count
 *
 * `count` is the number of CAPTURED ROOTS — a deliberate divergence from the scalar
 * fast path, which passes the provider's affected-row total straight through. The two
 * disagree, and MySQL is where you see it: mysql2 reports `affectedRows` as CHANGED
 * rows unless `CLIENT_FOUND_ROWS` is set (nothing in this codebase sets it), so
 * `updateMany({ data: { name: <the value it already has> } })` answers `{ count: 0 }`
 * on MySQL and `{ count: N }` on PostgreSQL and SQLite. A relation-bearing call
 * cannot inherit that: its members' writes are not one statement, several of them may
 * change nothing at the root while changing a great deal below it, and "how many roots
 * did this call apply to" is the only question with a portable answer. The scalar arm
 * keeps its passthrough byte-for-byte (`parity-k-update-many.test.ts`), so ONE public
 * operation name now answers a provider-dependent count on one arm and a
 * provider-independent one on the other. That asymmetry is §5.2's instruction; it is
 * recorded here rather than left to be discovered.
 */
export class UpdateManyRecordSeries implements RecordSeriesOperation {
  readonly executionKind = "recordSeries" as const;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  /** The validated payload, as the `updateMany` args schema left it (`omit`
   *  already desugared into `select`), reused verbatim for the public result. */
  private readonly args: Record<string, unknown>;
  /** The RAW update data. Each member parses it itself — see `capturedRoot` in
   *  `shared.ts` for the measurement that forbids sharing one parse. */
  private readonly rawData: Record<string, unknown>;
  /** The public returning projection, or `undefined` for the `{ count }` arm. */
  private readonly select: Record<string, unknown> | undefined;
  /** The complete row key, in schema order: what the capture selects, what the
   *  sort orders by, and what each member is addressed by. */
  private readonly identityFields: readonly string[];
  /** One id allocator for the capture and the reads this series owns; each member
   *  mints its own (independent roots must not share, or their step ids collide). */
  private readonly scope = new StepScope();
  /** The capture read. There is always one: a payload that writes no rows at all
   *  (`limit: 0`) never reaches this class — the router keeps it on the owner that
   *  already answers it without a statement, and therefore without a transaction. */
  private readonly captureRead: ReadStep;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    // `validate` rather than `parseValidated`: it is the SAME entry the two scalar
    // owners use, so the bulk envelope keeps one spelling across all three
    // destinations — including its unprefixed issue paths and the portable-
    // primary-key check it runs under the public name `updateMany`. That check is
    // about `data`, which is shared by every member, so it belongs to the envelope
    // and the members do not repeat it.
    this.args = validate<Record<string, unknown>>(
      engine.schemaRegistry,
      model,
      "updateMany" as Operation,
      args
    );
    this.rawData = updateData(args.data);
    this.select = isRecord(this.args.select) ? this.args.select : undefined;
    // `getPrimaryKeyFields` is TOTAL — a model that declares no `.id()` and no
    // compound id still answers `["id"]` — so there is no primary-key-less case to
    // refuse here, and a guard for one would be a check whose coverage cannot be
    // named. A model whose row key does not exist as a column fails at the capture,
    // in the same sentence any other read of a missing column produces.
    this.identityFields = getPrimaryKeyFields(model);
    this.captureRead = this.buildCapture();
  }

  /**
   * Evaluate the caller's `where` and `limit`, ONCE, and lock what they select.
   *
   * `limit` is applied HERE, in SQL, before the deterministic sort in
   * {@link compileMembers} — §5.2 step 3 in that order, and it matters: capping
   * after an engine-side sort would change WHICH rows a capped call touches, and
   * `ManyAndReturnOperation` already caps at its own capture for the same reason.
   * A capped capture happens to arrive ordered (the find builder appends the
   * identity tie-breakers whenever `take` is defined); an uncapped one does not,
   * which is what the sort is for.
   *
   * ONE PUBLIC KEY, TWO ROW SELECTIONS, stated because the caller cannot see it:
   * this capture caps with `ORDER BY <row key> LIMIT n`, so a relation-bearing
   * `limit: n` deterministically takes the n LOWEST row keys, while the scalar fast
   * path's cap (`buildBulkLimitWhere`) carries no ordering and takes whichever n the
   * provider hands it. The difference is a consequence of capturing at all — a
   * captured set has to be ordered to be executed in a deterministic order — and it
   * is the stricter of the two, so nothing that was deterministic becomes less so.
   */
  capture(): PlanningFragment {
    const steps = [this.captureRead];
    return { steps };
  }

  compileMembers(
    captured: Readonly<Record<string, unknown>>
  ): readonly ExecutableOperation[] {
    const roots = this.capturedRoots(captured);
    // "Empty capture emits no effects" (§5.2). Nothing to refuse, nothing to build:
    // an N-dependent refusal on zero roots would be answering a question no payload
    // asked, and `{ count: 0 }` is the truthful answer for a filter that matched
    // nothing exactly as it is on the scalar arm.
    if (roots.length === 0) return [];
    this.assertMembershipAppliesToEveryRoot(roots.length);
    const rowKeySelect = Object.fromEntries(
      this.identityFields.map((field) => [field, true])
    );
    return roots.map(
      (rowKey) =>
        new UpdateOperation(
          this.engine,
          this.model,
          {},
          {
            capturedRoot: {
              data: this.rawData,
              where: buildPrimaryKeyWhereUnique(this.model, rowKey),
              select: rowKeySelect,
            },
          }
        )
    );
  }

  compileResultReads(
    _captured: Readonly<Record<string, unknown>>,
    memberResults: readonly unknown[]
  ): readonly ExecutableOperation[] {
    const select = this.select;
    if (!select) return [];
    const ctx = createQueryScope(this.engine.adapter, this.model);
    const name = getStepModelName(this.model, "record");
    return memberResults.map(
      (rowKey) =>
        new FinalRootRead(
          ctx,
          this.scope.allocate(`${name}.updateManySeries.read`),
          buildPrimaryKeyWhereUnique(this.model, asRowKey(rowKey)),
          select
        )
    );
  }

  parseSeries(input: {
    readonly captured: Readonly<Record<string, unknown>>;
    readonly memberResults: readonly unknown[];
    readonly resultReadResults: readonly unknown[];
  }): unknown {
    if (!this.select) {
      // The CAPTURED root count, spelled from the capture rather than from the
      // member results, because that is what §5.2 says it is. The two are equal by
      // construction — no member can be silently absent, since any member failure
      // rolls the whole series back — and saying it this way keeps the number
      // attached to its definition.
      return { count: this.capturedRoots(input.captured).length };
    }
    // The reads ran in captured order and answered one row each, so concatenating
    // them IS the deterministic captured-order row set. It is shaped by the SAME
    // parser the returning bulk arm uses, with the same validated payload, so the
    // public projection, omission and scalar casts are that arm's — not a second
    // opinion.
    const rows = input.resultReadResults.flatMap(asRows);
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver,
      this.engine.decimalDecode
    ).parse("updateManyAndReturn", rows, this.args);
  }

  /** The validated `limit`, or `undefined` when the caller omitted it. */
  private limit(): number | undefined {
    return typeof this.args.limit === "number" ? this.args.limit : undefined;
  }

  private buildCapture(): ReadStep {
    const limit = this.limit();
    return {
      id: this.scope.allocate(
        `${getStepModelName(this.model, "record")}.updateManySeries.capture`
      ),
      kind: "read",
      statement: buildFind(
        createQueryScope(this.engine.adapter, this.model),
        {
          ...(isRecord(this.args.where) ? { where: this.args.where } : {}),
          select: Object.fromEntries(
            this.identityFields.map((field) => [field, true])
          ),
          forUpdate: true,
        },
        limit === undefined ? {} : { limit }
      ),
      outputs: { rows: { kind: "rows" } },
    };
  }

  /**
   * The captured roots, in DETERMINISTIC ENGINE ORDER — the one order in which the
   * members run, the result reads are built, and the public rows come back.
   */
  private capturedRoots(
    captured: Readonly<Record<string, unknown>>
  ): readonly Record<string, unknown>[] {
    const rows = captured[planningKey(this.captureRead.id, "rows")];
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        "query-engine-v2 updateMany with relation data did not expose its captured root rows."
      );
    }
    return sortCapturedRowKeys(
      this.identityFields,
      rows.map((row) => asRowKey(row))
    );
  }

  /**
   * THE ONE REFUSAL THIS ROUTE ADDS (plan §5.2, typed, before the first write).
   *
   * `connect`, `connectOrCreate` and `set` on a CHILD-HELD edge move the membership
   * by writing the CHILD: the child row stores which parent it belongs to, and it can
   * store exactly one. Applied to N captured roots in sequence, each root would steal
   * the same child from the previous one and the call would end with the LAST root
   * owning it — which is not "apply this update to every selected root", it is "apply
   * it to one of them and silently undo it for the rest". There is no per-root
   * spelling of the intent, so the engine refuses rather than pick a root.
   *
   * WHAT IS DELIBERATELY NOT REFUSED. A JUNCTION edge stores membership in a third
   * table that admits many parents, so N roots may each link the same target
   * meaningfully. A PARENT-HELD edge — including a direct polymorphic one, whose
   * `(type, id)` pair is a column of the root — stores the membership on the ROOT, so
   * each root gets its own copy and N of them agree by construction. `create` is
   * absent from the refused set too: one fresh child per root is exactly N children,
   * each owned by its own root. And nothing here depends on N being large — at N = 1
   * every one of these shapes means what a single `update` means, which is why the
   * refusal names the observed count.
   *
   * IT SCANS RAW ENTRIES, WHICH IS WHAT MAKES IT COMPLETE. The to-one composition
   * lattice lets a supplier travel beside a modifier (`{ connect, update }`,
   * `{ disconnect, connect }`, the child-held `{ vacate, supply, update }` triples),
   * and its composition owner buckets those entries WITHOUT renaming or merging their
   * kinds. So a composed `connect` still presents itself as a `connect` to a scan of
   * `program.entries` — a composed pair applied to N roots is the same child stolen N
   * times — and scanning before composition is both sufficient and the only place that
   * sees every supplier uniformly.
   *
   * WHAT IT DOES NOT REACH, measured and left as it is rather than discovered later:
   * the ROOT's own relation keys. A membership move that a fresh descendant carries
   * (`{ posts: { create: { comments: { connect: [{ id: 7 }] } } } }`) is applied once
   * per root, and comment 7 ends up under the LAST root's fresh post — the same
   * arithmetic as the refused root-level shape, one level down. It is not refused
   * here because at that depth the series is doing EXACTLY what the same payload
   * spelled as N ordinary `update` calls does, and refusing it would make the bulk
   * spelling reject what the single spelling executes. §5.2 legislates root shapes;
   * this boundary is pinned as behavior in `update-many-relation-series-behavior.ts`
   * so it stays a decision.
   *
   * WHICH SHAPES ARE THE SUBJECT is `findSingleTargetMembershipMove`'s (the relation
   * legality owner's), not this shell's: it knows the edge topology and the parsed
   * entry shapes, and it is the one place that knows an EMPTY collection names no
   * target at all. This class owns only the count and the sentence.
   */
  private assertMembershipAppliesToEveryRoot(rootCount: number): void {
    if (rootCount < 2) return;
    const parent = createQueryScope(this.engine.adapter, this.model);
    // The RAW data, which is what the members compile: the guard and the writes read
    // one source. Building programs is not parsing — no scalar transform runs here,
    // and the members' own parses are untouched.
    const move = findSingleTargetMembershipMove(
      parent,
      buildParsedRelationPrograms(parent, this.rawData).relations
    );
    if (!move) return;
    throw new UnsupportedOperationError(
      `updateMany matched ${rootCount} rows, so it cannot apply '${move.kind}' to relation '${move.relationName}': that membership is stored on the target row, which can belong to only one of them — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`
    );
  }
}

/**
 * One ordinary read of one final root row, by its complete row key.
 *
 * It is spelled here rather than through `ReadOperation` for the reason every
 * already-validated route in this engine exists: `ReadOperation` re-validates through
 * the `findUnique` args schema, which would re-parse the caller's already parsed
 * `select` (the non-idempotence X2 records). It is the same shape
 * `CreateManyRecordSeries` and `ManyAndReturnOperation` build for their own final
 * reads.
 */
class FinalRootRead implements ExecutableOperation {
  readonly mode = "transaction" as const;
  private readonly step: ReadStep;

  constructor(
    ctx: QueryScope,
    id: string,
    where: Record<string, unknown>,
    select: Record<string, unknown>
  ) {
    this.step = {
      id,
      kind: "read",
      statement: buildFindUnique(ctx, { where, select }),
      outputs: { result: { kind: "rows" } },
      // THE MISSING-FINAL-READ DECISION. A captured root can stop existing at its
      // final row key for two reasons, and both are reachable HERE in a way neither
      // is on the create side:
      //
      //   · a LATER member MOVED it — legal whenever a row-key member is also a
      //     foreign key, or through any primary-key transition on a self-relation;
      //   · a LATER member DELETED it — a self-referencing `delete`/`deleteMany` in
      //     the shared `data` removes another captured root. `createMany` has no
      //     delete verb, so this whole class is new to `updateMany`.
      //
      // The answer is REFUSE, not "return the rows that survived", and ONE argument
      // decides it: the engine's own adjacent behaviour. When the removal happens
      // BEFORE the victim's member runs, that member already fails loudly at its own
      // locate, with `NotFoundError`. Choosing a legal-empty final read would mean
      // the SAME payload answers `NotFoundError` or a silently shorter row list
      // depending only on the order the roots were captured in — an order-dependent
      // public contract, which is exactly what §5.2's determinism requirement
      // forbids.
      //
      // What it is NOT: an argument that the two arms must agree. They do not agree
      // under either choice — `{ count }` answers the captured N and succeeds for
      // the very payload the `select` arm refuses here (both witnessed) — so "the
      // arms would disagree" would have been a reason for nothing.
      //
      // So: one row per captured root, or the call refuses and everything rolls
      // back. `raceable: false` — a retry would deterministically do the same thing.
      // The message names both causes as the EXPLANATION of an observation rather
      // than as a claim about a row this code never saw.
      //
      // ITS REACH IS CARDINALITY AT THE REPORTED KEY, not provenance: it answers
      // "is there exactly one row here", never "is this the row that member updated"
      // — and there is no produced-identity selector channel that could answer the
      // second. The gap that implies has no witness: for a
      // later member to REPLACE a captured root at its own key, the shared `data`
      // would have to recreate that key, and then the FIRST member to run it
      // collides with the row that is still there (measured on PGlite).
      expects: exactlyOneRow({
        kind: "query",
        message:
          "updateMany with 'select' could not read back one of the updated rows at the primary key it reported. A later row in the same call moved or removed that row; use the '{ count }' form, or write those rows in separate calls.",
        raceable: false,
      }),
    };
  }

  planning(): PlanningFragment {
    return { steps: [] };
  }

  compile(): OperationFragment {
    return {
      steps: [this.step],
      outputs: { result: ref(this.step.id, "result") },
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    return outputs.result as T;
  }
}

/**
 * A captured row, and a member's answer, are both row keys. The narrowing is here
 * because the capture's rows and the executor's member results both arrive as
 * `unknown`; a value that is not a record means the engine wired a read to the wrong
 * projection, so it is an engine fault (`QueryEngineError`), never a user-facing
 * route.
 */
function asRowKey(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    "query-engine-v2 updateMany with relation data lost a captured root's row key."
  );
}

/**
 * The same narrowing for a read's rows. How MANY rows is the step's postcondition
 * (above); this is only the executor's `unknown` boundary, and it is spelled loudly
 * for the same reason its sibling is — a silent `[]` here would drop a row from the
 * public answer, which is the exact failure the postcondition exists to prevent.
 */
function asRows(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  throw new QueryEngineError(
    "query-engine-v2 updateMany with relation data lost a root's final read."
  );
}

/**
 * The `data` this shell was routed for. Worded as an ENGINE FAULT rather than as a
 * shape check (the distinction the parse-boundary ratchet enforces):
 * the envelope's schema already admits no payload without an object `data`, so a
 * caller cannot reach this — only a route that skipped the boundary can.
 */
function updateData(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    "query-engine-v2 internal: updateMany with relation data reached its shell with no update data; the parse boundary admits none."
  );
}
