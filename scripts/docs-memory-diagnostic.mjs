import { spawnSync } from "node:child_process";
import process from "node:process";
import { getHeapStatistics } from "node:v8";

// Temporary CI evidence only: no parent pnpm, launcher, dev server, or other CLI.
if (
  process.env.VIBORM_DOCS_MEMORY_DIAGNOSTIC === "1" &&
  process.argv[1]?.endsWith("/blume/bin/blume.mjs") &&
  process.argv[2] === "build"
) {
  const rowPattern = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/;
  const sample = (event) => {
    const table = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,rss=,comm="], {
      encoding: "utf8",
      timeout: 1000,
    });
    const rows =
      table.stdout?.split("\n").flatMap((line) => {
        const match = rowPattern.exec(line);
        return match
          ? [
              {
                pid: Number(match[1]),
                ppid: Number(match[2]),
                pgid: Number(match[3]),
                rssKb: Number(match[4]),
                comm: match[5],
              },
            ]
          : [];
      }) ?? [];
    const pgid = rows.find((row) => row.pid === process.pid)?.pgid;
    const processes =
      pgid === undefined ? null : rows.filter((row) => row.pgid === pgid);
    const heap = getHeapStatistics();
    process.stderr.write(
      `DOCS_MEMORY ${JSON.stringify({
        time: new Date().toISOString(),
        event,
        pid: process.pid,
        memory: process.memoryUsage(),
        heap: {
          used: heap.used_heap_size,
          total: heap.total_heap_size,
          limit: heap.heap_size_limit,
          malloced: heap.malloced_memory,
          external: heap.external_memory,
        },
        processes,
        processSampleSucceeded: table.status === 0,
        nativeLiveBytes: null,
      })}\n`
    );
  };
  sample("start");
  setInterval(() => sample("interval"), 1000).unref();
  process.on("exit", () => sample("exit"));
}
