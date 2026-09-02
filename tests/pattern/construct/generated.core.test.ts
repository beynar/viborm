/**
 * Construction's own invariants over GENERATED payloads (pattern-engine-ideal-
 * state.md §13.3 unit C exit criterion): every generated write payload
 * constructs — only deferred refusals, never a crash — and the pattern it
 * yields keeps single assignment, complete references with K2's pairings, a
 * verb on every row, and arms that exist. Mutated (invalid) payloads that
 * survive the parse boundary must construct too.
 *
 * Fixed seed; ≥ 200 write payloads per corpus schema. A failing payload is
 * shrunk before it is reported.
 */
import type { Model } from "@schema/model";
import { referenceCells } from "@src/query-engine/pattern/cells";
import {
  type Constructed,
  constructPattern,
  type WriteOperation,
} from "@src/query-engine/pattern/construct";
import type { Reference } from "@src/query-engine/pattern/pattern";
import { type SchemaName, schemas } from "@tests/pattern/corpus/schemas";
import {
  type GeneratedPayload,
  generateCorpus,
  validatePayload,
} from "@tests/pattern/generator/generate";
import {
  INVALID_STRATEGIES,
  type InvalidStrategy,
  mutateAll,
} from "@tests/pattern/generator/invalid";
import { shrinkPayload } from "@tests/pattern/generator/shrink";
import { engineFor, planningDriver } from "@tests/pattern/harness/dump";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const SEED = Number(process.env.PATTERN_FUZZ_SEED ?? 20_240_902);
const COUNT = Number(process.env.PATTERN_CONSTRUCT_FUZZ_COUNT ?? 200);
const WRITE_ONLY = {
  weights: {
    findMany: 0,
    findFirst: 0,
    findUnique: 0,
    count: 0,
    aggregate: 0,
    groupBy: 0,
  },
} as const;
const REFUSAL_CLASSES = new Set([
  "NestedWriteError",
  "QueryEngineError",
  "UnsupportedOperationError",
]);

type Pairing = readonly {
  readonly holderColumn: string;
  readonly referencedColumn: string;
}[];

interface Violation {
  readonly invariant: string;
  readonly detail: string;
}

interface Site {
  readonly schema: Record<string, Model<any>>;
  readonly index: ReturnType<typeof engineFor>["relations"];
  readonly registry: ReturnType<typeof createSchemaRegistry>;
}

function siteFor(name: SchemaName): Site {
  const schema = schemas[name] as Record<string, Model<any>>;
  return {
    schema,
    index: engineFor(schema, planningDriver("postgresql", "transaction"))
      .relations,
    registry: createSchemaRegistry(schema),
  };
}

function construct(
  site: Site,
  payload: Pick<GeneratedPayload, "model" | "operation" | "args">
): Constructed {
  const args = validatePayload(site.registry, site.schema, payload) as Record<
    string,
    unknown
  >;
  return constructPattern({
    index: site.index,
    model: site.schema[payload.model] as Model<any>,
    operation: payload.operation as WriteOperation,
    validatedArgs: args,
  });
}

const samePairing = (a: Pairing, b: Pairing): boolean =>
  a.length === b.length &&
  a.every(
    (p, i) =>
      p.holderColumn === b[i]!.holderColumn &&
      p.referencedColumn === b[i]!.referencedColumn
  );

/** Every pairing K2 publishes for one relation, over every variant and both sides of a reference row. */
function k2Pairings(site: Site, reference: Reference): Pairing[] {
  const family = referenceCells(
    site.index,
    reference.relation.model,
    reference.relation.field
  );
  const members =
    family.kind === "single" ? [family.cells] : [...family.byVariant.values()];
  const pairings: Pairing[] = [];
  for (const cells of members) {
    if (
      reference.discriminator &&
      cells.discriminator &&
      reference.discriminator.column !== cells.discriminator.column
    ) {
      continue;
    }
    pairings.push(cells.cells);
    if (cells.viaJunction) {
      pairings.push(
        cells.viaJunction.askingCells,
        cells.viaJunction.referencedCells
      );
    }
  }
  return pairings;
}

function invariants(
  site: Site,
  { pattern, deferredRefusals }: Constructed
): Violation[] {
  const out: Violation[] = [];
  const rows = new Map(pattern.rows.map((r) => [r.id, r]));
  const arms = new Set(pattern.arms.map((a) => a.id));
  const referenceColumns = new Map<string, number>();
  for (const reference of pattern.references) {
    for (const column of reference.columns) {
      const key = `${reference.holder}|${column.holderColumn}`;
      referenceColumns.set(key, (referenceColumns.get(key) ?? 0) + 1);
    }
    if (reference.discriminator) {
      const key = `${reference.holder}|${reference.discriminator.column}`;
      referenceColumns.set(key, (referenceColumns.get(key) ?? 0) + 1);
    }
  }

  // 1. deferred refusals carry today's class, a path and a message
  for (const refusal of deferredRefusals) {
    if (
      !(REFUSAL_CLASSES.has(refusal.error) && refusal.path && refusal.message)
    ) {
      out.push({
        invariant: "refusal-shape",
        detail: `${refusal.kind}: error=${refusal.error} path=${refusal.path}`,
      });
    }
  }

  // 2. single assignment: per (row, column, arm) at most one SCALAR assert cell,
  //    and at most one assert cell per reference contributing to that column
  //    (a scalar beside a reference on one column is the agreement rule's
  //    input, arbitrated at packing — §20.1); k′ only via newKey.
  const groups = new Map<string, number>();
  for (const cell of pattern.cells) {
    if (cell.mode !== "assert") continue;
    const key = `${cell.row}|${cell.column}|${cell.arm ?? "-"}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [key, count] of groups) {
    if (count <= 1) continue;
    const [row, column] = key.split("|");
    const fromReferences = referenceColumns.get(`${row}|${column}`) ?? 0;
    // Admitted: one scalar cell + one cell per reference on that column.
    if (count > fromReferences + 1) {
      out.push({
        invariant: "single-assignment",
        detail: `${key}: ${count} assert cells`,
      });
    }
  }
  for (const row of pattern.rows) {
    if (row.fresh || row.newKey) continue;
    const keyColumns = new Set(
      row.key.map((v) =>
        v.binding.kind === "matched" || v.binding.kind === "returned"
          ? v.binding.column
          : undefined
      )
    );
    for (const cell of pattern.cells) {
      if (cell.row !== row.id || cell.mode !== "assert" || cell.relative)
        continue;
      if (row.key.some((v) => v === cell.value)) continue;
      if (keyColumns.has(cell.column)) {
        out.push({
          invariant: "new-key",
          detail: `row ${row.id} asserts key column ${cell.column} without newKey`,
        });
      }
    }
  }

  // 3. references: both rows exist; columns are a K2 pairing of that relation
  for (const reference of pattern.references) {
    if (!(rows.has(reference.holder) && rows.has(reference.referenced))) {
      out.push({
        invariant: "reference-rows",
        detail: `${reference.relation.field}: ${reference.holder}->${reference.referenced}`,
      });
      continue;
    }
    const pairings = k2Pairings(site, reference);
    if (!pairings.some((p) => samePairing(p, reference.columns))) {
      out.push({
        invariant: "reference-columns",
        detail: `${reference.relation.field}: ${reference.columns.map((c) => `${c.holderColumn}->${c.referencedColumn}`).join(",")}`,
      });
    }
  }

  // 4. every row has a verb; every arm named exists
  for (const row of pattern.rows) {
    if (!row.verb)
      out.push({
        invariant: "row-verb",
        detail: `row ${row.id} (${row.table.table})`,
      });
    if (row.arm !== undefined && !arms.has(row.arm))
      out.push({
        invariant: "arm-exists",
        detail: `row ${row.id} arm ${row.arm}`,
      });
  }
  for (const cell of pattern.cells) {
    if (cell.arm !== undefined && !arms.has(cell.arm))
      out.push({
        invariant: "arm-exists",
        detail: `cell ${cell.row}.${cell.column} arm ${cell.arm}`,
      });
    if (!rows.has(cell.row))
      out.push({
        invariant: "cell-row",
        detail: `cell ${cell.row}.${cell.column}`,
      });
  }
  for (const reference of pattern.references) {
    if (reference.arm !== undefined && !arms.has(reference.arm))
      out.push({
        invariant: "arm-exists",
        detail: `reference ${reference.relation.field} arm ${reference.arm}`,
      });
  }
  for (const arm of pattern.arms) {
    if (!rows.has(arm.decision))
      out.push({
        invariant: "arm-decision",
        detail: `arm ${arm.id} decides on row ${arm.decision}`,
      });
  }
  return out;
}

function errorName(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** One payload's verdict: `ok`, a crash signature, or the invariant it broke. */
function verdict(site: Site, payload: GeneratedPayload): string {
  let constructed: Constructed;
  try {
    constructed = construct(site, payload);
  } catch (e) {
    return `crash ${errorName(e)}`;
  }
  const violations = invariants(site, constructed);
  return violations.length === 0
    ? "ok"
    : `violation ${violations[0]!.invariant}: ${violations[0]!.detail}`;
}

function shrunk(
  site: Site,
  payload: GeneratedPayload,
  signature: string
): GeneratedPayload {
  const label = signature.split(":")[0];
  return shrinkPayload(
    payload,
    (candidate) => {
      try {
        validatePayload(site.registry, site.schema, candidate);
      } catch {
        return false;
      }
      return verdict(site, candidate).split(":")[0] === label;
    },
    5000
  ).value;
}

describe("construction over generated payloads", () => {
  for (const name of Object.keys(schemas) as SchemaName[]) {
    test(`${name}: ${COUNT} seeded write payloads construct and keep the invariants`, () => {
      const site = siteFor(name);
      const corpus = generateCorpus(
        site.schema,
        site.registry,
        SEED,
        COUNT,
        WRITE_ONLY
      );
      const counts = { payloads: 0, ok: 0, deferred: 0, generatorInvalid: 0 };
      const refusalKinds = new Map<string, number>();
      const failures: string[] = [];
      for (const payload of corpus) {
        counts.payloads++;
        try {
          validatePayload(site.registry, site.schema, payload);
        } catch {
          counts.generatorInvalid++;
          continue;
        }
        const signature = verdict(site, payload);
        if (signature === "ok") {
          counts.ok++;
          const { deferredRefusals } = construct(site, payload);
          if (deferredRefusals.length > 0) counts.deferred++;
          for (const r of deferredRefusals)
            refusalKinds.set(r.kind, (refusalKinds.get(r.kind) ?? 0) + 1);
          continue;
        }
        const small = shrunk(site, payload, signature);
        failures.push(
          `seed ${payload.seed} ${payload.model}.${payload.operation}: ${signature}\n    shrunk: ${JSON.stringify(small.args)}`
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `construct fuzz ${name}: ${JSON.stringify(counts)} refusals=${JSON.stringify([...refusalKinds])}${failures.length ? `\n${failures.join("\n")}` : ""}`
      );
      expect(counts.payloads).toBeGreaterThanOrEqual(COUNT);
      expect(counts.generatorInvalid).toBe(0);
      expect(failures).toEqual([]);
    });

    test(`${name}: mutated payloads that survive the parse boundary construct without a crash`, () => {
      const site = siteFor(name);
      const corpus = generateCorpus(
        site.schema,
        site.registry,
        SEED,
        COUNT,
        WRITE_ONLY
      );
      const perStrategy = new Map<
        InvalidStrategy,
        {
          mutants: number;
          parseRefused: number;
          survived: number;
          deferred: number;
          crashed: number;
        }
      >();
      for (const strategy of INVALID_STRATEGIES) {
        perStrategy.set(strategy, {
          mutants: 0,
          parseRefused: 0,
          survived: 0,
          deferred: 0,
          crashed: 0,
        });
      }
      const crashes: string[] = [];
      for (const payload of corpus) {
        for (const mutant of mutateAll(payload, site.schema, site.registry)) {
          const tally = perStrategy.get(mutant.strategy)!;
          tally.mutants++;
          try {
            validatePayload(site.registry, site.schema, mutant.payload);
          } catch {
            tally.parseRefused++;
            continue;
          }
          tally.survived++;
          const signature = verdict(site, mutant.payload);
          if (signature.startsWith("crash")) {
            tally.crashed++;
            crashes.push(
              `${mutant.strategy} seed ${payload.seed}: ${signature}`
            );
            continue;
          }
          if (construct(site, mutant.payload).deferredRefusals.length > 0)
            tally.deferred++;
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `construct fuzz ${name} mutants: ${JSON.stringify([...perStrategy])}${crashes.length ? `\n${crashes.join("\n")}` : ""}`
      );
      expect(crashes).toEqual([]);
    });
  }
});
