/**
 * Migration CLI. Composition root is createMigrationClient + loadConfig.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  createMigrationClient,
  type WritableMigrations,
} from "../../migrations/client";
import { loadMigrationGraph } from "../../migrations/graph";
import { isSha256 } from "../../migrations/identity";
import { renderMigrationReview } from "../../migrations/public-view";
import { formatOperation } from "../../migrations/push/format";
import type { MigrationStorageWriter } from "../../migrations/storage/contract";
import { createFsStorageWriter } from "../../migrations/storage/fs-estate";
import type {
  ManualMigrationInput,
  StateSelector,
} from "../../migrations/v1-types";
import {
  finishCli,
  type LoadedConfig,
  loadCliModule,
  loadConfig,
} from "../utils";

const STATE_ID_PREFIX = /^[0-9a-f]{8,63}$/;

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive safe integer");
  }
  return parsed;
}

function selector(value: string | undefined): StateSelector | undefined {
  if (!value) return undefined;
  if (isSha256(value)) return { id: value };
  if (STATE_ID_PREFIX.test(value)) return { prefix: value };
  return { name: value };
}

function printJson(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const lines: string[] = [];
  const render = (item: unknown, indent = "") => {
    if (Array.isArray(item)) {
      for (const entry of item) {
        lines.push(`${indent}-`);
        render(entry, `${indent}  `);
      }
      if (item.length === 0) lines.push(`${indent}(none)`);
    } else if (item !== null && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        if (entry !== null && typeof entry === "object") {
          lines.push(`${indent}${key}:`);
          render(entry, `${indent}  `);
        } else lines.push(`${indent}${key}: ${String(entry)}`);
      }
    } else lines.push(`${indent}${String(item)}`);
  };
  render(value);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function withMigrations(
  options: { dir?: string; config?: string; json?: boolean },
  run: (
    migrations: WritableMigrations,
    config: LoadedConfig,
    storage: MigrationStorageWriter
  ) => Promise<void>
): Promise<void> {
  let client: { $disconnect(): Promise<void> } | undefined;
  let failure: { value: unknown } | undefined;
  try {
    const config = await loadConfig({ config: options.config });
    client = config.client;
    const directory = resolve(
      options.dir ?? config.migrations?.dir ?? "./migrations"
    );
    const storage =
      config.migrations?.storage ?? createFsStorageWriter(directory);
    const migrations = createMigrationClient(config.client, {
      storage,
      ...(config.migrations?.tables === undefined
        ? {}
        : { tables: config.migrations.tables }),
    });
    await run(migrations, config, storage);
  } catch (error) {
    failure = { value: error };
  } finally {
    await finishCli(client, failure, options.json);
  }
}

export function createMigrateCommand(): Command {
  const migrate = new Command("migrate")
    .description("Manage the authenticated migration estate")
    .option("--config <path>", "Path to viborm.config.ts");

  migrate
    .command("generate")
    .description("Publish a new estate state from the current schema")
    .option("-n, --name <name>", "Human-readable state label")
    .option("-d, --dir <dir>", "Estate directory")
    .option(
      "--from <stateId>",
      "Parent state id, or empty for the virtual root"
    )
    .option("--custom <path>", "Compile a TypeScript manual migration author")
    .option(
      "--review <path>",
      "Write labelled forward/check/rollback review SQL"
    )
    .option("--dry-run", "Preview without publishing")
    .option("--json", "Print machine-readable output")
    .action(
      async (opts: {
        name?: string;
        dir?: string;
        from?: string;
        dryRun?: boolean;
        custom?: string;
        review?: string;
        json?: boolean;
      }) => {
        await withMigrations(
          { ...opts, config: migrate.opts<{ config?: string }>().config },
          async (migrations, config) => {
            const from =
              opts.from === undefined
                ? undefined
                : opts.from === "" || opts.from === "empty"
                  ? null
                  : isSha256(opts.from)
                    ? opts.from
                    : (await migrations.show(selector(opts.from)!)).stateId;
            let manualMigration: ManualMigrationInput | undefined;
            if (opts.custom) {
              type Author =
                | ManualMigrationInput
                | ((
                    parents: readonly (string | null)[]
                  ) => ManualMigrationInput | Promise<ManualMigrationInput>);
              const module = await loadCliModule<{
                default?: Author;
                migration?: Author;
              }>(resolve(opts.custom));
              const author =
                (Object.hasOwn(module, "default")
                  ? module.default
                  : undefined) ?? module.migration;
              if (!author)
                throw new Error(
                  "A custom migration module must export a default migration or author function"
                );
              const graph = await migrations.graph();
              const parents = Object.freeze(
                from === undefined
                  ? graph.leaves.length === 0
                    ? [null]
                    : [...graph.leaves]
                  : [from]
              );
              manualMigration =
                typeof author === "function" ? await author(parents) : author;
            }
            const result = await migrations.generate({
              name: opts.name,
              from,
              dryRun: opts.dryRun,
              ...(config.migrations?.resolve
                ? { resolve: config.migrations.resolve }
                : {}),
              ...(manualMigration ? { manualMigration } : {}),
            });
            if (opts.json) printJson(result, true);
            else {
              process.stdout.write(
                `${result.outcome}: ${result.name ?? "No schema changes"}${result.stateId ? ` (${result.stateId})` : ""}\n`
              );
              for (const parent of result.operationsByParent ?? []) {
                process.stdout.write(
                  `Parent ${parent.fromState ?? "empty"}:\n${parent.operations.map(formatOperation).join("\n")}\n`
                );
              }
              for (const warning of result.warnings ?? [])
                process.stderr.write(`warning: ${warning}\n`);
              if (result.reviewSql || result.sql)
                process.stdout.write(`${result.reviewSql || result.sql}\n`);
            }
            if (opts.review && result.reviewSql)
              await writeFile(resolve(opts.review), result.reviewSql, "utf8");
          }
        );
      }
    );

  migrate
    .command("check")
    .description("Validate estate artifacts without touching the database")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(
        { ...opts, config: migrate.opts<{ config?: string }>().config },
        async (migrations) => {
          const result = await migrations.check();
          printJson(result, Boolean(opts.json));
          if (!result.ok) process.exitCode = 1;
        }
      );
    });

  migrate
    .command("list")
    .description("List estate states")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(
        { ...opts, config: migrate.opts<{ config?: string }>().config },
        async (migrations) => {
          printJson(await migrations.list(), Boolean(opts.json));
        }
      );
    });

  migrate
    .command("show")
    .description("Show one estate state")
    .argument("<state>", "State id, unambiguous prefix, or name")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--sql", "Print labelled forward/check/rollback review SQL")
    .option("--review <path>", "Write review SQL to this file")
    .option("--json", "Print machine-readable output")
    .action(
      async (
        state: string,
        opts: { dir?: string; sql?: boolean; review?: string; json?: boolean }
      ) => {
        await withMigrations(
          { ...opts, config: migrate.opts<{ config?: string }>().config },
          async (migrations, _config, storage) => {
            const details = await migrations.show(selector(state)!);
            if (!(opts.sql || opts.review)) {
              printJson(details, Boolean(opts.json));
              return;
            }
            const graph = await loadMigrationGraph(storage);
            const manifest = graph.states.get(details.stateId);
            const blob = manifest && graph.sql.get(manifest.sqlHash);
            if (!(manifest && blob))
              throw new Error("The authenticated state SQL is unavailable");
            const reviewSql = renderMigrationReview(
              manifest.parents,
              manifest.destinationChecks,
              blob
            );
            if (opts.json) printJson({ ...details, reviewSql }, true);
            else {
              printJson(details, false);
              process.stdout.write(reviewSql);
            }
            if (opts.review)
              await writeFile(resolve(opts.review), reviewSql, "utf8");
          }
        );
      }
    );

  migrate
    .command("graph")
    .description("Print estate roots and leaves")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(
        { ...opts, config: migrate.opts<{ config?: string }>().config },
        async (migrations) => {
          printJson(await migrations.graph(), Boolean(opts.json));
        }
      );
    });

  migrate
    .command("status")
    .description("Show marker, pending path, and unfinished attempts")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(
        { ...opts, config: migrate.opts<{ config?: string }>().config },
        async (migrations) => {
          printJson(await migrations.status(), Boolean(opts.json));
        }
      );
    });

  migrate
    .command("verify")
    .description("Lock and compare the live schema to the marker")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; json?: boolean }) => {
      await withMigrations(
        { ...opts, config: migrate.opts<{ config?: string }>().config },
        async (migrations) => {
          const result = await migrations.verify();
          printJson(result, Boolean(opts.json));
          if (!result.ok) process.exitCode = 1;
        }
      );
    });

  migrate
    .command("log")
    .description("Print the append-only ledger")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--limit <n>", "Maximum events", positiveInteger)
    .option("--json", "Print machine-readable output")
    .action(async (opts: { dir?: string; limit?: number; json?: boolean }) => {
      await withMigrations(
        { ...opts, config: migrate.opts<{ config?: string }>().config },
        async (migrations) => {
          const events = await migrations.log();
          printJson(
            opts.limit ? events.slice(-opts.limit) : events,
            Boolean(opts.json)
          );
        }
      );
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
        await withMigrations(
          { ...opts, config: migrate.opts<{ config?: string }>().config },
          async (migrations) => {
            printJson(
              await migrations.apply({
                to: selector(opts.to),
                via: opts.via,
                dryRun: opts.dryRun,
              }),
              Boolean(opts.json)
            );
          }
        );
      }
    );

  migrate
    .command("down")
    .description("Roll back along the recorded arrival path")
    .option("-d, --dir <dir>", "Estate directory")
    .option("--to <selector>", "Roll back to this state")
    .option("--steps <n>", "Number of states to roll back", positiveInteger)
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
        await withMigrations(
          { ...opts, config: migrate.opts<{ config?: string }>().config },
          async (migrations) => {
            if (opts.to !== undefined && opts.steps !== undefined)
              throw new Error("down accepts --to or --steps, not both");
            printJson(
              await migrations.down(
                opts.to
                  ? { to: selector(opts.to)!, dryRun: opts.dryRun }
                  : { steps: opts.steps, dryRun: opts.dryRun }
              ),
              Boolean(opts.json)
            );
          }
        );
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
        await withMigrations(
          { ...opts, config: migrate.opts<{ config?: string }>().config },
          async (migrations) => {
            printJson(
              await migrations.baseline({
                to: selector(opts.to)!,
                via: opts.via,
              }),
              Boolean(opts.json)
            );
          }
        );
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
        await withMigrations(
          { ...opts, config: migrate.opts<{ config?: string }>().config },
          async (migrations) => {
            if (
              [opts.complete, opts.rolledBack, opts.retry].filter(Boolean)
                .length !== 1
            )
              throw new Error(
                "resolve requires exactly one of --complete, --rolled-back, or --retry"
              );
            const outcome = opts.complete
              ? "complete"
              : opts.rolledBack
                ? "rolled-back"
                : "retry";
            printJson(
              await migrations.resolve({ outcome }),
              Boolean(opts.json)
            );
          }
        );
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
    .option("--confirm", "Confirm destructive reset (not required for dry-run)")
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
        await withMigrations(
          { ...opts, config: migrate.opts<{ config?: string }>().config },
          async (migrations) => {
            if (!(opts.dryRun || opts.confirm))
              throw new Error(
                "Reset requires --confirm; inspect --dry-run first"
              );
            printJson(
              await migrations.reset({
                to: selector(opts.to),
                via: opts.via,
                dryRun: opts.dryRun,
              }),
              Boolean(opts.json)
            );
          }
        );
      }
    );

  return migrate;
}

export const migrateCommand = createMigrateCommand();
