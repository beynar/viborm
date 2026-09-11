import type { ScenarioDefinition } from "../harness/protocol";
import { G0_PROFILES, type ProfileId } from "../profiles";
import { missingLookupScenario } from "./lookup-timing";
import { supplierFieldsScenario } from "./supplier-fields";
import { upsertMembershipScenario } from "./upsert-membership";

export const polishScenarios: (ScenarioDefinition & {
  readonly profiles: readonly ProfileId[];
})[] = [
  { ...missingLookupScenario, profiles: ["sqlite-atomic-batch"] },
  { ...upsertMembershipScenario, profiles: ["sqlite-atomic-batch"] },
  { ...supplierFieldsScenario, profiles: G0_PROFILES },
];
