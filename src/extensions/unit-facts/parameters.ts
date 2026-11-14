import { snapshotDiagnosticParameters } from "@drivers/driver-diagnostics";
import { sourceOf, type Unit } from "../unit-source";

/**
 * A bounded snapshot of the parameters a `statement` unit sends; for a
 * native batch, one list per member. Read it before `next()`: a provider
 * may change what it was handed. Each read takes its own snapshot.
 */
export function parameters(unit: Unit): readonly unknown[] | undefined {
  const source = sourceOf(unit);
  if (source?.batch !== undefined)
    return source.batch.map((member) =>
      snapshotDiagnosticParameters(member.params ?? [])
    );
  return source?.params === undefined
    ? undefined
    : snapshotDiagnosticParameters(source.params);
}
