// biome-ignore-all lint/style/useFilenamingConvention: OwnWritePreflight is the architecture name.
import {
  assertCreateOwnWriteSafety,
  assertUpdateOwnWriteSafety,
} from "../OwnWriteAnalyzer";
import type { QueryScope } from "../types";

/**
 * The own-write independence preflight (ATOM §4) — the soundness precondition
 * of planning-before-writes, and the atom's edge: **a shape whose decision
 * cannot be widened to an unconditional planning read is rejected, not
 * linearized.** Before an operation plans, it walks the payload recording each
 * write's target/predicate/membership footprint; any decision read overlapping
 * a prior same-operation write is rejected with V1's typed "split these
 * operations into separate queries" error, identically on both substrates.
 *
 * This is a **named scope component**, not a fork: it reuses V1's
 * `OwnWriteLedger` classification verbatim through the importable
 * `assertCreateOwnWriteSafety` / `assertUpdateOwnWriteSafety` entry points
 * (WHY §4.2 / ATOM §8). Reimplementing the ~1.2k lines of legality semantics
 * per-part would fork the theorem the whole architecture rests on; the plan
 * forbids it. The "register footprints during the fold" shape is exactly what
 * these functions do internally as they descend the payload tree.
 */
export class OwnWritePreflight {
  /** Reject any create payload whose nested decision reads depend on its own writes. */
  assertCreate(scope: QueryScope, data: Record<string, unknown>): void {
    assertCreateOwnWriteSafety(scope, data);
  }

  /** Reject any update payload whose nested decision reads depend on its own writes. */
  assertUpdate(
    scope: QueryScope,
    data: Record<string, unknown>,
    selector: Record<string, unknown> | undefined
  ): void {
    assertUpdateOwnWriteSafety(scope, data, selector);
  }
}
