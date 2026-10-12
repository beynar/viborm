import type { Sha256 } from "@migrations/identity";
import type {
  MigrationStorageReader,
  MigrationStorageWriter,
} from "@migrations/storage/contract";
import {
  encodeStateManifest,
  encodeTransitionHash,
  parseStateManifest,
} from "@migrations/v1-parse";

/**
 * Publishes into `to` the state VibORM 1.1.0 would have published for the
 * manual state `stateId` of `from` declared `execution: "stepwise"`: since
 * 1.2.0, generate refuses that declaration on SQLite (plan S5), so a test of
 * what apply or resolve do with such a state re-declares and re-hashes a
 * transactional one. Returns the twin's id.
 */
export async function publishLegacyStepwise(
  from: MigrationStorageReader,
  to: MigrationStorageWriter,
  stateId: Sha256
): Promise<Sha256> {
  const bytes = await from.readState(stateId);
  if (!bytes) throw new Error(`state ${stateId} is not published`);
  const { stateId: _id, ...manifest } = parseStateManifest(bytes, stateId);
  const parents = manifest.parents.map(
    ({ transitionHash: _hash, ...parent }) => {
      const legacy = {
        ...parent,
        requestedForwardBoundary: "stepwise" as const,
      };
      return { ...legacy, transitionHash: encodeTransitionHash(legacy) };
    }
  );
  const twin = encodeStateManifest({ ...manifest, parents });
  await to.publishState(twin.stateId, twin.bytes);
  return twin.stateId;
}
