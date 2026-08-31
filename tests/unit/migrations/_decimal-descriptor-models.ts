import { s } from "@schema";

export const DECIMAL_TRANSITION_TABLE = "dec_tx";

export function decimalLedger(precision: number, scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amount: s.decimal({ precision, scale }).nullable(),
      })
      .map(DECIMAL_TRANSITION_TABLE),
  };
}
export function decimalListLedger(precision: number, scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        samples: s.decimal({ precision, scale }).array(),
      })
      .map(DECIMAL_TRANSITION_TABLE),
  };
}
