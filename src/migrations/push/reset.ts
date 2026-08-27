import type { AnyDriver } from "../../drivers/driver";
import type { BoundMigrationDriver } from "../drivers";
import {
  executeLiveNamespaceReset,
  type LiveNamespaceResetPlan,
  planLiveNamespaceReset,
} from "../live-reset";

/**
 * Decides the live-namespace clear for `push({ forceReset: true })`.
 *
 * It touches NO migration storage. The previous storage arm wrote a journal
 * hardcoded to format version "1" — a version this build refuses to read — so a
 * successful force-reset left the estate permanently unreadable. Push
 * synchronizes live state; rewriting an estate's history is not a push effect.
 *
 * The declared tracking table is an ORDINARY managed object here: force-reset
 * clears its rows and then removes it through the same dependency-safe program
 * as everything else, and the versioned artifact estate stays byte-identical. A
 * later `status()` therefore reports the unchanged journal entries as pending,
 * which is the truth. Users who want a history-aware destructive rebuild use
 * `migrations.reset()`.
 *
 * Force-reset's clear is TWO steps for the same reason every other caller's is:
 * the plan is decided from catalog reads and can refuse — a cross-database
 * foreign key, an inbound tracking reference — while the execution is nothing
 * but effects. Only the second belongs inside the commit-model reporter.
 *
 * @param trackingTableName - the normalized name this command DECLARES, never
 *   one guessed from the inventory. A sibling custom-named table the invoking
 *   command did not declare is an ordinary table and receives no
 *   tracking-history claim.
 */
export function planResetDatabase(
  driver: AnyDriver,
  migrationDriver: BoundMigrationDriver,
  trackingTableName: string
): Promise<LiveNamespaceResetPlan> {
  return planLiveNamespaceReset(driver, migrationDriver, {
    trackingTable: "drop",
    trackingTableName,
  });
}

/** Executes a planned force-reset clear on the producer the caller chose. */
export async function resetDatabase(
  driver: AnyDriver,
  plan: LiveNamespaceResetPlan
): Promise<void> {
  await executeLiveNamespaceReset(driver, plan);
}
