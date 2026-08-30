import { hydrateSchemaNames, s } from "@schema";
import {
  findAddressableKey,
  findReferenceableKey,
  getModelKeyCatalog,
  type OrderedModelKey,
} from "@schema/model";
import {
  getCompoundIdConstraint,
  getPrimaryKeyFields,
} from "@src/query-engine/context";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, test } from "vitest";

/**
 * Phase 1 (distinct-truth compression) — the ordered model-key catalog.
 *
 * One catalog owns how a row can be addressed: an optional `rowKey` in
 * CONSTRAINT order, grouped `addressableKeys` whose optional `name`
 * distinguishes a grouped-constraint selector from a bare scalar one, and the
 * ordered `referenceableKeys` physical view, and the conservative flattened
 * `uniqueOverlapFields` view. `getPrimaryKeyFields` and
 * `getCompoundIdConstraint` survive as its derived views; the misleading
 * flatteners (`getCanonicalIdentityFields`, `getTargetIdentityFields`) are
 * deleted.
 *
 * The divergences this file records deliberately:
 * - constraint order vs shape order: the row key is the `.id([...])` array's
 *   order (the reading `target-projection.core.test.ts` pins); the cursor
 *   re-sorts to shape order as a consumer-local projection.
 * - totality: `getPrimaryKeyFields` keeps its `["id"]` fallback while
 *   `catalog.rowKey` is honestly absent on a key-less model.
 * - a model spelling BOTH a scalar `.id()` and a compound `.id([...])` is
 *   refused by definition rule F002 at push time — never at `createClient` —
 *   so its reading is pinned: the ROW KEY answers compound-first, as
 *   `getPrimaryKeyFields` always has, while the CURSOR keeps its historical
 *   scalar-first tie-breaker (`getCursorIdentityFields`), because the compound
 *   members can be nullable and a nullable tie-break vector breaks pagination.
 */

const fixtures = (() => {
  const scalarPk = s.model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string(),
  });

  // Declaration order and KEY order disagree on purpose.
  const reorderedPk = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      note: s.string().unique(),
    })
    .id(["slot", "tenantId"]);

  const namedCompoundUnique = s
    .model({
      id: s.int().id(),
      region: s.string(),
      code: s.string(),
    })
    .unique(["region", "code"], { name: "regionCode" });

  const unnamedCompoundUnique = s
    .model({
      id: s.int().id(),
      a: s.string(),
      b: s.string(),
    })
    .unique(["a", "b"]);

  const partialUniqueIndex = s
    .model({
      id: s.int().id(),
      slug: s.string(),
    })
    .index(["slug"], { unique: true, where: "deleted_at IS NULL" });

  const totalUniqueIndex = s
    .model({
      id: s.int().id(),
      tenant: s.string(),
      slug: s.string(),
    })
    .index(["slug", "tenant"], { unique: true });

  const mapped = s.model({
    id: s.string().id().map("mapped_pk_col"),
    handle: s.string().unique().map("mapped_handle_col"),
  });

  const keyless = s.model({
    label: s.string(),
  });

  const multiUnique = s.model({
    id: s.int().id(),
    email: s.string().unique(),
    handle: s.string().unique(),
  });

  // Refused by F002 at push time; representable, so its reading is pinned.
  const bothIds = s
    .model({
      pk: s.string().id(),
      x: s.string(),
      y: s.string(),
    })
    .id(["x", "y"]);

  // A single-member COMPOUND id is a grouped selector; a scalar `.id()` is a
  // bare one. The two accept different `where` spellings.
  const singleMemberCompound = s
    .model({
      a: s.string(),
      v: s.string(),
    })
    .id(["a"]);

  // `.id()` MERGES, so a second compound constraint is representable (F002
  // refuses it at push time only). Both stay addressable; only the FIRST is
  // the row key.
  const twoCompoundIds = s
    .model({
      a: s.string(),
      b: s.string(),
    })
    .id(["a"])
    .id(["b"]);

  const models = {
    scalarPk,
    reorderedPk,
    namedCompoundUnique,
    unnamedCompoundUnique,
    partialUniqueIndex,
    totalUniqueIndex,
    mapped,
    keyless,
    multiUnique,
    bothIds,
    singleMemberCompound,
    twoCompoundIds,
  };
  hydrateSchemaNames(models);
  return models;
})();

const bare = (kind: OrderedModelKey["kind"], field: string) => ({
  kind,
  fields: [field],
});

describe("model-key catalog — referenceableKeys", () => {
  test("keeps addressable keys first and adds total unique indexes", () => {
    expect(
      getModelKeyCatalog(fixtures.totalUniqueIndex).referenceableKeys
    ).toEqual([["id"], ["slug", "tenant"]]);
    expect(
      getModelKeyCatalog(fixtures.partialUniqueIndex).referenceableKeys
    ).toEqual([["id"]]);
  });

  test("resolves a reordered tuple to the physical key order", () => {
    expect(
      findReferenceableKey(fixtures.totalUniqueIndex, ["tenant", "slug"])
    ).toEqual(["slug", "tenant"]);
    expect(
      findReferenceableKey(fixtures.totalUniqueIndex, ["slug", "tenant"])
    ).toEqual(["slug", "tenant"]);
    expect(
      findReferenceableKey(fixtures.totalUniqueIndex, ["tenant"])
    ).toBeUndefined();
  });

  test("distinguishes valid tuples that share underscore-separated fragments", () => {
    const model = s
      .model({
        id: s.int().id(),
        alpha: s.string(),
        beta_code: s.string(),
        alpha_beta: s.string(),
        code: s.string(),
      })
      .unique(["alpha", "beta_code"], { name: "left_lookup" })
      .unique(["alpha_beta", "code"], { name: "right_lookup" });

    expect(findReferenceableKey(model, ["code", "alpha_beta"])).toEqual([
      "alpha_beta",
      "code",
    ]);
    expect(findReferenceableKey(model, ["beta_code", "alpha"])).toEqual([
      "alpha",
      "beta_code",
    ]);
  });

  test("distinct explicit names preserve both colliding tuples for catalogs and foreign keys", () => {
    const target = s
      .model({
        id: s.int().id(),
        a_b: s.string(),
        c: s.string(),
        a: s.string(),
        b_c: s.string(),
        firstRows: s.toMany(() => firstRow).name("first"),
        secondRows: s.toMany(() => secondRow).name("second"),
      })
      .unique(["a_b", "c"], { name: "left_lookup" })
      .unique(["a", "b_c"], { name: "right_lookup" });
    const firstRow = s.model({
      id: s.int().id(),
      targetAB: s.string(),
      targetC: s.string(),
      target: s
        .toOne(() => target)
        .name("first")
        .fields("targetAB", "targetC")
        .references("a_b", "c"),
    });
    const secondRow = s.model({
      id: s.int().id(),
      targetA: s.string(),
      targetBC: s.string(),
      target: s
        .toOne(() => target)
        .name("second")
        .fields("targetA", "targetBC")
        .references("a", "b_c"),
    });

    expect(getModelKeyCatalog(target).referenceableKeys).toEqual([
      ["id"],
      ["a_b", "c"],
      ["a", "b_c"],
    ]);
    expect(validateSchema({ target, firstRow, secondRow }).errors).toEqual([]);
  });
});
const grouped = (
  kind: OrderedModelKey["kind"],
  name: string,
  fields: string[]
) => ({ kind, name, fields });

describe("model-key catalog — rowKey", () => {
  test("a scalar .id() is a bare primary key", () => {
    expect(getModelKeyCatalog(fixtures.scalarPk).rowKey).toEqual(
      bare("primary", "id")
    );
    expect(getPrimaryKeyFields(fixtures.scalarPk)).toEqual(["id"]);
    expect(getCompoundIdConstraint(fixtures.scalarPk)).toBeUndefined();
  });

  test("a compound .id([...]) keeps CONSTRAINT order, not shape order", () => {
    expect(getModelKeyCatalog(fixtures.reorderedPk).rowKey).toEqual(
      grouped("primary", "slot_tenantId", ["slot", "tenantId"])
    );
    expect(getPrimaryKeyFields(fixtures.reorderedPk)).toEqual([
      "slot",
      "tenantId",
    ]);
    expect(getCompoundIdConstraint(fixtures.reorderedPk)).toEqual({
      name: "slot_tenantId",
      fields: ["slot", "tenantId"],
    });
  });

  test("a key-less model has no rowKey while getPrimaryKeyFields stays total", () => {
    expect(getModelKeyCatalog(fixtures.keyless).rowKey).toBeUndefined();
    expect(getPrimaryKeyFields(fixtures.keyless)).toEqual(["id"]);
  });

  test("both id spellings on one model answer compound-first (F002 refuses the schema)", () => {
    expect(getModelKeyCatalog(fixtures.bothIds).rowKey).toEqual(
      grouped("primary", "x_y", ["x", "y"])
    );
    expect(getPrimaryKeyFields(fixtures.bothIds)).toEqual(["x", "y"]);
  });

  test("a single-member compound id is still a grouped selector", () => {
    expect(getModelKeyCatalog(fixtures.singleMemberCompound).rowKey).toEqual(
      grouped("primary", "a", ["a"])
    );
  });

  test("a second compound id never promotes to the row key", () => {
    expect(getModelKeyCatalog(fixtures.twoCompoundIds).rowKey).toEqual(
      grouped("primary", "a", ["a"])
    );
  });
});

describe("model-key catalog — addressableKeys", () => {
  test("bare scalars in shape order, then grouped constraints in declaration order", () => {
    expect(
      getModelKeyCatalog(fixtures.namedCompoundUnique).addressableKeys
    ).toEqual([
      bare("primary", "id"),
      grouped("compoundUnique", "regionCode", ["region", "code"]),
    ]);
    expect(getModelKeyCatalog(fixtures.multiUnique).addressableKeys).toEqual([
      bare("primary", "id"),
      bare("unique", "email"),
      bare("unique", "handle"),
    ]);
  });

  test("an unnamed compound unique keys under its underscore-joined name", () => {
    expect(
      getModelKeyCatalog(fixtures.unnamedCompoundUnique).addressableKeys
    ).toEqual([
      bare("primary", "id"),
      grouped("compoundUnique", "a_b", ["a", "b"]),
    ]);
  });

  test("a unique INDEX is not addressable — no selector can name it", () => {
    expect(
      getModelKeyCatalog(fixtures.partialUniqueIndex).addressableKeys
    ).toEqual([bare("primary", "id")]);
  });

  test("the catalog answers in TS-field space on a mapped model", () => {
    expect(getModelKeyCatalog(fixtures.mapped).addressableKeys).toEqual([
      bare("primary", "id"),
      bare("unique", "handle"),
    ]);
  });

  test("EVERY compound id stays addressable by name; the bare scalar id stays addressable beside a compound row key", () => {
    // Validation's whereUnique surface admits every declared compound-id
    // constraint, so the engine must resolve each — narrowing to the row key
    // alone would refuse selectors validation accepts.
    expect(getModelKeyCatalog(fixtures.twoCompoundIds).addressableKeys).toEqual(
      [grouped("primary", "a", ["a"]), grouped("primary", "b", ["b"])]
    );
    expect(findAddressableKey(fixtures.twoCompoundIds, "b")).toEqual(
      grouped("primary", "b", ["b"])
    );
    // The cursor's scalar-first projection depends on the bare id surviving in
    // addressableKeys even when the row key is the compound.
    expect(getModelKeyCatalog(fixtures.bothIds).addressableKeys).toEqual([
      bare("primary", "pk"),
      grouped("primary", "x_y", ["x", "y"]),
    ]);
  });

  test("findAddressableKey resolves selector keys with bare-scalar precedence", () => {
    expect(findAddressableKey(fixtures.multiUnique, "email")).toEqual(
      bare("unique", "email")
    );
    expect(
      findAddressableKey(fixtures.namedCompoundUnique, "regionCode")
    ).toEqual(grouped("compoundUnique", "regionCode", ["region", "code"]));
    expect(findAddressableKey(fixtures.reorderedPk, "slot_tenantId")).toEqual(
      grouped("primary", "slot_tenantId", ["slot", "tenantId"])
    );
    expect(findAddressableKey(fixtures.multiUnique, "nope")).toBeUndefined();
    // The member of a grouped key is not itself a selector.
    expect(findAddressableKey(fixtures.reorderedPk, "slot")).toBeUndefined();
  });
});

describe("model-key catalog — uniqueOverlapFields", () => {
  test("flattens scalar uniques, compound-id members, and compound-unique members", () => {
    expect(
      getModelKeyCatalog(fixtures.namedCompoundUnique).uniqueOverlapFields
    ).toEqual(["id", "region", "code"]);
    expect(
      getModelKeyCatalog(fixtures.reorderedPk).uniqueOverlapFields
    ).toEqual(["note", "slot", "tenantId"]);
  });

  test("a partial unique index stays OUT of the overlap view", () => {
    expect(
      getModelKeyCatalog(fixtures.partialUniqueIndex).uniqueOverlapFields
    ).toEqual(["id"]);
  });
});

describe("model-key catalog — identity and caching", () => {
  test("one catalog per model instance", () => {
    expect(getModelKeyCatalog(fixtures.scalarPk)).toBe(
      getModelKeyCatalog(fixtures.scalarPk)
    );
  });

  test("getPrimaryKeyFields answers a fresh array per call", () => {
    const first = getPrimaryKeyFields(fixtures.reorderedPk);
    const second = getPrimaryKeyFields(fixtures.reorderedPk);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  test("caller mutations cannot change a stored index or its cached key facts", () => {
    const fields: ("slug" | "tenant")[] = ["slug", "tenant"];
    const options: { unique?: boolean } = { unique: true };
    const model = s
      .model({
        id: s.int().id(),
        slug: s.string(),
        tenant: s.string(),
      })
      .index(fields, options);
    const catalog = getModelKeyCatalog(model);

    fields.splice(0, fields.length, "slug", "slug");
    options.unique = false;

    expect(model["~"].state.indexes).toEqual([
      { fields: ["slug", "tenant"], options: { unique: true } },
    ]);
    expect(getModelKeyCatalog(model)).toBe(catalog);
    expect(catalog.referenceableKeys).toEqual([["id"], ["slug", "tenant"]]);
    expect(validateSchema({ indexed: model }).errors).toEqual([]);
  });

  test("snapshots inherited index options without turning a partial index total", () => {
    const options = Object.assign(
      Object.create({ where: "deleted_at IS NULL" }),
      { unique: true }
    );
    const model = s
      .model({ id: s.int().id(), slug: s.string() })
      .index(["slug"], options);

    expect(model["~"].state.indexes).toEqual([
      {
        fields: ["slug"],
        options: { unique: true, where: "deleted_at IS NULL" },
      },
    ]);
    expect(getModelKeyCatalog(model).referenceableKeys).toEqual([["id"]]);
  });
});
