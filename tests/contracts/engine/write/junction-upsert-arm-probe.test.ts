import {
  junctionUpsertArmSchema,
  registerJunctionUpsertArmProbeBehavior,
} from "@tests/contracts/engine/write/junction-upsert-arm-probe-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

const substrates = [
  {
    name: "transaction",
    getFamily: usePGliteSchemaFamily(junctionUpsertArmSchema, "transaction"),
  },
  {
    name: "atomic batch",
    getFamily: usePGliteSchemaFamily(junctionUpsertArmSchema, "atomicBatch"),
  },
] as const;

for (const substrate of substrates) {
  registerJunctionUpsertArmProbeBehavior(
    substrate.name,
    async () => substrate.getFamily().client
  );
}
