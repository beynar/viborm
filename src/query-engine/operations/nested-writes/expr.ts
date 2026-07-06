import type { Model } from "@schema/model";
import type { Sql } from "@sql";

/** A value that flows through a nested write. Closed; does not grow.
 *  IR-creep guard: adding a case requires a producer in the interpreter. */
export type Expr =
  | { readonly kind: "lit"; readonly value: unknown } // known now (null included)
  | { readonly kind: "sql"; readonly sql: Sql } // pre-built fragment (connect subquery)
  | { readonly kind: "sym"; readonly sym: WriteSymbol }; // produced during execution

/** A record identity that is partly known, partly deferred —
 *  the unified successor of BatchRecordRef.primaryKey. */
export type IdentityExprs = Readonly<Record<string, Expr>>;

/** A promised value. Identity + provenance; never holds the value itself. */
export interface WriteSymbol {
  readonly id: string; // "sym_N", monotonic per operation
  readonly model: Model<any>;
  readonly field: string; // the column this symbol stands for
  readonly origin: SymbolOrigin;
}

/** How the symbol's value becomes known. This IS the capability contract,
 *  per symbol (§6.3). Exactly the three sources the code has today. */
export type SymbolOrigin =
  /** Single auto-increment produced by the insert that lists this symbol in
   *  `produces`. Live: RETURNING/lastInsertId. Planned: storeLastInsertId
   *  immediately after the insert. Planned-legal. */
  | { readonly kind: "generatedPk" }
  /** Adapter arithmetic over a known before-value (PK increment family).
   *  Live: computed/read back. Planned: batchRefs.store(valueSql).
   *  Planned-legal. */
  | { readonly kind: "computedPk"; readonly valueSql: Sql }
  /** Any other generated identity (compound generated PK, DB-default
   *  non-increment PK). Live-only; the legality gate (§6.3) rejects it for
   *  planned mode with the existing typed message. Lift path: §1.2 A8. */
  | { readonly kind: "opaqueGenerated"; readonly reason: string };
