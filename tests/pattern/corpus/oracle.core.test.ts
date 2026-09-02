/**
 * The frozen oracle (pattern-engine-ideal-state.md §13.3, unit A).
 *
 * Every corpus payload is dumped on every dialect × substrate × world and
 * compared byte-for-byte to its golden under `goldens/`. Any drift fails.
 * `PATTERN_UPDATE_GOLDENS=1` rewrites the goldens (and removes orphans) —
 * run it deliberately, then read the diff: a changed golden is a changed
 * contract of today's engine, which is what the differential will hold the
 * pattern engine to.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Model } from "@schema/model";
import type { PlanningDialect } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";
import {
  type Dump,
  dumpOperation,
  type KnownWorld,
  type Substrate,
  serializeDump,
} from "../harness/dump";
import { type CorpusPayload, isInvalidPayload, payloads } from "./payloads";
import { schemas } from "./schemas";

const DIALECTS: readonly PlanningDialect[] = ["postgresql", "mysql", "sqlite"];
const SUBSTRATES: readonly Substrate[] = ["transaction", "batch"];
const WORLDS: readonly KnownWorld[] = ["found", "missing"];

const GOLDENS = join(import.meta.dirname, "goldens");
const UPDATE = process.env.PATTERN_UPDATE_GOLDENS === "1";

interface Cell {
  readonly dialect: PlanningDialect;
  readonly substrate: Substrate;
  readonly world: KnownWorld;
}

const CELLS: readonly Cell[] = DIALECTS.flatMap((dialect) =>
  SUBSTRATES.flatMap((substrate) =>
    WORLDS.map((world) => ({ dialect, substrate, world }))
  )
);

/** `<payload-name>.<dialect>.<substrate>.<world>.json`, with `:` spelled `_`. */
function goldenFileName(payload: CorpusPayload, cell: Cell): string {
  const stem = payload.name.replaceAll(":", "_");
  return `${stem}.${cell.dialect}.${cell.substrate}.${cell.world}.json`;
}

function dumpCell(payload: CorpusPayload, cell: Cell): Dump {
  const schema = schemas[payload.schema] as Record<string, Model<any>>;
  const model = schema[payload.model];
  if (!model) {
    throw new Error(
      `corpus payload '${payload.name}' names no model '${payload.model}' in schema '${payload.schema}'`
    );
  }
  return dumpOperation(
    schema,
    model,
    payload.model,
    payload.operation,
    payload.args,
    cell.dialect,
    cell.substrate,
    cell.world,
    payload.options
  );
}

/** Every error a dump carries: its own, or one of its series members' / reads'. */
function dumpErrors(dump: Dump): readonly string[] {
  const errors: string[] = [];
  if (dump.error) errors.push(`${dump.error.name}: ${dump.error.message}`);
  for (const executable of [
    ...(dump.members ?? []),
    ...(dump.resultReads ?? []),
  ]) {
    if (executable.error) {
      errors.push(
        `#${executable.index} ${executable.error.name}: ${executable.error.message}`
      );
    }
  }
  return errors;
}

const cellLabel = (cell: Cell) =>
  `${cell.dialect}/${cell.substrate}/${cell.world}`;

if (UPDATE) mkdirSync(GOLDENS, { recursive: true });

describe("pattern oracle goldens", () => {
  const produced = new Set<string>();

  test.each(
    payloads.map((payload) => [payload.name, payload] as const)
  )("%s", (_name, payload) => {
    const drift: string[] = [];
    for (const cell of CELLS) {
      const file = goldenFileName(payload, cell);
      produced.add(file);
      const path = join(GOLDENS, file);
      const text = `${serializeDump(dumpCell(payload, cell))}\n`;
      if (UPDATE) {
        writeFileSync(path, text);
        continue;
      }
      if (!existsSync(path)) {
        drift.push(`${cellLabel(cell)}: no golden (${file})`);
        continue;
      }
      const golden = readFileSync(path, "utf8");
      if (golden !== text) drift.push(`${cellLabel(cell)}: drift (${file})`);
    }
    expect(
      drift,
      `golden drift for '${payload.name}' — regenerate with PATTERN_UPDATE_GOLDENS=1 and read the diff`
    ).toEqual([]);
  });

  test("the goldens directory holds exactly one file per payload cell", () => {
    const expected = payloads.length * CELLS.length;
    expect(produced.size).toBe(expected);
    const present = readdirSync(GOLDENS).filter((file) =>
      file.endsWith(".json")
    );
    const orphans = present.filter((file) => !produced.has(file));
    if (UPDATE) {
      for (const orphan of orphans) unlinkSync(join(GOLDENS, orphan));
      return;
    }
    expect(orphans).toEqual([]);
    expect(present.length).toBe(expected);
  });
});

describe("pattern oracle corpus summary", () => {
  test("the corpus has the frozen size, and its refusals are the ones named", () => {
    expect(payloads.length).toBe(253);
    const invalid = payloads.filter(isInvalidPayload);
    expect(invalid.length).toBe(24);

    const report: string[] = [];
    const unexpected: string[] = [];
    for (const payload of payloads) {
      const errorsByCell = CELLS.map((cell) => ({
        cell,
        errors: dumpErrors(dumpCell(payload, cell)),
      }));
      const erroring = errorsByCell.filter(({ errors }) => errors.length > 0);
      if (erroring.length > 0) {
        const first = erroring[0]!;
        report.push(
          `${payload.name}: ${erroring.length}/${CELLS.length} cells error; e.g. ${cellLabel(first.cell)} → ${first.errors[0]}`
        );
      }
      if (isInvalidPayload(payload)) {
        // The refusal is the contract: every found-world cell refuses. (A
        // missing-world series capture may observe nothing and so build no
        // member to refuse.)
        const clean = errorsByCell.filter(
          ({ cell, errors }) => cell.world === "found" && errors.length === 0
        );
        for (const { cell } of clean) {
          unexpected.push(
            `invalid payload '${payload.name}' dumped cleanly on ${cellLabel(cell)}`
          );
        }
        continue;
      }
      // A valid payload constructs and compiles on at least one postgresql
      // cell. A single world or substrate may legitimately refuse: an occupied
      // slot before a non-cascading transition refuses at compile where the
      // occupancy is a planning read (transaction, found) and passes where it
      // is a guard (batch).
      const constructs = errorsByCell.some(
        ({ cell, errors }) =>
          cell.dialect === "postgresql" && errors.length === 0
      );
      if (!constructs) {
        unexpected.push(
          `valid payload '${payload.name}' dumps an error on every postgresql cell: ${errorsByCell
            .filter(({ cell }) => cell.dialect === "postgresql")
            .map(({ cell, errors }) => `${cellLabel(cell)} → ${errors[0]}`)
            .join("; ")}`
        );
      }
    }
    // The listing is the deliverable: which payloads refuse, where, and why.
    // eslint-disable-next-line no-console
    console.log(
      `pattern oracle corpus: ${payloads.length} payloads (${invalid.length} invalid), ${payloads.length * CELLS.length} cells, ${report.length} payloads with an erroring cell\n${report.join("\n")}`
    );
    expect(unexpected).toEqual([]);
  });
});
