import { createCheckCommand } from "@src/cli/commands/check";
import {
  makeTempProject,
  type TempProject,
  writeConfigFixture,
} from "@tests/contracts/public-client/cli/_harness";
import { afterEach, describe, expect, it, vi } from "vitest";

const DUPLICATE_TABLES = `
  const user = s.model({ id: s.string().id() }).map("people");
  const member = s.model({ id: s.string().id() }).map("people");
  const schema = { user, member };
`;

const UNUSED_FOREIGN_KEY = `
  const user = s.model({ id: s.string().id(), teamId: s.string() }).map("users");
  const schema = { user };
`;

let project: TempProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function check(
  schemaBody?: string,
  driverOptions = "",
  args: string[] = []
) {
  project = makeTempProject();
  writeConfigFixture(project, {
    dialect: "sqlite3",
    ...(schemaBody ? { schemaBody } : {}),
  });
  if (driverOptions) {
    // The application creates its client without the runtime checks.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const source = readFileSync(project.configPath, "utf8");
    writeFileSync(
      project.configPath,
      source.replace(
        'dataDir: ":memory:" }',
        `dataDir: ":memory:", ${driverOptions} }`
      )
    );
  }
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  await createCheckCommand().parseAsync(
    ["--config", project.configPath, ...args],
    { from: "user" }
  );
  return out.join("");
}

describe("viborm check", () => {
  it("accepts a valid schema", async () => {
    expect(await check()).toContain("Schema valid (1 models).");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports what a client created with skipSchemaValidation did not check", async () => {
    const output = await check(DUPLICATE_TABLES, "skipSchemaValidation: true");
    expect(output).toContain("[M004]");
    expect(output).toContain("Schema invalid");
    expect(process.exitCode).toBe(1);
  });

  it("prints advisory warnings without failing", async () => {
    const output = await check(UNUSED_FOREIGN_KEY);
    expect(output).toContain("warning [CM001]");
    expect(output).toContain("Schema valid (1 models).");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the result as JSON with --json", async () => {
    const result = JSON.parse(await check(undefined, "", ["--json"]));
    expect(result).toMatchObject({ valid: true, errors: [] });
  });

  it("fails the command when the config cannot be loaded", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(
      createCheckCommand().parseAsync(
        ["--config", "/nonexistent/viborm.config.ts"],
        { from: "user" }
      )
    ).rejects.toThrow("exit 1");
  });
});
