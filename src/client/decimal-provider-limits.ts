/**
 * The schema-bind half of plan 3.1: does the SELECTED provider have a physical
 * type for every fixed-decimal domain this schema declares?
 *
 * A descriptor is syntactically valid at model construction — `precision` an
 * integer, `scale` in `0..precision` — and that is deliberately not the same
 * question as whether a provider can store it. `s.decimal({ precision: 200,
 * scale: 4 })` is a valid model graph that PostgreSQL stores exactly; binding it
 * to MySQL or to SQLite is what fails, so the check lives where the schema meets
 * the driver rather than where the domain is written.
 *
 * This client translator runs once per construction, before any provider I/O.
 * The shared pure owner returns the first field it cannot place; this boundary
 * retains the client-specific error class and wording.
 *
 * Why the refusal is load-bearing rather than advisory, on SQLite in particular:
 * the descriptor's range CHECK is written as the integer literal `10^precision
 * - 1`, and past 18 digits SQLite's own parser reads that literal as a REAL, so
 * the constraint that makes the declared precision real stops being exact. The
 * arithmetic has its own `10^18` intermediate guard and would route an
 * out-of-bound field to a loud constraint failure at UPDATE time — this is what
 * moves that discovery to the line that constructed the client.
 */

import type { Dialect } from "@drivers/types";
import { ClientInitializationError } from "@errors";
import type { AnyModel } from "@schema/model";
import {
  describeDecimalProviderLimitRefusal,
  findDecimalProviderLimitRefusal,
} from "@schema/scalars/decimal/provider-limits";

export function assertDecimalDomainsFitProvider(
  schema: Record<string, AnyModel>,
  dialect: Dialect
): void {
  const refusal = findDecimalProviderLimitRefusal(schema, dialect);
  if (refusal === undefined) return;
  throw new ClientInitializationError(
    describeDecimalProviderLimitRefusal(refusal)
  );
}
