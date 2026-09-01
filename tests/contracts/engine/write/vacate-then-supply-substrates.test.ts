import {
  registerVacateThenSupplyBehavior,
  vacateThenSupplySchema,
} from "@tests/contracts/engine/write/vacate-then-supply-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

/**
 * E6.5's live per-substrate bed. `registerVacateThenSupplyBehavior` mounts the same
 * sixteen witnesses on the transaction driver and on the forced atomic-batch driver,
 * and each substrate answers from ONE shared schema family: two private schemas on the
 * worker's database for the whole registration. That is why the bed is its own file —
 * the pair enumeration and the parent-held slices beside it open a FRESH database per
 * test and have nothing to share with these two.
 */
const substrates = [
  {
    name: "transaction",
    getFamily: usePGliteSchemaFamily(vacateThenSupplySchema, "transaction"),
  },
  {
    name: "atomic batch",
    getFamily: usePGliteSchemaFamily(vacateThenSupplySchema, "atomicBatch"),
  },
] as const;

for (const substrate of substrates) {
  registerVacateThenSupplyBehavior(
    substrate.name,
    async () => substrate.getFamily().client
  );
}
