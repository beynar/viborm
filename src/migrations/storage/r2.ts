/**
 * Estate storage in an R2 bucket.
 *
 * R2 writes and listings are strongly consistent. Conditional create is a put
 * conditioned on `etagDoesNotMatch: "*"` (`If-None-Match: *`): R2 checks the
 * condition and stores the object in one step, and returns `null` instead of
 * storing when the key exists. Hosted R2 may instead answer a put that loses a
 * race for one key with error 10058, having stored nothing: once the winner's
 * object is there, that is the same lost put. `list` follows the cursor until
 * R2 reports the listing complete, because a page may hold fewer keys than its
 * limit while more remain (hosted R2 pages 1,001 keys as 485, 485 and 31).
 */

import type { R2Bucket } from "@cloudflare/workers-types";
import type { MigrationStorageWriter } from "./contract";
import { ObjectStoreEstateStorage } from "./object-store";

/** R2's "Reduce your concurrent request rate for the same object" error. */
const CONTENDED_PUT = "(10058)";

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
    putIfAbsent: async (key, bytes) => {
      const name = `${prefix}${key}`;
      try {
        return (await bucket.put(name, bytes, {
          onlyIf: { etagDoesNotMatch: "*" },
        }))
          ? "created"
          : "exists";
      } catch (error) {
        const lost =
          error instanceof Error &&
          error.message.includes(CONTENDED_PUT) &&
          (await bucket.head(name)) !== null;
        if (!lost) throw error;
        return "exists";
      }
    },
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
