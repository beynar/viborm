// Fixture (b) — the exact-decimal value type only.
import { Decimal, s } from "../../dist/index.mjs";

export const money = s.decimal({ precision: 10, scale: 2 });
export const sum = new Decimal("1.5").plus(1).toString();
