import {
  destinationCastSchema,
  registerDestinationCastBehavior,
} from "@tests/contracts/engine/write/destination-cast-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

const getTransactionFamily = usePGliteSchemaFamily(destinationCastSchema);
const getAtomicBatchFamily = usePGliteSchemaFamily(
  destinationCastSchema,
  "atomicBatch"
);

registerDestinationCastBehavior(
  "transaction",
  async () => getTransactionFamily().client
);
registerDestinationCastBehavior(
  "atomic batch",
  async () => getAtomicBatchFamily().client
);
