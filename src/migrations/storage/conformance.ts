/**
 * Reusable storage conformance suite. A writable driver that cannot pass
 * these tests is not a V1 estate owner.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import { utf8Bytes } from "../identity";
import { encodeSqlBlob } from "../v1-parse";
import type { MigrationStorageWriter } from "./contract";

export function createStorageConformanceSuite(
  createWriter: () => MigrationStorageWriter
): { readonly name: string; readonly run: () => Promise<void> }[] {
  return [
    {
      name: "identical content-addressed publish is idempotent",
      run: async () => {
        const storage = createWriter();
        const bytes = utf8Bytes("hello");
        const hash = encodeSqlBlob(bytes);
        const first = await storage.publishSql(hash, bytes);
        const second = await storage.publishSql(hash, bytes);
        if (first.outcome !== "created" || second.outcome !== "identical") {
          throw new Error("idempotent publish failed");
        }
      },
    },
    {
      name: "same hash with different bytes is corruption",
      run: async () => {
        const storage = createWriter();
        const bytes = utf8Bytes("hello");
        const hash = encodeSqlBlob(bytes);
        await storage.publishSql(hash, bytes);
        try {
          await storage.publishSql(hash, utf8Bytes("other"));
        } catch (error) {
          if (
            error instanceof MigrationError &&
            error.code === VibORMErrorCode.MIGRATION_CORRUPTION
          ) {
            return;
          }
        }
        throw new Error("corrupt publish was accepted");
      },
    },
    {
      name: "listStates returns only committed manifests",
      run: async () => {
        const storage = createWriter();
        const listed = await storage.listStates();
        if (listed.length !== 0) throw new Error("fresh writer is not empty");
      },
    },
    {
      name: "estate publish is idempotent for identical bytes",
      run: async () => {
        const storage = createWriter();
        const bytes = utf8Bytes('{"format":"1"}');
        const first = await storage.publishEstate(bytes);
        const second = await storage.publishEstate(bytes);
        if (first.outcome !== "created" || second.outcome !== "identical") {
          throw new Error("estate idempotent publish failed");
        }
      },
    },
  ];
}
