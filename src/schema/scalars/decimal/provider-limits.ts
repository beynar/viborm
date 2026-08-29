/**
 * The ONE schema-plus-provider fixed-decimal admission decision.
 *
 * A decimal descriptor is a valid schema fact independently of provider
 * limits. The first boundary that combines a complete model map with a chosen
 * provider asks this pure owner whether every declared scalar or list fits.
 * It returns one structured refusal and performs no boundary-specific throw;
 * client and migration composition roots retain their own error classes.
 */

import type { AnyModel } from "@schema/model";
import type { Scalar } from "@schema/scalars/base";
import {
  type DecimalDescriptor,
  type DecimalDialect,
  describeProviderLimitRefusal,
} from "@validation/primitives/decimal-codec";

type ProviderDialect = "postgresql" | "mysql" | "sqlite";

export interface DecimalProviderLimitRefusal {
  readonly modelName: string;
  readonly fieldName: string;
  readonly dialect: ProviderDialect;
  readonly descriptor: DecimalDescriptor;
  readonly reason: string;
}

/** The driver's dialect in the decimal codec's physical vocabulary. */
function decimalDialectOf(dialect: ProviderDialect): DecimalDialect {
  if (dialect === "postgresql") return "pg";
  if (dialect === "mysql") return "mysql";
  return "sqlite";
}

/** Return the first declared decimal domain the selected provider cannot hold. */
export function findDecimalProviderLimitRefusal(
  schema: Record<string, AnyModel>,
  dialect: ProviderDialect
): DecimalProviderLimitRefusal | undefined {
  const decimalDialect = decimalDialectOf(dialect);
  for (const [modelName, model] of Object.entries(schema)) {
    const scalars: Record<string, Scalar> = model["~"].state.scalars;
    for (const [fieldName, scalar] of Object.entries(scalars)) {
      const state = scalar["~"].state;
      if (state.type !== "decimal" || state.decimal === undefined) continue;
      const reason = describeProviderLimitRefusal(
        decimalDialect,
        state.decimal
      );
      if (reason === undefined) continue;
      return {
        modelName,
        fieldName,
        dialect,
        descriptor: state.decimal,
        reason,
      };
    }
  }
  return undefined;
}

/** The shared diagnostic body; each composition root chooses its error model. */
export function describeDecimalProviderLimitRefusal(
  refusal: DecimalProviderLimitRefusal
): string {
  return `Decimal field '${refusal.modelName}.${refusal.fieldName}' cannot be stored by the '${refusal.dialect}' driver: ${refusal.reason}.`;
}
