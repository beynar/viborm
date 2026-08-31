import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { buildSelectWithAliases } from "@query-engine/builders/select-builder";
import { RELATION_COUNTS_RESULT_KEY } from "@query-engine/result-aliases";
import { s } from "@schema";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const artifact = s.model({
  id: s.string().id(),
  serial: s.bigInt(),
  payload: s.blob(),
});

const dashboard = s.model({
  id: s.string().id(),
  _count: s.int(),
  rows: s.toMany(() => row),
});
const row = s.model({
  id: s.string().id(),
  dashboardId: s.string(),
  dashboard: s
    .toOne(() => dashboard)
    .fields("dashboardId")
    .references("id"),
});

const report = s.model({
  id: s.string().id(),
  entries: s.toMany(() => reportEntry),
});
const reportEntry = s.model({
  id: s.string().id(),
  reportId: s.string(),
  report: s.toOne(() => report).fields("reportId").references("id"),
});

prepareSchema({ artifact, dashboard, row, report, reportEntry });

describe("select transport boundaries", () => {
  test("encodes BigInt and blob projections before JSON assembly", () => {
    const scope = scopeFor(new PostgresAdapter(), artifact);
    const projection = buildSelectWithAliases(
      scope,
      { serial: true, payload: true },
      undefined,
      scope.rootAlias,
      { asJson: true }
    );
    const statement = projection.sql.toStatement("$n");

    expect(projection.aliases).toEqual(["serial", "payload"]);
    expect(statement).toContain('CAST("t0"."serial" AS TEXT)');
    expect(statement).toContain("encode");
    expect(statement).toContain('"t0"."payload"');
  });

  test("publishes selected relation counts under the private carrier", () => {
    const scope = scopeFor(new PostgresAdapter(), report);
    const projection = buildSelectWithAliases(
      scope,
      { id: true },
      { _count: { select: { entries: true } } },
      scope.rootAlias
    );

    expect(projection.aliases).toEqual(["id", RELATION_COUNTS_RESULT_KEY]);
    expect(projection.sql.toStatement("$n")).toContain("COUNT(*)");
  });

  test("refuses a relation-count carrier that would overwrite a real scalar", () => {
    const scope = scopeFor(new PostgresAdapter(), dashboard);

    expect(() =>
      buildSelectWithAliases(
        scope,
        undefined,
        { _count: { select: { rows: true } } },
        scope.rootAlias
      )
    ).toThrow(
      "Relation counts cannot be selected together with a model field named '_count'."
    );
  });
});

describe("coverage low value", () => {
  test("contains empty selections already rejected by operation schemas", () => {
    const scope = scopeFor(new PostgresAdapter(), artifact);

    expect(() =>
      buildSelectWithAliases(
        scope,
        { id: false, serial: undefined },
        undefined,
        scope.rootAlias
      )
    ).toThrow("needs at least one truthy value");
  });

  test("ignores false relation-count members after validated selection", () => {
    const scope = scopeFor(new PostgresAdapter(), dashboard);
    const projection = buildSelectWithAliases(
      scope,
      { id: true, _count: { select: { rows: false } } },
      undefined,
      scope.rootAlias
    );

    expect(projection.aliases).toEqual(["id"]);
  });
});
