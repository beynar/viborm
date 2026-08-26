// biome-ignore-all lint/style/useFilenamingConvention: CreateManyRecordSeries is the architecture name (plan §4.6).
import { QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import type { RecordMutationData } from "../builders/relation-mutation-parser";
import { getPrimaryKeyFields } from "../context";
import type { QueryEngine } from "../query-engine";
import { CreateOperation } from "./CreateOperation";
import type { ExecutableOperation } from "./OperationExecutor";
import type { PlanningFragment } from "./OperationFragment";
import { parseValidated } from "./parse-boundary";
import {
  isSkippableCreateMemberResult,
  type RecordSeriesOperation,
} from "./record-series";
import { StepScope } from "./StepScope";
import {
  buildSeriesResultReads,
  parseSeriesResultReads,
  type SeriesResultReadInput,
} from "./series-result-read";
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
 * THE RESULT. `count` is the number of inserted ROOT rows; a skipped root contributes
 * neither a key nor nested effects. A returning projection is read AFTER every member
 * finishes, so a later row's relation effects cannot leave an earlier row's returned
 * projection stale. The shared series result owner coalesces final root keys within
 * the provider's bind budget, restores input order without trusting database row
 * order, and refuses if any reported key is gone.
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

  /** The canonical payload validated at construction. */
  get validatedArgs(): Record<string, unknown> {
    return this.args;
  }

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  /** The validated payload, as the `createMany` args schema left it (`omit`
   *  already desugared into `select`), reused verbatim for the public result. */
  private readonly args: Record<string, unknown>;
  private readonly rows: readonly RecordMutationData[];
  private readonly skipDuplicates: boolean;
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
    const sourceRows = Array.isArray(args.data) ? args.data : [];
    this.rows = parsed.data.map((row, index) => ({
      parsed: row,
      source: isRecord(sourceRows[index]) ? sourceRows[index] : undefined,
    }));
    this.skipDuplicates = parsed.skipDuplicates === true;
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
    return this.rows.map((row) => {
      const operation = new CreateOperation(
        this.engine,
        this.model,
        {},
        {
          parsedRoot: {
            data: row,
            select: this.rowKeySelect,
            skipDuplicates: this.skipDuplicates,
          },
        }
      );
      return operation;
    });
  }

  compileResultReads(
    _captured: Readonly<Record<string, unknown>>,
    memberResults: readonly unknown[]
  ): readonly ExecutableOperation[] {
    const select = this.select;
    if (!select) return [];
    return buildSeriesResultReads(
      this.resultReadInput(
        insertedRowKeys(memberResults, this.skipDuplicates),
        select
      )
    );
  }

  parseSeries(input: {
    readonly captured: Readonly<Record<string, unknown>>;
    readonly memberResults: readonly unknown[];
    readonly resultReadResults: readonly unknown[];
  }): unknown {
    const rowKeys = insertedRowKeys(input.memberResults, this.skipDuplicates);
    if (!this.select) return { count: rowKeys.length };
    return parseSeriesResultReads(
      this.resultReadInput(rowKeys, this.select),
      input.resultReadResults
    );
  }

  private resultReadInput(
    expectedRowKeys: readonly Readonly<Record<string, unknown>>[],
    select: Readonly<Record<string, unknown>>
  ): SeriesResultReadInput {
    return {
      engine: this.engine,
      model: this.model,
      args: this.args,
      select,
      expectedRowKeys,
      operation: "createManyAndReturn",
      scope: this.scope,
      stepLabel: `${getStepModelName(this.model, "record")}.createManySeries.read`,
      missingRowMessage:
        "createMany with 'select' could not read back one of the created rows at the primary key it reported. A later row in the same call moved that row's primary key; use the '{ count }' form, or write those rows in separate calls.",
    };
  }
}

function insertedRowKeys(
  values: readonly unknown[],
  decodeSkipOutcomes: boolean
): Record<string, unknown>[] {
  if (!decodeSkipOutcomes) return values.map(asRowKey);
  const rows: Record<string, unknown>[] = [];
  for (const value of values) {
    if (!isSkippableCreateMemberResult(value)) {
      throw new QueryEngineError(
        "query-engine-v2 createMany with skipDuplicates lost a member's exact inserted/skipped outcome."
      );
    }
    if (value.kind === "inserted") rows.push(asRowKey(value.value));
  }
  return rows;
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
