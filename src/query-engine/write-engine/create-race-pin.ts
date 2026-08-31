import { getWhereUniqueEntries } from "../builders/where-unique-builder";
import type { QueryScope } from "../types";
import { selectorRacePin } from "./fragment-builders";
import type { TargetConstraintPin } from "./OperationFragment";

export interface CreateRacePin {
  readonly pin: TargetConstraintPin;
  readonly values: readonly {
    readonly fieldName: string;
    readonly value: unknown;
  }[];
}

/** One owner for the values a missing probe and its prospective INSERT share. */
export function createRacePin(
  scope: QueryScope,
  where: Record<string, unknown>
): CreateRacePin | undefined {
  const values = getWhereUniqueEntries(scope, where);
  // `getWhereUniqueEntries` either returns a non-empty discriminator or throws;
  // the where-unique boundary owns that invariant.
  const pin = selectorRacePin(scope, where);
  return pin ? { pin, values } : undefined;
}

/** A retry pin is sound only when the emitted INSERT proposes the probed tuple. */
export function createDataSpellsRacePin(
  data: Readonly<Record<string, unknown>>,
  race: CreateRacePin
): boolean {
  return race.values.every(({ fieldName, value }) => {
    const created = data[fieldName];
    return isFoldableKeyValue(value) && Object.is(created, value);
  });
}

export function isFoldableKeyValue(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  );
}
