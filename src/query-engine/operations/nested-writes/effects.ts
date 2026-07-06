import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import type { NestedWriteError, NotFoundError } from "../../types";
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
      readonly set: Readonly<Record<string, Expr | { readonly op: Sql }>>;
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
