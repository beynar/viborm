/**
 * Traffic for the Workers cold-start measurement. Each round optionally
 * redeploys every arm (a new version starts on fresh isolates, so the round's
 * first requests are genuine cold starts), then sends interleaved requests:
 * every arm × every query, `--per` times. Results (including the Worker's own
 * `cold` flag) are appended to --log as JSON lines; CPU and wall time are read
 * afterwards from Workers Logs by `report.mjs`.
 *
 *   node benchmarks/workers-cold/drive.mjs --dir /abs/workers --host perf.viborm.dev \
 *     --arms viborm-now,viborm-before,drizzle --rounds 8 --per 3 --redeploy \
 *     --log /abs/requests.jsonl
 */
import { execFileSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { appendFileSync } from "node:fs";
import { request } from "node:https";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    dir: { type: "string" },
    host: { type: "string" },
    arms: { type: "string" },
    queries: { type: "string", default: "unique,rows20,filtered20,relation20" },
    rounds: { type: "string", default: "8" },
    per: { type: "string", default: "3" },
    redeploy: { type: "boolean", default: false },
    log: { type: "string" },
  },
});

const resolver = new Resolver();
resolver.setServers(["1.1.1.1"]);
const [address] = await resolver.resolve4(o.host);

const get = (path) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const req = request(
      {
        host: o.host,
        path,
        servername: o.host,
        lookup: (_h, _o, cb) => cb(null, [{ address, family: 4 }]),
        headers: { "cache-control": "no-cache" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body,
            ms: performance.now() - started,
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });

const arms = o.arms.split(",");
const queries = o.queries.split(",");
for (let round = 0; round < Number(o.rounds); round++) {
  if (o.redeploy)
    for (const arm of arms)
      execFileSync("cf", ["deploy", "--message", `cold round ${round}`], {
        cwd: `${o.dir}/${arm}`,
        stdio: "ignore",
      });
  for (let i = 0; i < Number(o.per); i++)
    for (const q of queries)
      for (const arm of i % 2 ? [...arms].reverse() : arms) {
        const { status, body, ms } = await get(`/${arm}?q=${q}`);
        const parsed = status === 200 ? JSON.parse(body) : { error: body };
        appendFileSync(
          o.log,
          `${JSON.stringify({ at: Date.now(), round, arm, q, status, clientMs: ms, ...parsed })}\n`
        );
      }
  process.stdout.write(`round ${round} done\n`);
}
