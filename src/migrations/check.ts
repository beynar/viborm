/**
 * Offline estate check. CI-safe. Never creates control tables.
 */

import { loadMigrationGraph } from "./graph";
import type { Sha256 } from "./identity";
import type { MigrationStorageReader } from "./storage/contract";
import {
  encodeSqlBlob,
  parseSnapshotDocument,
  parseStateManifest,
} from "./v1-parse";

export interface CheckFinding {
  readonly code: string;
  readonly message: string;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly findings: readonly CheckFinding[];
}

export async function checkEstate(
  storage: MigrationStorageReader
): Promise<CheckResult> {
  const findings: CheckFinding[] = [];
  try {
    const graph = await loadMigrationGraph(storage);
    if (graph.leaves.length > 1) {
      findings.push({
        code: "unresolved-branch",
        message: `Estate has ${graph.leaves.length} leaves; apply requires an explicit target or via`,
      });
    }
    const referencedSnapshots = new Set<Sha256>([graph.emptySnapshotHash]);
    const referencedSql = new Set<Sha256>();
    for (const state of graph.states.values()) {
      referencedSnapshots.add(state.snapshotHash);
      referencedSql.add(state.sqlHash);
    }
    for (const hash of await storage.listSnapshots()) {
      if (!referencedSnapshots.has(hash)) {
        findings.push({
          code: "orphan-snapshot",
          message: `Snapshot ${hash} is not referenced by any state`,
        });
      }
      const bytes = await storage.readSnapshot(hash);
      if (bytes) parseSnapshotDocument(bytes, hash);
    }
    for (const hash of await storage.listSql()) {
      if (!referencedSql.has(hash)) {
        findings.push({
          code: "orphan-sql",
          message: `SQL blob ${hash} is not referenced by any state`,
        });
      }
      const bytes = await storage.readSql(hash);
      if (bytes && encodeSqlBlob(bytes) !== hash) {
        findings.push({
          code: "corrupt-sql",
          message: `SQL blob ${hash} does not match its bytes`,
        });
      }
    }
    for (const id of await storage.listStates()) {
      const bytes = await storage.readState(id);
      if (bytes) parseStateManifest(bytes, id);
    }
  } catch (error) {
    findings.push({
      code: "invalid-estate",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    ok: findings.every((finding) => finding.code.startsWith("orphan-")),
    findings,
  };
}
