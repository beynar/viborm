import { isVibORMError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { NestedWriteError, type NotFoundError } from "../../types";
import type { Expr, WriteSymbol } from "./expr";

/** The typed error a failed premise surfaces as — identical in both modes.
 *  A CLOSURE so bespoke messages (set-orphan field lists, FK-required,
 *  "deleted during upsert") reconstruct exactly (§1.2 A9).
 *  `raceable` feeds the write-race retry classification (§7.4); after the
 *  Pin Rule it is true ONLY for the filtered-M2M-deleteMany staleness pins. */
export interface GuardFailure {
  readonly error: () => NestedWriteError | NotFoundError;
  readonly raceable: boolean;
}

/** The meta key carrying the raceable bit on a surfaced error (§7.4). It lives
 *  in the query-engine layer's own typed error meta — NEVER parsed from a
 *  driver error string (§1.2 A1). `isWriteRaceLoserError` reads it to decide
 *  whether the write-race retry may re-run the whole operation. */
export const RACEABLE_META_KEY = "raceable";

/**
 * Turn a `GuardFailure` into the concrete typed error to surface, stamping the
 * `raceable` bit onto its `meta` when the premise is raceable (§7.4). This is
 * the single choke point both modes use — live mode throws the returned error,
 * planned mode's attribution ladder returns it — so the flag can never be set
 * in one mode and dropped in the other. The stamp is applied only to
 * `NestedWriteError` (the sole raceable premise class after the Pin Rule is the
 * filtered-M2M-deleteMany staleness pin, whose closure builds a
 * `NestedWriteError`); a non-raceable failure surfaces untouched.
 */
export function surfaceGuardFailure(
  failure: GuardFailure
): NestedWriteError | NotFoundError {
  const error = failure.error();
  if (failure.raceable && error instanceof NestedWriteError) {
    error.meta[RACEABLE_META_KEY] = true;
  }
  return error;
}

/** True iff a caught error was surfaced by a raceable `GuardFailure` (§7.4).
 *  The write-race retry consults this so the loser of a raceable staleness
 *  race (the filtered-M2M-deleteMany symmetric-difference pins) re-plans
 *  against fresh membership and converges. Never true for the step-4 typed
 *  fallback or any non-raceable premise. */
export function isRaceableGuardError(error: unknown): boolean {
  return isVibORMError(error) && error.meta[RACEABLE_META_KEY] === true;
}

/** A premise that must hold at the point this guard sits in the effect
 *  order. `where` is adapter-built Sql from the shared builders. */
export interface Guard {
  readonly premise:
    | {
        readonly kind: "exists";
        readonly model: Model<any>;
        readonly where: Sql;
      }
    | {
        readonly kind: "notExists";
        readonly model: Model<any>;
        readonly where: Sql;
      };
  readonly failure: GuardFailure;
}

/** Zero-affected-rows contract for a correlated write (§5.3).
 *  `false` = set-based/lax (deleteMany, disconnect:true, set-connect). */
export type RequireAffected = false | GuardFailure;

export type Effect =
  | {
      readonly kind: "insert";
      readonly model: Model<any>;
      readonly data: Readonly<Record<string, Expr>>;
      /** Symbols this insert produces (generated PK). The mode captures them
       *  atomically with the insert — the storeLastInsertId ordering law
       *  (map-batch-refs §5.2) is enforced by construction, not discipline. */
      readonly produces: readonly WriteSymbol[];
      readonly skipDuplicates?: boolean; // createMany / junction idempotency
    }
  | {
      readonly kind: "insertMany";
      readonly model: Model<any>;
      readonly rows: readonly Readonly<Record<string, Expr>>[];
      readonly skipDuplicates?: boolean;
    }
  | {
      readonly kind: "update";
      readonly model: Model<any>;
      /** Per-column Expr assignments (FK-null / FK-value / connect). Empty when
       *  the update is a scalar update carried by `rawSet`. */
      readonly set: Readonly<Record<string, Expr | { readonly op: Sql }>>;
      /** Raw scalar update data (operation envelopes) lowered by the shared
       *  `buildSet` builder — the single source of assignment semantics for
       *  increment/decrement/push/…/mapped columns. Mutually exclusive with a
       *  non-empty `set` (scalar updates and FK updates are never one effect). */
      readonly rawSet?: Readonly<Record<string, unknown>>;
      readonly where: Sql; // already correlated by the interpreter
      readonly requireAffected: RequireAffected;
      /** computedPk symbols this update produces (PK arithmetic). */
      readonly produces: readonly WriteSymbol[];
    }
  | {
      readonly kind: "delete";
      readonly model: Model<any>;
      readonly where: Sql;
      readonly requireAffected: RequireAffected;
    }
  | { readonly kind: "guard"; readonly guard: Guard };

/** A read that decides a branch and/or supplies an identity. */
export interface Probe {
  readonly model: Model<any>;
  readonly where: Sql;
  readonly select: "record" | "exists";
  readonly forUpdate?: boolean; // top-level upsert live probe
  /** If set: absence throws this typed error immediately, in both modes
   *  (unifies fetchRequired*). */
  readonly required?: GuardFailure;
  /** Pin specs per outcome, per the Pin Rule (§5.5). `whenMissing` is
   *  ABSENT for raceable create branches (constraint-enforced premise);
   *  `whenFound` is absent only for the enumerated pin-free probes (§6.2). */
  readonly pin?: {
    readonly whenFound?: Guard;
    readonly whenMissing?: Guard;
  };
}

export type ProbeResult =
  | {
      readonly found: true;
      readonly record: Readonly<Record<string, unknown>>;
      readonly guard: Guard | undefined;
    }
  | { readonly found: false; readonly guard: Guard | undefined };
// `guard` is the instantiated pin for the outcome that occurred (undefined
// when the Pin Rule assigns none). The interpreter destructures `guard` and
// emits it when present; an unused `guard` binding is a lint error
// (noUnusedLocals), keeping "probe without pin" visible in review.
