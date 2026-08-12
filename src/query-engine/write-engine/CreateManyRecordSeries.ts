// biome-ignore-all lint/style/useFilenamingConvention: CreateManyRecordSeries is the architecture name (plan §4.6).
import { QueryEngineError, UnsupportedOperationError } from "@errors";
import type { Model } from "@schema/model";
import { buildPrimaryKeyWhereUnique } from "../builders/correlation-utils";
import { getPrimaryKeyFields } from "../context";
import { createQueryScope } from "../context/query-scope";
import { buildFindUnique } from "../operations";
import type { QueryEngine } from "../query-engine";
import { ResultParser } from "../result/ResultParser";
import type { QueryScope } from "../types";
import { CreateOperation } from "./CreateOperation";
import { exactlyOneRow } from "./fragment-builders";
import type { ExecutableOperation } from "./OperationExecutor";
import {
  type OperationFragment,
  type PlanningFragment,
  type ReadStep,
  ref,
} from "./OperationFragment";
import { parseValidated } from "./parse-boundary";
import type { RecordSeriesOperation } from "./record-series";
import { StepScope } from "./StepScope";
import { getStepModelName, isRecord } from "./shared";

/**
 * ROOT `createMany` WHOSE ROWS CARRY RELATIONS (plan §5.1, §6 J).
 *
 * The portable meaning of such a payload is stated by the plan in one sentence:
 * "ordinary create calls executed left to right in one transaction". This class is
 * that sentence and nothing else. It owns no mutation language of its own — every
 * member is an ordinary {@link CreateOperation}, with its own planning, its own
 * branch selection, its own guards, its own record compiler and its own failure —
 * and the {@link RecordSeriesOperation} form is what lets N of them be one routed
 * operation (plan §4.4).
 *
 * WHY LEFT TO RIGHT, AND WHY NOT PRE-PLANNED. Row N may observe what row N-1 did:
 * two rows whose `connectOrCreate` names the same target must end with ONE target
 * row, and the second row can only know that by probing after the first row's write
 * landed in this transaction. Planning every row first and writing afterwards makes
 * both probes miss and both arms create. That is why the series exists at all, and
 * why nothing here caches a decision across members: `compileMembers` CONSTRUCTS
 * every member before the first one runs (so a shape the engine cannot express is
 * refused while this scope has nothing to undo), but construction chooses no arm —
 * `RelationUpsertPart` picks its arm in `compile(known)`, from that member's own
 * probe rows. First-create-wins across rows is therefore an EXECUTION fact, not a
 * ledger: no cross-member selector table exists, and adding one would both duplicate
 * an invariant execution already enforces and suppress the missing-arm race pin that
 * handles an external concurrent creator. (Within ONE row, the existing
 * same-operation ledger in `RelationUpsertPart` still answers, byte-identically to
 * the same payload spelled as a single `create`.)
 *
 * WHAT ROUTES HERE is decided in `routing.ts`, on the RAW rows, before any parse:
 * the two existing owners are constructed unchanged (plan §6 J2), so routing cannot
 * hand them a pre-parsed payload, and re-parsing a schema's own output is
 * non-idempotent (X2). A row is series-bound iff it names an ordinary relation with
 * a defined value. Scalar-only rows and rows whose only relation work is a DIRECT
 * polymorphic `connect` keep the grouped multi-row INSERT and the grouped bulk probe
 * exactly as before — `parity-j-create-many.test.ts` is the byte record of both.
 *
 * THE RESULT. `count` is the number of successfully inserted ROOT rows, which is the
 * number of members that completed: no member can be silently absent, because
 * `skipDuplicates` is refused on this route (below) and any other failure rolls the
 * whole scope back. A returning projection is read AFTER every member finishes, one
 * ordinary read per final root row key in input order, so a later row's relation
 * effects cannot leave an earlier row's returned projection stale. Those reads carry
 * the arm's ordinal contract: one row each, or the call refuses — see
 * {@link FinalRootRead}, whose postcondition is the difference between "N rows out for
 * N rows in" and a plausible short list.
 *
 * ONE COST, DELIBERATE. Every member is asked for its row key (plan §6 J3 step 4), so
 * every member ends with the terminal read an ordinary `create` already ends with —
 * including on the `{ count }` arm, which then never looks at it. Suppressing it there
 * was considered and rejected: it would need a fourth already-validated input route
 * whose member is no longer an ordinary create, which is the one property this class
 * exists to preserve, and it would buy nothing a returning driver's folded RETURNING
 * does not already fold. Per-row round trips on the bulk arms are a separate subject,
 * not a reason to make a member special here.
 */
export class CreateManyRecordSeries implements RecordSeriesOperation {
  readonly executionKind = "recordSeries" as const;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  /** The validated payload, as the `createMany` args schema left it (`omit`
   *  already desugared into `select`), reused verbatim for the public result. */
  private readonly args: Record<string, unknown>;
  private readonly rows: readonly Record<string, unknown>[];
  /** The public returning projection, or `undefined` for the `{ count }` arm. */
  private readonly select: Record<string, unknown> | undefined;
  /** What each member answers with: its complete final root row key, nothing else. */
  private readonly rowKeySelect: Record<string, unknown>;
  /** One id allocator for the reads this series owns; each member mints its own
   *  (independent roots must not share, or their step ids collide). */
  private readonly scope = new StepScope();

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    const parsed = parseValidated(
      engine.schemaRegistry.getModelSchemas(model).args.createMany,
      args,
      "createMany",
      "createMany"
    );
    this.args = parsed;
    this.rows = parsed.data;
    // THE ONE REFUSAL THIS ROUTE ADDS (plan §5.1, typed, at construction). It is
    // stated here rather than in the schema because the predicate it needs — "this
    // row carries a general relation program" — is the router's shell choice, and
    // the validation layer may not reach for the engine's relation predicates. So it
    // is not a second owner: being inside this class IS the predicate, already
    // decided. It fires AFTER the parse above, so a malformed payload still fails
    // validation first, as it does on every other route.
    //
    // It is a product gap, not a substrate one, which is why it is an
    // UnsupportedOperationError and not the TransactionError the substrate refusals
    // carry: no driver capability would change the answer. The public meaning has to
    // pick one of two incompatible contracts first (§5.1), and the plan says not to
    // guess it.
    if (parsed.skipDuplicates === true) {
      throw new UnsupportedOperationError(
        "createMany cannot combine 'skipDuplicates' with nested relation writes: a skipped row has no defined meaning for its nested effects — they could be suppressed, or applied to the row that already exists — and viborm will not pick one silently. Drop 'skipDuplicates', or write the relations in a separate call."
      );
    }
    this.select = isRecord(parsed.select) ? parsed.select : undefined;
    this.rowKeySelect = Object.fromEntries(
      getPrimaryKeyFields(model).map((field) => [field, true])
    );
  }

  /**
   * The root set of a `createMany` is the payload itself — the application already
   * knows every row — so there is nothing to fix inside the scope. Plan §4.4 names
   * this case explicitly: "For createMany it is an empty planning fragment."
   */
  capture(): PlanningFragment {
    return { steps: [] };
  }

  compileMembers(): readonly ExecutableOperation[] {
    return this.rows.map(
      (row) =>
        new CreateOperation(
          this.engine,
          this.model,
          {},
          { parsedRoot: { data: row, select: this.rowKeySelect } }
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
          this.scope.allocate(`${name}.createManySeries.read`),
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
    if (!this.select) return { count: input.memberResults.length };
    // The reads ran in input order and answered one row each, so concatenating them
    // IS the input-ordered row set. It is shaped by the SAME parser the returning
    // bulk arm uses, with the same validated payload, so the public projection,
    // omission and scalar casts are that arm's — not a second opinion.
    const rows = input.resultReadResults.flatMap(asRows);
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver,
      this.engine.decimalDecode
    ).parse("createManyAndReturn", rows, this.args);
  }
}

/**
 * One ordinary read of one final root row, by its complete row key.
 *
 * It is spelled here rather than through `ReadOperation` for the reason every
 * already-validated route in this engine exists: `ReadOperation` re-validates
 * through the `findUnique` args schema, which would re-parse the caller's already
 * parsed `select` (the non-idempotence X2 records). It is the same shape
 * `ManyAndReturnOperation` builds for its non-returning refetch — one `buildFindUnique`
 * step, no planning — so the two arms of a returning `createMany` read the created
 * rows through one builder.
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
      // THE ORDINAL CONTRACT of this arm, and the ONE thing that can break it.
      //
      // The public rows are these reads concatenated, so a read answering zero rows
      // would shorten the answer: N inputs, N members, N-1 rows back, no complaint —
      // while the `{ count }` arm of the same payload answers N. The returning bulk
      // owner raises for its own version of this (`ManyAndReturnOperation`'s input
      // ordinal check); the series' version is a postcondition because the failure is
      // a runtime fact about a row, not a mis-built plan.
      //
      // The cause is REACHABLE, not defensive: a member's row key stops addressing its
      // row when a LATER member moves it — legal whenever a primary-key column is also
      // a foreign key, e.g. row 1's nested `connect` adopting row 0's root rewrites the
      // very column row 0's key is made of. Nothing else in a create tree can do it (no
      // delete verb, `skipDuplicates` refused on this route, and a primary key cannot
      // answer twice), so the message names that cause — but it names it as the
      // explanation of an OBSERVATION rather than as a claim about a row this code
      // never saw, because one other channel could in principle miss too: a member's
      // key comes back through the result parser, and a lossy scalar decode would put
      // a value in this `where` that no longer matches (`decimalDecode: "number"` on a
      // decimal key is the only known candidate, and no other bulk arm round-trips a
      // key through a decode at all).
      //
      // Either way the engine cannot re-address a row whose address it no longer has —
      // the member's own read already happened — so it refuses instead of returning a
      // plausible short list. Everything rolls back; `raceable: false`, because a retry
      // would deterministically do the same thing.
      expects: exactlyOneRow({
        kind: "query",
        message:
          "createMany with 'select' could not read back one of the created rows at the primary key it reported. A later row in the same call moved that row's primary key; use the '{ count }' form, or write those rows in separate calls.",
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
 * A member's answer is its row key — the projection it was handed was exactly that,
 * and its terminal read asserts exactly one row. The narrowing is here because the
 * executor hands member results back as `unknown`; a value that is not a row means
 * the engine wired a member to the wrong projection, so it is an engine fault
 * (`QueryEngineError`), never a user-facing route.
 */
function asRowKey(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    "query-engine-v2 createMany with relation data lost a row's final row key."
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
    "query-engine-v2 createMany with relation data lost a row's final read."
  );
}
