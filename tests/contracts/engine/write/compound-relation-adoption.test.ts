import {
  compoundAdoptSchema,
  registerCompoundAdoptBehavior,
} from "@tests/contracts/engine/write/compound-relation-adoption-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

const getTransactionFamily = usePGliteSchemaFamily(compoundAdoptSchema);
const getAtomicBatchFamily = usePGliteSchemaFamily(
  compoundAdoptSchema,
  "atomicBatch"
);

registerCompoundAdoptBehavior(
  "transaction",
  async () => getTransactionFamily().client
);
registerCompoundAdoptBehavior(
  "atomic batch",
  async () => getAtomicBatchFamily().client
);
