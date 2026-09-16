/**
 * The seam the C13 lifecycle falsifiers need from the G4-03 private route, and
 * the lifecycle oracle they run through it.
 *
 * The oracle itself is written here so it can be run twice: once against the
 * SHIPPED client — which proves the oracle observes a complete lifecycle and,
 * with a deliberately broken recorder, that it can actually fail — and once
 * against the candidate route, which is the C13 claim.
 *
 * `createRoutedClient` is the single place that names the G4-03 seam; nothing
 * else in the falsifiers depends on its spelling.
 */
import type { AnyDriver } from "@drivers";
import { createCandidateClient } from "@query-engine/raptor3/route/client-route";
import type { Schema } from "@schema/hydration";

/**
 * Requested of the G4-03 author (see
 * `docs/architecture/raptor3-evidence/g4/witness/note.md` §"Requests to other
 * streams"): one private factory that builds an ordinary client whose model
 * operations are executed by the candidate, through the existing
 * `PendingOperation`, extension, cache, raw and transaction owners.
 */
export const RAPTOR3_ROUTE_SEAM =
  "createCandidateClient({ schema, driver }) exported from src/query-engine/raptor3/route/client-route.ts";

export interface RoutedClientConfig {
  readonly schema: Schema;
  readonly driver: AnyDriver;
}

export type RoutedClient = Record<string, unknown> & {
  $disconnect(): Promise<unknown>;
};

/** Binds the G4-03 seam. The falsifiers never construct a client any other way. */
export function createRoutedClient(config: RoutedClientConfig): RoutedClient {
  return createCandidateClient(
    config as unknown as Parameters<typeof createCandidateClient>[0]
  ) as unknown as RoutedClient;
}

export interface ObservedUnit {
  readonly kind: string;
  readonly operation: string;
  readonly status: string;
}

export interface LifecycleRecorder {
  readonly units: ObservedUnit[];
  /** A recorder that deliberately drops one unit kind, to falsify the oracle. */
  readonly extension: {
    readonly name: string;
    observe(unit: unknown, proceed: () => Promise<unknown>): void;
  };
  settle(): Promise<void>;
}

/**
 * Records every protected lifecycle unit an operation publishes. `drop` names a
 * unit kind the recorder deliberately loses, which is how the falsifier proves
 * it would notice a missing event.
 */
export function lifecycleRecorder(drop?: string): LifecycleRecorder {
  const units: ObservedUnit[] = [];
  const pending: Promise<unknown>[] = [];
  return {
    units,
    extension: {
      name: "g4-lifecycle-recorder",
      observe(unit: unknown, proceed: () => Promise<unknown>) {
        const described = unit as { kind?: unknown; operation?: unknown };
        const kind = String(described.kind ?? "unknown");
        const operation = String(described.operation ?? "unknown");
        pending.push(
          proceed().then((completion) => {
            if (kind === drop) return;
            const status = (completion as { status?: unknown } | undefined)
              ?.status;
            units.push({ kind, operation, status: String(status ?? "unknown") });
          })
        );
      },
    },
    async settle() {
      await Promise.all(pending.splice(0));
    },
  };
}

/** The lifecycle facts one ordinary model read must publish. */
export const REQUIRED_READ_UNITS = ["operation", "statement"] as const;

export function missingUnits(
  observed: readonly ObservedUnit[],
  required: readonly string[] = REQUIRED_READ_UNITS
): string[] {
  const kinds = new Set(observed.map((unit) => unit.kind));
  return required.filter((kind) => !kinds.has(kind));
}
