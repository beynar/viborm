import {
  type OperationFragment,
  type PlanningFragment,
  ref,
} from "@src/query-engine/write-engine/OperationFragment";

/**
 * The ONE test-side spelling of derived planning publication (Phase 9.1):
 * every declared statement output under `<step>.<name>`, byte-identical to the
 * executor's `derivePlanningKnown` addressing and to the deleted explicit
 * maps, so every pinned expectation predating the derivation is unchanged.
 * Final fragments keep their explicit outputs.
 */
export function publishedOutputs(
  fragment: PlanningFragment | OperationFragment
): Readonly<Record<string, unknown>> {
  if ("outputs" in fragment) {
    return fragment.outputs;
  }
  return Object.fromEntries(
    fragment.steps.flatMap((step) =>
      Object.keys(step.outputs).map((name) => [
        `${step.id}.${name}`,
        ref(step.id, name),
      ])
    )
  );
}
