/**
 * Dry-run → apply resolution replay for `viborm push`.
 *
 * The push command plans twice: a dry-run pass that prompts the user for every
 * destructive/ambiguous/enum decision, then a second planning pass that
 * actually applies. `createRecordingResolver` wraps the interactive resolver
 * for the dry run and captures each decision keyed by the change's structural
 * identity; `replay` then honors those exact decisions during the apply pass
 * without ever re-prompting.
 *
 * Fail-closed contract: a change the dry run never resolved (e.g. concurrent
 * schema drift between the two planning passes) replays as `undefined`, so the
 * planner (invoked with `force: false`) aborts with a MigrationError instead
 * of silently degrading the change to add+drop.
 */

import type {
  ResolveCallback,
  ResolveChange,
  ResolveResult,
} from "../migrations/types";
import { readEnumResolutionDecision } from "../migrations/types";

type ResolveOutcome = Awaited<ReturnType<ResolveCallback>>;

type RecordedDecision =
  | { kind: "proceed" }
  | { kind: "reject" }
  | { kind: "rename" }
  | { kind: "addAndDrop" }
  | { kind: "useNull" }
  | { kind: "mapValues"; mappings: Record<string, string | null> };

export interface RecordingResolver {
  /** Wraps the inner callback and records every decision it returns. */
  resolve: ResolveCallback;
  /** Replays the recorded decisions without invoking the inner callback. */
  replay: ResolveCallback;
}

/**
 * Structural identity of a change: stable across independent planning passes
 * over the same schema/database, regardless of plan ordering. Never based on
 * object identity or human-readable descriptions.
 */
function changeIdentity(change: ResolveChange): string {
  if (change.type === "enumValueRemoval") {
    return JSON.stringify([
      "enumValueRemoval",
      change.enumName,
      change.tableName,
      change.columnName,
      [...change.removedValues].sort(),
    ]);
  }
  if (change.type === "ambiguous") {
    return JSON.stringify([
      "ambiguous",
      change.operation,
      change.table,
      change.oldName ?? null,
      change.newName ?? null,
    ]);
  }
  return JSON.stringify([
    "destructive",
    change.operation,
    change.table,
    change.column ?? null,
  ]);
}

function toRecordedDecision(
  change: ResolveChange,
  result: ResolveOutcome
): RecordedDecision | undefined {
  switch (result) {
    case "proceed":
      return { kind: "proceed" };
    case "reject":
      return { kind: "reject" };
    case "rename":
      return { kind: "rename" };
    case "addAndDrop":
      return { kind: "addAndDrop" };
    case "enumMapped": {
      const decision = readEnumResolutionDecision(change);
      if (decision?.kind === "mapValues") {
        return { kind: "mapValues", mappings: { ...decision.mappings } };
      }
      if (decision?.kind === "useNull") {
        return { kind: "useNull" };
      }
      return;
    }
    default:
      // Unhandled (undefined/void): nothing to record — replay stays
      // fail-closed for this change.
      return;
  }
}

/**
 * Re-applies a recorded decision to a structurally identical change from a
 * later planning pass. Calls the change's own resolution methods so internal
 * state (enum mappings) is set on the new object exactly as the original
 * interactive answer set it on the old one. A kind that is invalid for the
 * change's type resolves to `undefined` (fail closed upstream).
 */
function replayDecision(
  change: ResolveChange,
  decision: RecordedDecision
): ResolveResult | undefined {
  switch (decision.kind) {
    case "proceed":
      return change.type === "destructive" ? change.proceed() : undefined;
    case "reject":
      return change.reject();
    case "rename":
      return change.type === "ambiguous" ? change.rename() : undefined;
    case "addAndDrop":
      return change.type === "ambiguous" ? change.addAndDrop() : undefined;
    case "useNull":
      return change.type === "enumValueRemoval" ? change.useNull() : undefined;
    case "mapValues":
      return change.type === "enumValueRemoval"
        ? change.mapValues({ ...decision.mappings })
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Creates a `{ resolve, replay }` pair around an interactive resolve callback.
 * Pass `resolve` to the dry-run push and `replay` to the apply push so the
 * user's answers are honored exactly once, without a second round of prompts.
 */
export function createRecordingResolver(
  inner: ResolveCallback
): RecordingResolver {
  const decisions = new Map<string, RecordedDecision>();

  const resolve: ResolveCallback = async (change) => {
    const identity = changeIdentity(change);
    const result = await inner(change);
    const decision = toRecordedDecision(change, result);
    if (decision) {
      decisions.set(identity, decision);
    }
    return result;
  };

  const replay: ResolveCallback = (change) => {
    const decision = decisions.get(changeIdentity(change));
    if (!decision) {
      // Never seen during the dry run: leave unresolved so the planner
      // aborts instead of guessing.
      return;
    }
    return replayDecision(change, decision);
  };

  return { resolve, replay };
}
