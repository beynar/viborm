/**
 * Migration CLI. Composition root is createMigrationClient + loadConfig.
 */

import { resolve } from "node:path";
import { Command } from "commander";
import type { StateSelector } from "../../migrations";
import { createFsStorageWriter, createMigrationClient } from "../../migrations";
import { isSha256 } from "../../migrations/identity";
import { failCli, loadConfig } from "../utils";

const STATE_ID_PREFIX = /^[0-9a-f]{8,63}$/;

function selector(value: string | undefined): StateSelector | undefined {
  if (!value) return undefined;
  if (isSha256(value)) return { id: value };
  if (STATE_ID_PREFIX.test(value)) return { prefix: value };
  return { name: value };
}

function printJson(value: unknown, json: boolean): void {
  process.stdout.write(
    `${JSON.stringify(value, json ? null : undefined, json ? 2 : 0)}\n`
  );
}

async function withMigrations(
  dir: string | undefined,
  run: (
    migrations: ReturnType<typeof createMigrationClient>,
    client: { $disconnect(): Promise<void> }
  ) => Promise<void>
): Promise<void> {
  let client: { $disconnect(): Promise<void> } | undefined;
  try {
    const config = await loadConfig();
    client = config.client;
    const directory = resolve(dir ?? config.migrations?.dir ?? "./migrations");
    const storage =
      config.migrations?.storage ?? createFsStorageWriter(directory);
    const migrations = createMigrationClient(config.client, { storage });
    await run(migrations, config.client);
  } catch (error) {
    failCli(error);
  } finally {
    await client?.$disconnect();
  }
}

export function createMigrateCommand(): Command {
  const migrate = new Command("migrate").description(
    "Manage the authenticated migration estate"
  );

  migrate
    .command("generate")
    .description("Publish a new estate state from the current schema")
    .option("-n, --name <name>", "Human-readable state label")
    .option("-d, --dir <dir>", "Estate directory")
    .option(
      "--from <stateId>",
      "Parent state id, or empty for the virtual root"
    )
    .option("--dry-run", "Preview without publishing")
    .option("--json", "Print machine-readable output")
    .action(
      async (opts: {
        name?: string;
        dir?: string;
        from?: string;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        await withMigrations(opts.dir, async (migrations) => {
          const from =
            opts.from === undefined
              ? undefined
              : opts.from === "" || opts.from === "empty"
                ? null
                : isSha256(opts.from)
                  ? opts.from
                  : (await migrations.show(selector(opts.from)!)).stateId;
          const result = await migrations.generate({
            name: opts.name,
            from,
            dryRun: opts.dryRun,
          });
          printJson(result, Boolean(opts.json));
        });
      }
    );

  migrate
    .command("check")
    .description("Validate estate artifacts without touching the database")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(opts.dir, async (migrations) => {
        const result = await migrations.check();
        printJson(result, Boolean(opts.json));
        if (!result.ok) process.exitCode = 1;
      });
    });

  migrate
    .command("list")
    .description("List estate states")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(opts.dir, async (migrations) => {
        printJson(await migrations.list(), Boolean(opts.json));
      });
    });

  migrate
    .command("show")
    .description("Show one estate state")
    .argument("<state>", "State id, unambiguous prefix, or name")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (state: string, opts: { dir?: string; json?: boolean }) => {
      await withMigrations(opts.dir, async (migrations) => {
        printJson(await migrations.show(selector(state)!), Boolean(opts.json));
      });
    });

  migrate
    .command("graph")
    .description("Print estate roots and leaves")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(opts.dir, async (migrations) => {
        printJson(await migrations.graph(), Boolean(opts.json));
      });
    });

  migrate
    .command("status")
    .description("Show marker, pending path, and unfinished attempts")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(opts.dir, async (migrations) => {
        printJson(await migrations.status(), Boolean(opts.json));
      });
    });

  migrate
    .command("verify")
    .description("Lock and compare the live schema to the marker")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(opts.dir, async (migrations) => {
        const result = await migrations.verify();
        printJson(result, Boolean(opts.json));
        if (!result.ok) process.exitCode = 1;
      });
    });

  migrate
    .command("log")
    .description("Print the append-only ledger")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--limit <n>", "Maximum events", (value) => Number(value))
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; limit?: number; json?: boolean }) => {
      await withMigrations(opts.dir, async (migrations) => {
        const events = await migrations.log();
        printJson(
          opts.limit ? events.slice(-opts.limit) : events,
          Boolean(opts.json)
        );
      });
    });

  migrate
    .command("apply")
    .description("Apply estate states to the target")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--to <selector>", "Target state id, prefix, or name")
    .option("--via <stateId...>", "Force a path through these states")
    .option("--dry-run", "Plan without executing")
    .option("--json", "Print machine-readable output")
    .action(
      async (opts: {
        dir?: string;
        to?: string;
        via?: string[];
        dryRun?: boolean;
        json?: boolean;
      }) => {
        await withMigrations(opts.dir, async (migrations) => {
          printJson(
            await migrations.apply({
              to: selector(opts.to),
              via: opts.via,
              dryRun: opts.dryRun,
            }),
            Boolean(opts.json)
          );
        });
      }
    );

  migrate
    .command("down")
    .description("Roll back along the recorded arrival path")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--to <selector>", "Roll back to this state")
    .option("--steps <n>", "Number of states to roll back", (value) =>
      Number(value)
    )
    .option("--dry-run", "Plan without executing")
    .option("--json", "Print machine-readable output")
    .action(
      async (opts: {
        dir?: string;
        to?: string;
        steps?: number;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        await withMigrations(opts.dir, async (migrations) => {
          printJson(
            await migrations.down(
              opts.to
                ? { to: selector(opts.to)!, dryRun: opts.dryRun }
                : { steps: opts.steps, dryRun: opts.dryRun }
            ),
            Boolean(opts.json)
          );
        });
      }
    );

  migrate
    .command("baseline")
    .description("Adopt an existing database as a known estate state")
    .requiredOption("--to <selector>", "Existing estate state to adopt")
    .option("--via <stateId...>", "Force the recorded root path")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(
      async (opts: {
        to: string;
        via?: string[];
        dir?: string;
        json?: boolean;
      }) => {
        await withMigrations(opts.dir, async (migrations) => {
          printJson(
            await migrations.baseline({
              to: selector(opts.to)!,
              via: opts.via,
            }),
            Boolean(opts.json)
          );
        });
      }
    );

  migrate
    .command("resolve")
    .description("Resolve an unfinished attempt after live proof")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--complete", "Mark complete when destination proof holds")
    .option("--rolled-back", "Mark rolled back when origin proof holds")
    .option("--retry", "Retry from the first proven incomplete step")
    .option("--json", "Print machine-readable output")
    .action(
      async (opts: {
        dir?: string;
        complete?: boolean;
        rolledBack?: boolean;
        retry?: boolean;
        json?: boolean;
      }) => {
        const outcome = opts.complete
          ? "complete"
          : opts.rolledBack
            ? "rolled-back"
            : opts.retry
              ? "retry"
              : undefined;
        if (!outcome) {
          throw new Error(
            "resolve requires --complete, --rolled-back, or --retry"
          );
        }
        await withMigrations(opts.dir, async (migrations) => {
          printJson(await migrations.resolve({ outcome }), Boolean(opts.json));
        });
      }
    );

  migrate
    .command("reset")
    .description(
      "Clear managed objects and replay from empty to a selected state"
    )
    .option("-d, --dir <dir>", "Estate directory")
    .option("--to <selector>", "Target state after rebuild")
    .option("--via <stateId...>", "Force a rebuild path")
    .requiredOption("--confirm", "Required. Reset is destructive.")
    .option("--dry-run", "Plan without executing")
    .option("--json", "Print machine-readable output")
    .action(
      async (opts: {
        dir?: string;
        to?: string;
        via?: string[];
        confirm?: boolean;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        await withMigrations(opts.dir, async (migrations) => {
          printJson(
            await migrations.reset({
              to: selector(opts.to),
              via: opts.via,
              dryRun: opts.dryRun,
            }),
            Boolean(opts.json)
          );
        });
      }
    );

  return migrate;
}

export const migrateCommand = createMigrateCommand();
