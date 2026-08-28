/**
 * INTEGRATION tests for `viborm migrate` against the V1 estate CLI.
 *
 * Subcommands print JSON. Generation publishes `estate.json`, content-addressed
 * snapshots/SQL, and state manifests — not numbered files and not a journal.
 *
 * A file-backed PGlite is required: every command disconnects, and an
 * in-memory PGlite is destroyed on close. The V1 migrate CLI discovers
 * `viborm.config.ts` from cwd; it has no `--config` flag.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isSha256 } from "@src/migrations/identity";
import { isRecord } from "@src/validation/value-guards";
import {
  invokeCLI,
  makeTempProject,
  type TempProject,
  writeConfigFixture,
} from "@tests/contracts/public-client/cli/_harness";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NUMBERED_SQL = /^\d+_.*\.sql$/;
const ESTATE = /estate/i;
const NAMED_ZERO_OR_MISSING = /named 0|not found/i;
const UNKNOWN_OPTION_FORCE = /unknown option|force/;
const ROLL_BACK_OR_NOTHING = /roll back|nothing/i;

function writePersistentConfig(
  project: TempProject,
  schemaBody?: string,
  migrationsBlock?: string
): string {
  return writeConfigFixture(project, {
    schemaBody,
    migrationsBlock,
    dataDir: join(project.dir, "pgdata"),
  });
}

function resetCommand(cmd: Command): void {
  for (const child of cmd.commands) {
    resetCommand(child);
  }
  const values = Reflect.get(cmd, "_optionValues");
  if (isRecord(values)) {
    for (const key of Object.keys(values)) {
      delete values[key];
    }
  }
  Reflect.set(cmd, "_optionValueSources", {});
  for (const opt of cmd.options) {
    if (opt.defaultValue !== undefined) {
      cmd.setOptionValueWithSource(
        opt.attributeName(),
        opt.defaultValue,
        "default"
      );
    }
  }
}

async function resetCommands(): Promise<void> {
  const mod = await import("@src/cli/commands/migrate");
  const command =
    "migrateCommand" in mod && mod.migrateCommand
      ? mod.migrateCommand
      : mod.createMigrateCommand();
  resetCommand(command);
}

async function cli(argv: string[], cwd: string) {
  await resetCommands();
  return invokeCLI(argv, { cwd });
}

function readJson(result: { stdout: string; output: string }): unknown {
  const text = result.stdout.trim() || result.output.trim();
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const start =
    objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)
      ? objectStart
      : arrayStart;
  if (start < 0) {
    throw new Error(`Expected JSON in CLI output:\n${text}`);
  }
  return JSON.parse(text.slice(start));
}

function estateLayout(dir: string) {
  const list = (subdirectory: string, suffix: string): string[] => {
    const path = join(dir, subdirectory);
    if (!existsSync(path)) return [];
    return readdirSync(path).filter((name) => name.endsWith(suffix));
  };
  return {
    estate: existsSync(join(dir, "estate.json")),
    states: list("states", ".json"),
    snapshots: list("snapshots", ".json"),
    sql: list("sql", ".sql"),
    numbered: existsSync(dir)
      ? readdirSync(dir).filter((name) => NUMBERED_SQL.test(name))
      : [],
    journal: existsSync(join(dir, "meta", "_journal.json")),
  };
}

async function tableExists(
  configPath: string,
  table: string
): Promise<boolean> {
  const mod = await import(pathToFileURL(configPath).href);
  const client = mod.client;
  if (client.$driver.connect) {
    await client.$driver.connect();
  }
  const rows = await client.$queryRawUnsafe(
    "SELECT 1 FROM information_schema.tables WHERE table_name = $1",
    table
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function generatePublished(
  project: TempProject,
  extra: string[] = []
): Promise<{ stateId: string; name: string }> {
  const result = await cli(["migrate", "generate", ...extra], project.dir);
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper owns the generate contract
  expect(result.thrown).toBeUndefined();
  const body = readJson(result) as {
    outcome: string;
    stateId: string | null;
    name: string | null;
  };
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper owns the generate contract
  expect(body.outcome).toBe("published");
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper owns the generate contract
  expect(isSha256(body.stateId)).toBe(true);
  return { stateId: body.stateId!, name: body.name ?? "" };
}

describe("migrate", () => {
  let project: TempProject;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  describe("parent command", () => {
    it("with no subcommand lists the V1 verbs and exits 1", async () => {
      const result = await cli(["migrate"], project.dir);
      for (const name of [
        "generate",
        "check",
        "list",
        "show",
        "graph",
        "status",
        "verify",
        "log",
        "apply",
        "down",
        "baseline",
        "resolve",
        "reset",
      ]) {
        expect(result.output).toContain(name);
      }
      expect(result.output).not.toContain("squash");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("generate", () => {
    it("publishes estate.json, a snapshot, a SQL blob, and a state manifest", async () => {
      writePersistentConfig(project);
      const published = await generatePublished(project);
      const layout = estateLayout(project.migrationsDir);
      expect(layout.estate).toBe(true);
      expect(layout.states).toHaveLength(1);
      expect(layout.states[0]).toBe(`${published.stateId}.json`);
      expect(layout.snapshots).toHaveLength(1);
      expect(layout.sql).toHaveLength(1);
      expect(layout.numbered).toHaveLength(0);
      expect(layout.journal).toBe(false);
    });

    it("--dry-run previews SQL and writes no estate", async () => {
      writePersistentConfig(project);
      const result = await cli(
        ["migrate", "generate", "--dry-run"],
        project.dir
      );
      expect(result.thrown).toBeUndefined();
      const body = readJson(result) as { outcome: string; sql: string };
      expect(body.outcome).toBe("preview");
      expect(body.sql.toUpperCase()).toContain("CREATE TABLE");
      expect(estateLayout(project.migrationsDir).estate).toBe(false);
      expect(estateLayout(project.migrationsDir).states).toHaveLength(0);
    });

    it("--dir writes into a custom estate root", async () => {
      writePersistentConfig(project);
      await generatePublished(project, ["--dir", "custom-mig"]);
      expect(estateLayout(`${project.dir}/custom-mig`).estate).toBe(true);
      expect(estateLayout(project.migrationsDir).estate).toBe(false);
    });

    it("config migrations.dir is used when no --dir is given", async () => {
      writePersistentConfig(
        project,
        undefined,
        `migrations: { dir: "./cfg-mig" }`
      );
      await generatePublished(project);
      expect(estateLayout(`${project.dir}/cfg-mig`).estate).toBe(true);
    });

    it("--name is stored as state metadata, not a numbered filename", async () => {
      writePersistentConfig(project);
      const published = await generatePublished(project, [
        "--name",
        "hello-world",
      ]);
      expect(published.name).toBe("hello-world");
      expect(estateLayout(project.migrationsDir).numbered).toHaveLength(0);
    });

    it("a second generate is a noop and publishes no new state", async () => {
      writePersistentConfig(project);
      await generatePublished(project);
      const second = await cli(["migrate", "generate"], project.dir);
      const body = readJson(second) as { outcome: string };
      expect(body.outcome).toBe("noop");
      expect(estateLayout(project.migrationsDir).states).toHaveLength(1);
    });

    it("missing config surfaces an error", async () => {
      const result = await cli(["migrate", "generate"], project.dir);
      expect(result.thrown ?? result.exitCode).toBeTruthy();
      expect(result.output).toContain(
        "Could not find VibORM configuration file"
      );
    });
  });

  describe("apply", () => {
    it("without an estate refuses before effects", async () => {
      writePersistentConfig(project);
      const result = await cli(["migrate", "apply"], project.dir);
      expect(result.thrown ?? result.exitCode).toBeTruthy();
      expect(`${result.thrown ?? ""}${result.output}`).toMatch(ESTATE);
      expect(await tableExists(project.configPath, "user")).toBe(false);
    });

    it("applies the unique leaf: table created and marker advanced", async () => {
      writePersistentConfig(project);
      await generatePublished(project);

      const result = await cli(["migrate", "apply"], project.dir);
      expect(result.thrown).toBeUndefined();
      const body = readJson(result) as { outcome: string; path: string[] };
      expect(body.outcome).toBe("applied");
      expect(body.path).toHaveLength(1);
      expect(await tableExists(project.configPath, "user")).toBe(true);

      const statusBody = readJson(
        await cli(["migrate", "status"], project.dir)
      ) as {
        control: string;
        pending: string[];
        unfinished: boolean;
      };
      expect(statusBody.control).toBe("present");
      expect(statusBody.pending).toEqual([]);
      expect(statusBody.unfinished).toBe(false);
    });

    it("--dry-run previews and applies nothing", async () => {
      writePersistentConfig(project);
      await generatePublished(project);

      const result = await cli(["migrate", "apply", "--dry-run"], project.dir);
      expect(result.thrown).toBeUndefined();
      const body = readJson(result) as { outcome: string; path: string[] };
      expect(body.outcome).toBe("preview");
      expect(body.path).toHaveLength(1);
      expect(await tableExists(project.configPath, "user")).toBe(false);

      const statusBody = readJson(
        await cli(["migrate", "status"], project.dir)
      ) as {
        control: string;
        pending: string[];
      };
      expect(statusBody.control).toBe("absent");
      expect(statusBody.pending).toHaveLength(1);
    });

    it("--to <name> applies the named state", async () => {
      writePersistentConfig(project);
      const published = await generatePublished(project, [
        "--name",
        "users-only",
      ]);

      const result = await cli(
        ["migrate", "apply", "--to", published.name],
        project.dir
      );
      expect(result.thrown).toBeUndefined();
      const body = readJson(result) as { outcome: string; path: string[] };
      expect(body.outcome).toBe("applied");
      expect(body.path).toEqual([published.stateId]);
      expect(await tableExists(project.configPath, "user")).toBe(true);
    });

    it("numeric --to is a name, not an index, and refuses when unmatched", async () => {
      writePersistentConfig(project);
      await generatePublished(project);

      const result = await cli(["migrate", "apply", "--to", "0"], project.dir);
      expect(result.thrown ?? result.exitCode).toBeTruthy();
      expect(`${result.thrown ?? ""}${result.output}`).toMatch(
        NAMED_ZERO_OR_MISSING
      );
      expect(await tableExists(project.configPath, "user")).toBe(false);
    });

    it("--dir apply reads the custom estate root", async () => {
      writePersistentConfig(project);
      await generatePublished(project, ["--dir", "alt-mig"]);

      const missing = await cli(["migrate", "apply"], project.dir);
      expect(missing.thrown ?? missing.exitCode).toBeTruthy();

      const result = await cli(
        ["migrate", "apply", "--dir", "alt-mig"],
        project.dir
      );
      const body = readJson(result) as { outcome: string };
      expect(body.outcome).toBe("applied");
      expect(await tableExists(project.configPath, "user")).toBe(true);
    });

    it("--force is not an apply option", async () => {
      writePersistentConfig(project);
      await generatePublished(project);

      const result = await cli(["migrate", "apply", "--force"], project.dir);
      expect(result.thrown ?? result.exitCode).toBeTruthy();
      expect(result.output.toLowerCase()).toMatch(UNKNOWN_OPTION_FORCE);
    });
  });

  describe("status / check / list / graph", () => {
    it("status after generate reports an absent control plane and a pending root", async () => {
      writePersistentConfig(project);
      const published = await generatePublished(project);

      const body = readJson(await cli(["migrate", "status"], project.dir)) as {
        control: string;
        marker: null;
        pending: string[];
        unfinished: boolean;
      };
      expect(body.control).toBe("absent");
      expect(body.marker).toBeNull();
      expect(body.pending).toEqual([published.stateId]);
      expect(body.unfinished).toBe(false);
    });

    it("check, list, and graph read the estate without touching the database", async () => {
      writePersistentConfig(project);
      const published = await generatePublished(project);

      const check = readJson(await cli(["migrate", "check"], project.dir)) as {
        ok: boolean;
      };
      expect(check.ok).toBe(true);

      const list = readJson(await cli(["migrate", "list"], project.dir)) as {
        stateId: string;
        name: string;
      }[];
      expect(list).toEqual([
        expect.objectContaining({ stateId: published.stateId }),
      ]);

      const graph = readJson(await cli(["migrate", "graph"], project.dir)) as {
        roots: string[];
        leaves: string[];
      };
      expect(graph.roots).toEqual([published.stateId]);
      expect(graph.leaves).toEqual([published.stateId]);

      const shown = readJson(
        await cli(["migrate", "show", published.name], project.dir)
      ) as { stateId: string; name: string };
      expect(shown.stateId).toBe(published.stateId);
    });
  });

  describe("down", () => {
    it("with no marker refuses and drops nothing", async () => {
      writePersistentConfig(project);
      await generatePublished(project);

      const result = await cli(["migrate", "down"], project.dir);
      expect(result.thrown ?? result.exitCode).toBeTruthy();
      expect(`${result.thrown ?? ""}${result.output}`).toMatch(
        ROLL_BACK_OR_NOTHING
      );
    });

    it("rolls back the arrival edge: table dropped and status pending again", async () => {
      writePersistentConfig(project);
      await generatePublished(project);
      await cli(["migrate", "apply"], project.dir);
      expect(await tableExists(project.configPath, "user")).toBe(true);

      const result = await cli(["migrate", "down"], project.dir);
      expect(result.thrown).toBeUndefined();
      const body = readJson(result) as { path: string[]; preview: boolean };
      expect(body.preview).toBe(false);
      expect(body.path).toHaveLength(1);
      expect(await tableExists(project.configPath, "user")).toBe(false);

      const status = readJson(
        await cli(["migrate", "status"], project.dir)
      ) as {
        pending: string[];
      };
      expect(status.pending).toHaveLength(1);
    });

    it("--dry-run lists the rollback and executes nothing", async () => {
      writePersistentConfig(project);
      await generatePublished(project);
      await cli(["migrate", "apply"], project.dir);

      const result = await cli(["migrate", "down", "--dry-run"], project.dir);
      const body = readJson(result) as { path: string[]; preview: boolean };
      expect(body.preview).toBe(true);
      expect(body.path).toHaveLength(1);
      expect(await tableExists(project.configPath, "user")).toBe(true);
    });

    it("--to <name> of the current marker is a no-op rollback", async () => {
      writePersistentConfig(project);
      const published = await generatePublished(project, [
        "--name",
        "users-only",
      ]);
      await cli(["migrate", "apply"], project.dir);

      const result = await cli(
        ["migrate", "down", "--to", published.name],
        project.dir
      );
      expect(result.thrown).toBeUndefined();
      const body = readJson(result) as { path: string[]; preview: boolean };
      expect(body.path).toEqual([]);
      expect(await tableExists(project.configPath, "user")).toBe(true);
    });
  });

  describe("removed journal verbs", () => {
    it("drop, squash, journal, and pending are not subcommands", async () => {
      writePersistentConfig(project);
      await generatePublished(project);
      await cli(["migrate", "apply"], project.dir);

      for (const verb of ["drop", "squash", "journal", "pending"]) {
        const result = await cli(["migrate", verb], project.dir);
        expect(result.exitCode ?? 1).not.toBe(0);
        expect(result.output.toLowerCase()).not.toContain("from tracking");
      }

      expect(await tableExists(project.configPath, "user")).toBe(true);
      const status = readJson(
        await cli(["migrate", "status"], project.dir)
      ) as {
        control: string;
        pending: string[];
      };
      expect(status.control).toBe("present");
      expect(status.pending).toEqual([]);
    });
  });

  describe("generate -> apply -> down", () => {
    it("publishes a state, applies it, then rolls the arrival path back", async () => {
      writePersistentConfig(project);
      const generated = await generatePublished(project);
      expect(estateLayout(project.migrationsDir).states).toHaveLength(1);

      const apply = readJson(await cli(["migrate", "apply"], project.dir)) as {
        outcome: string;
        path: string[];
      };
      expect(apply.outcome).toBe("applied");
      expect(apply.path).toEqual([generated.stateId]);
      expect(await tableExists(project.configPath, "user")).toBe(true);

      const down = readJson(await cli(["migrate", "down"], project.dir)) as {
        path: string[];
        preview: boolean;
      };
      expect(down.preview).toBe(false);
      expect(down.path).toEqual([generated.stateId]);
      expect(await tableExists(project.configPath, "user")).toBe(false);
    });
  });
});
