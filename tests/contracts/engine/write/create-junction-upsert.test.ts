import {
  createJunctionUpsertSchema,
  registerCreateJunctionUpsertBehavior,
} from "@tests/contracts/engine/write/create-junction-upsert-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

const getTransactionFamily = usePGliteSchemaFamily(createJunctionUpsertSchema);
const getAtomicBatchFamily = usePGliteSchemaFamily(
  createJunctionUpsertSchema,
  "atomicBatch"
);

registerCreateJunctionUpsertBehavior(
  "transaction",
  async () => getTransactionFamily().client
);
registerCreateJunctionUpsertBehavior(
  "atomic batch",
  async () => getAtomicBatchFamily().client
);
