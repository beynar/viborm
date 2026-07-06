import {
  type Operation,
  type QueryContext,
  QueryEngineError,
} from "../../types";
import { interpretCreate } from "./interpret-create-family";
import { interpretTopLevelUpdate } from "./interpret-update-family";
import { interpretTopLevelUpsert } from "./interpret-upsert-family";
import { LiveMode } from "./live-mode";
import type { Emit, Mode, NestedWriteResult } from "./mode";
import { PlannedMode } from "./planned-mode";

// The capability fork `selectMode` (§8.1) lives in `mode.ts` — the single place
// a driver's atomic-strategy capabilities are read (grep gate 1). It is
// re-exported here so callers keep importing it from the interpreter entry.
export { selectMode } from "./mode";

// The interpreter is ONE semantic body split across the interpret-*.ts family
// modules purely for navigability (§11 M10 gate 4 follow-up): this entry owns
// dispatch and the per-operation `Interp` bundle; the mutation-family seams are
// interpret-create-family.ts, interpret-update-family.ts,
// interpret-upsert-family.ts, interpret-m2m.ts, with the cross-family leaves in
// interpret-shared.ts. The families recurse into each other (a create tree can
// hold m2m steps, an upsert branch replays the update body) — file boundaries
// carry no semantic meaning, and none of them consults a mode implementation
// (grep-gated).

/**
 * The interpreter entry (§2, §8.6). Owns every semantic decision once and
 * consults a `Mode` for substrate mechanics.
 *
 * Every create/update/upsert nested-write tree — every mutation kind, over FK
 * and m2m relations alike — runs here in both modes (§11 M9). The migration
 * routing seam and the frozen legacy engines are gone (§11 M10).
 */
export function runInterpreter<T>(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>,
  mode: Mode
): Promise<T> {
  if (
    operation !== "create" &&
    operation !== "update" &&
    operation !== "upsert"
  ) {
    // Create (M3), update (M5) and upsert (M6) families are migrated; the
    // routing predicate guarantees no other top-level operation reaches here
    // (m2m lands at M9).
    throw new QueryEngineError(
      `The nested-write interpreter does not handle operation '${operation}' yet.`
    );
  }

  bindContext(mode, ctx);
  const refetch = Boolean(args.select || args.include);
  const selectInclude =
    args.select || args.include
      ? { select: args.select, include: args.include }
      : undefined;

  return mode.scope.run<T>(async (emit) => {
    const interp = createInterp(mode, emit);
    if (operation === "create") {
      const outcome = await interpretCreate(
        interp,
        ctx,
        args.data as Record<string, unknown>,
        undefined,
        /* isRoot */ true
      );
      return {
        finalWhere: outcome.finalWhere,
        refetch,
        selectInclude,
        record: outcome.record,
      } satisfies NestedWriteResult;
    }
    if (operation === "upsert") {
      const outcome = await interpretTopLevelUpsert(interp, ctx, args);
      // An upsert always refetches by the final identity — every branch
      // (create / update / targetWhere-skip / setWhere-skip) resolves to a
      // findUnique by the resolved PK, returning scalars when no select/include
      // is present (Prisma parity; refetch-by-PK with no projection yields
      // exactly the scalar set a held record would).
      return {
        finalWhere: outcome.finalWhere,
        refetch: true,
        selectInclude,
        record: undefined,
      } satisfies NestedWriteResult;
    }
    const outcome = await interpretTopLevelUpdate(interp, ctx, args);
    // An update always refetches by the (possibly PK-changed) final identity —
    // the tx engine re-SELECTs the row, the batch engine appends a findUnique,
    // and both return scalars when no select/include is present (Prisma parity).
    return {
      finalWhere: outcome.finalWhere,
      refetch: true,
      selectInclude,
      record: undefined,
    } satisfies NestedWriteResult;
  });
}

/** Bind the top-level query context to the mode so its effect execution and
 *  result assembly reuse the query-engine machinery. Both modes expose
 *  `bindContext`; the union keeps `Mode` free of it (it is substrate setup). */
function bindContext(mode: Mode, ctx: QueryContext): void {
  if (mode instanceof LiveMode || mode instanceof PlannedMode) {
    mode.bindContext(ctx);
  }
}

/**
 * The per-operation interpreter bundle: the mode, its effect sink, and a
 * monotonic symbol minter. One instance threads the whole tree so `WriteSymbol`
 * ids are unique across sibling inserts of the same model (map-batch-refs §5:
 * the value-ref namespace is monotonic, never per-record).
 */
export interface Interp {
  readonly mode: Mode;
  readonly emit: Emit;
  readonly nextSymbolId: () => string;
}

function createInterp(mode: Mode, emit: Emit): Interp {
  let counter = 0;
  return {
    mode,
    emit,
    nextSymbolId: () => `sym_${counter++}`,
  };
}
