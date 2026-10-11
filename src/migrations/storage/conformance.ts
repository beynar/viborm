/**
 * Reusable storage conformance suite. A writable driver that cannot pass
 * these tests is not a V1 estate owner.
 */

import { MigrationError, VibORMErrorCode } from "../../errors";
import { bytesEqual } from "../canonical-json";
import { utf8Bytes } from "../identity";
import { encodeSqlBlob } from "../v1-parse";
import type { MigrationStorageWriter } from "./contract";

const RACERS = 8;
const LISTED = 5;

const isCorruption = (error: unknown): boolean =>
  error instanceof MigrationError &&
  error.code === VibORMErrorCode.MIGRATION_CORRUPTION;

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
          if (isCorruption(error)) return;
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
    {
      name: "concurrent identical creates report created exactly once",
      run: async () => {
        const storage = createWriter();
        const bytes = utf8Bytes("race-identical");
        const id = encodeSqlBlob(bytes);
        const outcomes = await Promise.all(
          Array.from({ length: RACERS }, () => storage.publishState(id, bytes))
        );
        const created = outcomes.filter((o) => o.outcome === "created").length;
        if (created !== 1) {
          throw new Error(`${created} of ${RACERS} concurrent creates won`);
        }
      },
    },
    {
      name: "concurrent conflicting creates keep one winner and refuse the rest",
      run: async () => {
        const storage = createWriter();
        const id = encodeSqlBlob(utf8Bytes("race-conflicting"));
        const candidates = Array.from({ length: RACERS }, (_, n) =>
          utf8Bytes(`{"racer":${n}}`)
        );
        const settled = await Promise.allSettled(
          candidates.map((bytes) => storage.publishState(id, bytes))
        );
        const winners = candidates.filter(
          (_, n) => settled[n]?.status === "fulfilled"
        );
        const refused = settled.filter(
          (result) =>
            result.status === "rejected" && isCorruption(result.reason)
        ).length;
        const stored = await storage.readState(id);
        if (
          winners.length !== 1 ||
          refused !== RACERS - 1 ||
          !(stored && bytesEqual(stored, winners[0]!))
        ) {
          throw new Error(
            `${winners.length} winners and ${refused} refusals of ${RACERS} conflicting creates`
          );
        }
      },
    },
    {
      name: "absent artifacts read as null",
      run: async () => {
        const storage = createWriter();
        const id = encodeSqlBlob(utf8Bytes("absent"));
        const reads = await Promise.all([
          storage.readState(id),
          storage.readSnapshot(id),
          storage.readSql(id),
        ]);
        if (reads.some((bytes) => bytes !== null)) {
          throw new Error("an absent artifact read as bytes");
        }
      },
    },
    {
      name: "published artifacts are listed as soon as publish returns",
      run: async () => {
        const storage = createWriter();
        const artifacts = Array.from({ length: LISTED }, (_, n) =>
          utf8Bytes(`listed-${n}`)
        );
        const ids = artifacts.map(encodeSqlBlob);
        for (const [n, id] of ids.entries()) {
          await storage.publishState(id, artifacts[n]!);
          await storage.publishSnapshot(id, artifacts[n]!);
          await storage.publishSql(id, artifacts[n]!);
        }
        const listings = await Promise.all([
          storage.listStates(),
          storage.listSnapshots(),
          storage.listSql(),
        ]);
        if (listings.some((listed) => ids.some((id) => !listed.includes(id)))) {
          throw new Error("a published artifact is missing from its listing");
        }
      },
    },
    {
      name: "a listed state's snapshot and SQL are already readable (manifest last)",
      run: async () => {
        const storage = createWriter();
        const bytes = utf8Bytes("manifest-last");
        const hash = encodeSqlBlob(bytes);
        let published = false;
        const publishing = (async () => {
          await storage.publishSnapshot(hash, bytes);
          await storage.publishSql(hash, bytes);
          await storage.publishState(hash, bytes);
        })().finally(() => {
          published = true;
        });
        try {
          for (;;) {
            const settled = published;
            if ((await storage.listStates()).includes(hash)) break;
            if (settled) throw new Error("a published state is not listed");
          }
          const [snapshot, sql] = await Promise.all([
            storage.readSnapshot(hash),
            storage.readSql(hash),
          ]);
          if (!(snapshot && sql)) {
            throw new Error("a listed state's artifacts are not readable yet");
          }
        } finally {
          await publishing;
        }
      },
    },
  ];
}
