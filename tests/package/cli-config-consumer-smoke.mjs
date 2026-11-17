import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { withPackedConsumer } from "./packed-consumer.mjs";

withPackedConsumer(
  "viborm-cli-config-consumer",
  {
    ".env": "VIBORM_CLI_FIXTURE=loaded\n",
    "viborm.config.ts": `import { defineConfig } from "viborm/config";
import { createClient } from "viborm/sqlite3";
import { s } from "viborm";
const fixture: string | undefined = process.env.VIBORM_CLI_FIXTURE;
if (fixture !== "loaded") throw new Error("Project environment was not loaded before the TypeScript config");
// What a driver leaves open once its client is closed: a socket whose server
// never finishes closing it (SurrealDB Cloud's WebSocket) is one.
if (process.env.VIBORM_CLI_LINGER === "1") setInterval(() => {}, 1000);
export default defineConfig({ client: createClient({ schema: { entry: s.model({ id: s.string().id(), title: s.string() }) } }) });
`,
  },
  ({ root }) => {
    const output = execFileSync(
      process.execPath,
      [join(root, "node_modules/viborm/dist/cli.mjs"), "check"],
      { cwd: root, encoding: "utf8", stdio: "pipe" }
    );
    if (!output.includes("valid")) {
      throw new Error(
        `Installed CLI did not validate its loaded schema:\n${output}`
      );
    }
    // The CLI ends once its command is done, whatever the config left open.
    const lingering = execFileSync(
      process.execPath,
      [join(root, "node_modules/viborm/dist/cli.mjs"), "check"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, VIBORM_CLI_LINGER: "1" },
        timeout: 30_000,
      }
    );
    if (!lingering.includes("valid")) {
      throw new Error(
        `Installed CLI did not finish its command beside an open handle:\n${lingering}`
      );
    }
    console.log(
      "Installed CLI TypeScript config and project environment: pass"
    );
  }
);
