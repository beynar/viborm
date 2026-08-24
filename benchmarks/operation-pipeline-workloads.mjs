/** Fixture selection and single composition owner for workload families. */

import { buildBatchWorkload } from "./operation-pipeline-batch-workloads.mjs";
import { WORKLOADS } from "./operation-pipeline-catalog.mjs";
import { createBenchmarkFixture } from "./operation-pipeline-fixtures.mjs";
import { buildMutationWorkload } from "./operation-pipeline-mutation-workloads.mjs";
import { buildReadWorkload } from "./operation-pipeline-read-workloads.mjs";

export async function createWorkloadHarness(
  workloadName,
  stage,
  operationCount
) {
  const workload = WORKLOADS[workloadName];
  if (!workload) throw new Error(`Unknown benchmark workload: ${workloadName}`);
  const fixture = await createBenchmarkFixture(
    workload.fixture,
    workload.substrate
  );
  const semanticFixture = await createBenchmarkFixture(
    workload.fixture,
    workload.substrate
  );
  const harness =
    (await buildReadWorkload(workloadName, fixture, semanticFixture)) ??
    (await buildMutationWorkload(
      workloadName,
      fixture,
      semanticFixture,
      stage,
      operationCount
    )) ??
    (await buildBatchWorkload(workloadName, fixture, semanticFixture));
  if (!harness) throw new Error(`No harness exists for ${workloadName}`);
  if (!harness.witness) {
    throw new Error(`Harness ${workloadName} exposes no SQL/parameter witness`);
  }
  if (!harness.semanticDigest) {
    throw new Error(`Harness ${workloadName} exposes no semantic digest`);
  }
  return { fixture, semanticFixture, harness };
}
