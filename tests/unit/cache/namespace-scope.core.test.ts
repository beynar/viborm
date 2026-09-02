/**
 * What the official cache scope is a function OF.
 *
 * One `cache()` definition and one backend may be shared by several clients, so
 * the thing that keeps two of them from reading each other's rows is the scope
 * derived when the definition binds to a concrete driver. It partitions on four
 * facts — the private snapshot revision, the user's `version`, the dialect, and
 * the adapter's SQL namespace — and the derivation is a PURE function of them.
 *
 * That purity is load-bearing twice over. It is why appending another extension
 * re-derives the same scope instead of needing a registry to hand the old one
 * back, and it is why the assertions below can pin the exact bytes: a scope that
 * were allocated per bind would still have to encode these four facts injectively,
 * and a non-injective join is the one defect no behavioral test would catch
 * (two different clients would simply share entries and look correct).
 *
 * The end-to-end proof that these bytes ARE the storage keys lives beside this
 * file in `namespace-isolation.core.test.ts`.
 */

import {
  createOfficialCacheNamespace,
  type OfficialCacheScopeFacts,
} from "@cache/key";
import { describe, expect, test } from "vitest";

const PG = "0070006f0073007400670072006500730071006c";
const MYSQL = "006d007900730071006c";
const SQLITE = "00730071006c006900740065";

/**
 * The exact namespace for each cell of dialect × SQL namespace × version.
 *
 * Read the grammar off the strings: `viborm:cache:<revision>:d:<hex>:<ns>:<ver>`
 * where `<ns>` is `x` (unknown) or `k:<hex>`, and `<ver>` is `u`, `n:<f64 hex>`,
 * or `s:<hex>`. Every body is fixed-width hex and hex never contains the `:`
 * separator, so no component can absorb the one after it.
 *
 * The revision is `r3`: it moved off `r1` because dialect and namespace entered
 * the derivation, and an `r1` entry made no claim about which schema produced
 * its rows; it moved off `r2` when a stored decimal stopped materializing as a
 * string and started materializing as a `Decimal`.
 */
const ENCODING_TABLE: ReadonlyArray<
  readonly [OfficialCacheScopeFacts, string]
> = [
  [
    { dialect: "postgresql", namespace: "public", version: undefined },
    `viborm:cache:r3:d:${PG}:k:007000750062006c00690063:u`,
  ],
  [
    { dialect: "postgresql", namespace: "public", version: "v1" },
    `viborm:cache:r3:d:${PG}:k:007000750062006c00690063:s:00760031`,
  ],
  [
    { dialect: "postgresql", namespace: "public", version: 1 },
    `viborm:cache:r3:d:${PG}:k:007000750062006c00690063:n:3ff0000000000000`,
  ],
  [
    { dialect: "postgresql", namespace: "public", version: 0 },
    `viborm:cache:r3:d:${PG}:k:007000750062006c00690063:n:0000000000000000`,
  ],
  [
    { dialect: "postgresql", namespace: "billing", version: undefined },
    `viborm:cache:r3:d:${PG}:k:00620069006c006c0069006e0067:u`,
  ],
  [
    { dialect: "postgresql", namespace: "alpha", version: undefined },
    `viborm:cache:r3:d:${PG}:k:0061006c007000680061:u`,
  ],
  [
    { dialect: "postgresql", namespace: "beta", version: undefined },
    `viborm:cache:r3:d:${PG}:k:0062006500740061:u`,
  ],
  [
    { dialect: "mysql", namespace: "billing", version: undefined },
    `viborm:cache:r3:d:${MYSQL}:k:00620069006c006c0069006e0067:u`,
  ],
  // Unbound MySQL and SQLite: a bare `x`, with no body a string could reach.
  [
    { dialect: "mysql", namespace: undefined, version: undefined },
    `viborm:cache:r3:d:${MYSQL}:x:u`,
  ],
  [
    { dialect: "sqlite", namespace: undefined, version: undefined },
    `viborm:cache:r3:d:${SQLITE}:x:u`,
  ],
  // A database actually NAMED like the absence markers still encodes as known.
  [
    { dialect: "mysql", namespace: "undefined", version: undefined },
    `viborm:cache:r3:d:${MYSQL}:k:0075006e0064006500660069006e00650064:u`,
  ],
  [
    { dialect: "mysql", namespace: "x", version: undefined },
    `viborm:cache:r3:d:${MYSQL}:k:0078:u`,
  ],
];

describe("the encoding table", () => {
  test.each(
    ENCODING_TABLE
  )("derives the exact namespace for %j", (facts, expected) => {
    expect(createOfficialCacheNamespace(facts)).toBe(expected);
  });
});

describe("the join cannot be forged", () => {
  test("a namespace cannot absorb the version component", () => {
    // If the components were joined without fixed-width encoding, a namespace
    // ending in the next component's text could impersonate a different tuple.
    const absorbing = createOfficialCacheNamespace({
      dialect: "mysql",
      namespace: "shop:u",
      version: undefined,
    });
    const absorbed = createOfficialCacheNamespace({
      dialect: "mysql",
      namespace: "shop",
      version: undefined,
    });
    expect(absorbing).not.toBe(absorbed);
  });

  test("a dialect cannot absorb the namespace component", () => {
    expect(
      createOfficialCacheNamespace({
        dialect: "mysql:k:0061",
        namespace: undefined,
        version: undefined,
      })
    ).not.toBe(
      createOfficialCacheNamespace({
        dialect: "mysql",
        namespace: "a",
        version: undefined,
      })
    );
  });

  test("the same qualifier in two dialects is two scopes", () => {
    // A PostgreSQL schema `billing` and a MySQL database `billing` are
    // different stores that spell their qualifier identically.
    expect(
      createOfficialCacheNamespace({
        dialect: "postgresql",
        namespace: "billing",
        version: undefined,
      })
    ).not.toBe(
      createOfficialCacheNamespace({
        dialect: "mysql",
        namespace: "billing",
        version: undefined,
      })
    );
  });

  test("an unknown namespace cannot collide with a real one", () => {
    const unknown = createOfficialCacheNamespace({
      dialect: "mysql",
      namespace: undefined,
      version: undefined,
    });
    for (const spelling of ["undefined", "x", "", "null", "*"]) {
      expect(
        createOfficialCacheNamespace({
          dialect: "mysql",
          namespace: spelling,
          version: undefined,
        })
      ).not.toBe(unknown);
    }
  });
});
