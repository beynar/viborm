/**
 * Test-only live schema sync. Production callers use push() with consent.
 * Additive empty-database setup does not need consent.
 */

import { push as applyPush, previewPush } from "@migrations";
import type { MigrationClient } from "@migrations/push/planner";

export async function syncLiveSchema(
  client: MigrationClient,
  options: { forceReset?: boolean; skipValidation?: boolean } = {}
) {
  const preview = await previewPush(client, {
    forceReset: options.forceReset,
    skipValidation: options.skipValidation,
  });
  return applyPush(client, { consent: preview.consent });
}
