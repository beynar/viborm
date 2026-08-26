/** Fixture selection and single composition owner for workload families. */

import { WORKLOADS } from "./operation-pipeline-catalog.mjs";
import { createProviderWorkloadHarness } from "./operation-pipeline-provider-workloads.mjs";

export async function createWorkloadHarness(
  workloadName,
  stage,
  operationCount,
  providerName = "sqlite3",
  targetDirectory = process.cwd(),
  extensionArm = "unextended"
) {
  const workload = WORKLOADS[workloadName];
  if (!workload) throw new Error(`Unknown benchmark workload: ${workloadName}`);
  if (!workload.providers.includes(providerName)) {
    throw new Error(`${workloadName} is not defined for ${providerName}`);
  }
  if (extensionArm !== "unextended" && !workload.extensionProof) {
    throw new Error(
      `${workloadName} is not an extension-overhead proof workload`
    );
  }
  if (workload.fixture === "provider-read") {
    return createProviderWorkloadHarness(
      workloadName,
      providerName,
      targetDirectory,
      workload.providerShape,
      stage
    );
  }
  const [
    { buildBatchWorkload },
    { createBenchmarkFixture },
    { buildMutationWorkload },
    { buildReadWorkload },
  ] = await Promise.all([
    import("./operation-pipeline-batch-workloads.mjs"),
    import("./operation-pipeline-fixtures.mjs"),
    import("./operation-pipeline-mutation-workloads.mjs"),
    import("./operation-pipeline-read-workloads.mjs"),
  ]);
  const fixture = await createBenchmarkFixture(
    workload.fixture,
    workload.substrate,
    extensionArm
  );
  const semanticFixture = await createBenchmarkFixture(
    workload.fixture,
    workload.substrate,
    extensionArm
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
