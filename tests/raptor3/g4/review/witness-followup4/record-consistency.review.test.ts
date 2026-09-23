/**
 * Independent review probes (round 4) — does the corrected record agree with
 * itself?
 *
 * The round-3 review's must-fix 1 was a narrative that its own receipts
 * contradicted. The repair corrects §16's preamble and §16.1 in place. These
 * cells check that the correction reaches every sentence of §16 that makes the
 * withdrawn claim, and that §16's pointers to the round-4 measurements name the
 * section that holds them.
 *
 * A failing cell here is a finding about the record, not about the work.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const NOTE = resolve(
  ROOT,
  "docs/architecture/raptor3-evidence/g4/witness/note.md"
);

const MEASURED_AT = "7475621b";
const CLOSED_AT = "a830d713";

interface Section {
  readonly heading: string;
  readonly lines: readonly { readonly number: number; readonly text: string }[];
}

function section(prefix: string): Section {
  const all = readFileSync(NOTE, "utf8").split("\n");
  const start = all.findIndex((line) => line.startsWith(`## ${prefix}`));
  assert.ok(start >= 0, `note.md has no section ${prefix}`);
  const rest = all.slice(start + 1);
  const end = rest.findIndex((line) => /^## \d+\./.test(line));
  const body = end >= 0 ? rest.slice(0, end) : rest;
  const lines = body.map((text, index) => ({
    number: start + 2 + index,
    text,
  }));
  return { heading: all[start] ?? "", lines };
}

describe("review probe (round 4): §16 after the correction", () => {
  it("withdraws its stated reason and names the identity its rows belong to", () => {
    const sixteen = section("16.");
    const body = sixteen.lines.map((line) => line.text).join("\n");
    assert.match(body, /withdrawn|contradicted by this\s+round's own receipts/);
    assert.ok(
      body.includes(MEASURED_AT),
      "§16 never names the production identity its rows were measured at"
    );
  });

  it("nowhere tells a reader that its own numbers are the numbers at the closing identity", () => {
    // §16's preamble and §16.1 now say the opposite: every row belongs to
    // 7475621b…, and no row was re-taken after production moved to a830d713….
    // A sentence left behind that still attributes the rows to the closing
    // identity re-creates the finding inside the section that answers it.
    const sixteen = section("16.");
    const offenders = sixteen.lines.filter(
      (line) =>
        line.text.includes(CLOSED_AT) &&
        /the numbers above|these numbers|the numbers here/i.test(line.text)
    );
    assert.deepEqual(
      offenders.map((line) => `${line.number}: ${line.text.trim()}`),
      [],
      "a sentence in §16 still attributes §16's rows to the closing identity"
    );
  });

  it("points a reader at the section that actually holds the round-4 measurements", () => {
    const all = readFileSync(NOTE, "utf8").split("\n");
    const measured = all.find(
      (line) => /^### 17\.\d+ /.test(line) && /Measured results/.test(line)
    );
    assert.ok(measured, "note.md has no round-4 measured-results section");
    const number = /^### (17\.\d+)/.exec(measured)?.[1];
    assert.ok(number, "the measured-results heading carries no section number");
    const sixteen = section("16.");
    const misdirected = sixteen.lines.filter(
      (line) =>
        /§17\.\d+/.test(line.text) &&
        !line.text.includes(`§${number}`) &&
        (line.text.includes(CLOSED_AT) ||
          line.text.includes("62,116,444") ||
          /Those numbers are in/.test(line.text))
    );
    assert.deepEqual(
      misdirected.map((line) => `${line.number}: ${line.text.trim()}`),
      [],
      `§16 sends the reader to a section other than §${number} for this round's measurements`
    );
  });
});
