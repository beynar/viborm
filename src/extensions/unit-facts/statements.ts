import { snapshotDiagnosticParameters } from "@drivers/driver-diagnostics";
import { sourceOf, type Unit } from "../unit-source";

/** One member of a native batch, as `statements(unit)` gives it. */
export interface BatchMember {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly model?: string;
  readonly operation?: string;
  readonly correlation?: string;
}

/**
 * The members of a `statement` unit that sends a native batch, in order;
 * `undefined` for a unit that sends one statement. A failure that names a
 * member carries its index (`meta.statementIndex`).
 */
export function statements(unit: Unit): readonly BatchMember[] | undefined {
  return sourceOf(unit)?.batch?.map(({ sql, params, context }) => ({
    sql,
    parameters: snapshotDiagnosticParameters(params ?? []),
    ...(context?.model === undefined ? {} : { model: context.model }),
    ...(context?.operation === undefined
      ? {}
      : { operation: context.operation }),
    ...(context?.correlationId === undefined
      ? {}
      : { correlation: context.correlationId }),
  }));
}
