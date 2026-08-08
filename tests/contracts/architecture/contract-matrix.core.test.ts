import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_LAYERS, type TestLayer } from "@tests/contracts/contract";
import { DRIVER_CONTRACT_IDS } from "@tests/contracts/drivers/contract-ids";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { CONTRACT_ASSIGNMENTS, PROVIDERS } from "@tests/providers/matrix";
import { classifyTestFile } from "@tests/inventory";

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

const runtimeOwners: ReadonlyArray<{
  prefix: string;
  layer: TestLayer;
}> = [
  { prefix: "tests/unit/validation/", layer: "validation" },
  { prefix: "tests/unit/scalars/", layer: "scalars" },
  {
    prefix: "tests/unit/operation-schemas/",
    layer: "operation-schemas",
  },
  { prefix: "tests/unit/relations/", layer: "relations" },
  {
    prefix: "tests/unit/schema-validation/",
    layer: "schema-validation",
  },
  { prefix: "tests/contracts/architecture/", layer: "query-engine" },
  { prefix: "tests/contracts/engine/", layer: "query-engine" },
  { prefix: "tests/contracts/adapters/", layer: "adapters" },
  { prefix: "tests/contracts/drivers/", layer: "drivers" },
  { prefix: "tests/contracts/public-client/", layer: "client" },
  { prefix: "tests/unit/cache/", layer: "cache" },
  { prefix: "tests/unit/instrumentation/", layer: "instrumentation" },
  { prefix: "tests/unit/migrations/", layer: "migrations" },
];

describe("contract and provider matrix", () => {
  it("keeps one stable ContractDefinition ID per behavior registration", async () => {
    const behaviorDirectory = join(
      REPOSITORY_ROOT,
      "tests/contracts/drivers/behaviors"
    );
    const behaviorFiles = (await collectFiles(behaviorDirectory)).filter(
      (file) => file.endsWith("-behavior.ts")
    );
    const sourceIds: string[] = [];

    for (const behaviorFile of behaviorFiles) {
      const source = await readFile(behaviorFile, "utf8");
      const ids = [
        ...source.matchAll(/defineContract\(\{\s*id:\s*"([^"]+)"/g),
      ].flatMap((match) => (match[1] ? [match[1]] : []));
      expect(source, behaviorFile).toContain("defineContract");
      expect(ids.length, behaviorFile).toBeGreaterThan(0);
      sourceIds.push(...ids);
    }

    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    expect(sourceIds.sort()).toEqual(
      [...Object.values(DRIVER_CONTRACT_IDS)].sort()
    );
  });

  it("assigns every contract to every provider exactly once", () => {
    const contractIds = new Set<string>(Object.values(DRIVER_CONTRACT_IDS));
    const providerIds = new Set<string>(
      PROVIDERS.map((provider) => provider.id)
    );
    const assignmentKeys = CONTRACT_ASSIGNMENTS.map(
      (assignment) => `${assignment.providerId}:${assignment.contractId}`
    );

    expect(new Set(assignmentKeys).size).toBe(assignmentKeys.length);
    expect(CONTRACT_ASSIGNMENTS).toHaveLength(
      contractIds.size * providerIds.size
    );

    for (const assignment of CONTRACT_ASSIGNMENTS) {
      expect(contractIds.has(assignment.contractId)).toBe(true);
      expect(providerIds.has(assignment.providerId)).toBe(true);
      if (assignment.decision === "waive") {
        expect(assignment.reason?.trim().length).toBeGreaterThan(0);
      } else {
        expect(assignment.reason).toBeUndefined();
      }
    }

    for (const contractId of contractIds) {
      expect(
        CONTRACT_ASSIGNMENTS.some(
          (assignment) =>
            assignment.contractId === contractId &&
            assignment.decision === "run"
        ),
        contractId
      ).toBe(true);
    }
  });

  it("matches matrix run decisions to provider registrations", async () => {
    const contractEntries = Object.entries(DRIVER_CONTRACT_IDS);

    for (const provider of PROVIDERS) {
      let providerSource = "";
      for (const sourceFile of provider.sourceFiles) {
        providerSource += await readFile(
          join(REPOSITORY_ROOT, sourceFile),
          "utf8"
        );
      }

      const runIds = new Set(
        CONTRACT_ASSIGNMENTS.filter(
          (assignment) =>
            assignment.providerId === provider.id &&
            assignment.decision === "run"
        ).map((assignment) => assignment.contractId)
      );

      for (const [contractName, contractId] of contractEntries) {
        const registration = `${contractName}.register(`;
        if (runIds.has(contractId)) {
          expect(providerSource, `${provider.id}:${contractId}`).toContain(
            registration
          );
        } else {
          expect(providerSource, `${provider.id}:${contractId}`).not.toContain(
            registration
          );
        }
      }
    }
  });

  it("gives every layer one runtime core owner and one type core", async () => {
    const testFiles = await collectFiles(join(REPOSITORY_ROOT, "tests"));
    const runtimeCounts = new Map<TestLayer, number>();
    const typeCounts = new Map<TestLayer, number>();

    for (const layer of TEST_LAYERS) {
      runtimeCounts.set(layer, 0);
      typeCounts.set(layer, 0);
    }

    for (const absoluteFile of testFiles) {
      const file = relative(REPOSITORY_ROOT, absoluteFile);
      if (file.endsWith(".core.test.ts")) {
        const owners = runtimeOwners.filter(({ prefix }) =>
          file.startsWith(prefix)
        );
        expect(owners, file).toHaveLength(1);
        const owner = owners[0];
        if (owner) {
          runtimeCounts.set(
            owner.layer,
            (runtimeCounts.get(owner.layer) ?? 0) + 1
          );
        }
      }

      if (file.endsWith(".core.types.ts")) {
        const owners = TEST_LAYERS.filter((layer) =>
          file.startsWith(`tests/types/${layer}/`)
        );
        expect(owners, file).toHaveLength(1);
        const owner = owners[0];
        if (owner) {
          typeCounts.set(owner, (typeCounts.get(owner) ?? 0) + 1);
        }
      }
    }

    for (const layer of TEST_LAYERS) {
      expect(runtimeCounts.get(layer), `${layer} runtime core`).toBeGreaterThan(
        0
      );
      expect(typeCounts.get(layer), `${layer} type core`).toBeGreaterThan(0);
    }
  });

  it("inventories every executable test by owner and boundary", async () => {
    const testFiles = (await collectFiles(join(REPOSITORY_ROOT, "tests")))
      .map((file) => relative(REPOSITORY_ROOT, file))
      .filter(
        (file) =>
          file.endsWith(".test.ts") ||
          file.endsWith(".core.types.ts") ||
          file.endsWith("-smoke.mjs")
      );

    for (const file of testFiles) {
      const inventory = classifyTestFile(file);
      expect(inventory, file).toBeDefined();
      expect(inventory?.file).toBe(file);
    }
  });
});
