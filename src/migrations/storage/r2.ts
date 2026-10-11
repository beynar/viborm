/**
 * Estate storage in an R2 bucket.
 *
 * R2 writes and listings are strongly consistent. Conditional create is a put
 * conditioned on `etagDoesNotMatch: "*"` (`If-None-Match: *`): R2 checks the
 * condition and stores the object in one step, and returns `null` instead of
 * storing when the key exists. `list` follows the cursor until R2 reports the
 * listing complete, because a page may hold fewer keys than its limit while
 * more remain.
 */

import type { R2Bucket } from "@cloudflare/workers-types";
import type { MigrationStorageWriter } from "./contract";
import { ObjectStoreEstateStorage } from "./object-store";

/**
 * History writer over an R2 bucket. `prefix` places one estate under a key
 * prefix (for example `tenants/42/`), so many estates can share a bucket.
 */
export function createR2StorageWriter(
  bucket: R2Bucket,
  options: { readonly prefix?: string } = {}
): MigrationStorageWriter {
  const prefix = options.prefix ?? "";
  return new ObjectStoreEstateStorage({
    putIfAbsent: async (key, bytes) =>
      (await bucket.put(`${prefix}${key}`, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
      }))
        ? "created"
        : "exists",
    get: async (key) => {
      const object = await bucket.get(`${prefix}${key}`);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    list: async (keyPrefix) => {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({
          prefix: `${prefix}${keyPrefix}`,
          cursor,
        });
        for (const object of page.objects) {
          keys.push(object.key.slice(prefix.length));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return keys;
    },
  });
}
