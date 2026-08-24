import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectRelationLanguageCensus,
  RETIRED_RELATION_SYMBOLS,
  sourceChainEntries,
  sourceIdentifierEntries,
  sourceRetiredDiscriminantEntries,
  trackedTextEntries,
} from "@tests/fixtures/relation-language-census";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { describe, expect, it } from "vitest";

/**
 * The tracked-source census of the unified relation language (plan §12.4).
 *
 * Lifecycle assertion 1 (Package A): each detector reproduced its exact frozen
 * baseline manifest of old-surface occurrences, and each detector carried its
 * own falsification witness.
 * Lifecycle assertion 2 (Package F, this file): both frozen manifests are
 * DELETED and replaced by the final zero-outside-allowlist assertions. The
 * estate spells no retired relation identifier, no retired capability on a
 * factory-rooted chain, no retired runtime membership discriminant, and no
 * retired call/import/side token in any textual region except §12.4's one
 * allowlisted class.
 *
 * A zero assertion is green for a converted estate and equally green for a
 * misspelled ban list, so the detectors keep their own falsification
 * witnesses beside it, and the ban list gains one: an independent spelling of
 * §12.4's symbols that the list must equal and the detector must count.
 *
 * The file is an extended (non-`.core`) contract, so it runs in
 * `extended-local` under `pnpm test:all` — never inside a 30-second layer
 * budget, never in `package` or `provider-d1`, whose runtimes cannot spawn
 * `git` (`vitest.workspace.ts:64-75`).
 */

const census = collectRelationLanguageCensus(REPOSITORY_ROOT);

/**
 * A source file for the AST gate. It deliberately contains, and the expected
 * entries deliberately exclude: retained lookalikes (`PolymorphicToOneStorage`,
 * `buildManyToManyJoinParts`, `fkOneToOneUnique`), a retired spelling in a
 * comment, a retired spelling in a string, and a variant carrier's retained
 * `.optional()` (plan §4.3). The chain rooted at `base` proves the one
 * same-file binding hop the estate's own modifier probe needs.
 */
const SOURCE_WITNESS = `// census-pattern-table falsification witness.
// A comment spelling s.oneToMany(() => post) belongs to the text gate.
const spelledInAString = "s.manyToOne(() => user)";
const sideTokenInAString = ".A('postId')";
const retained = [PolymorphicToOneStorage, buildManyToManyJoinParts, fkOneToOneUnique];
const base = s.manyToMany(() => tag);
const configured = base.through("post_tags").A("postId").B("tagId");
const post = s.model({
  author: s.manyToOne(() => user).fields().optional(),
  cover: s.oneToOne(() => cover).unique(),
  mentions: s.polymorphicToOne({ post: () => post }).optional(),
});
const state: PolymorphicRelationState = getRelationInfo(post);
`;

/** Every executable role the retired runtime-discriminant gate owns. */
const RETIRED_DISCRIMINANT_WITNESS = `// census-pattern-table falsification witness.
type LegacyScope = { kind: "manyToMany" };
const scope = { kind: "manyToMany" };
if (scope.kind === "manyToMany") consume(scope);
switch (scope.kind) { case "manyToMany": consume(scope); }
function orientation(): MembershipReadOrientation { return "manyToMany"; }
`;

/** Prose, a real fenced call, a real named import, and a retired side token. */
const MARKDOWN_WITNESS = `<!-- census-pattern-table falsification witness -->
The manyToMany factory is retired, and so is oneToMany.

\`\`\`ts
import { oneToMany, defineConfig } from "viborm";
const post = s.model({ tags: s.manyToMany(() => tag).A("postId") });
\`\`\`
`;

/** The genuine false-positive class: Prisma-side identifiers, never viborm calls. */
const PRISMA_WITNESS = `model Post {
  id           String @id
  manyToOneId  String
  oneToMany    OneToOne @relation(fields: [manyToOneId], references: [id])
}
`;

/** A tracked DOM capture: the rendered word is prose, the rendered call is not. */
const DOM_CAPTURE_WITNESS = `# census-pattern-table falsification witness
- generic [ref=e12]: manyToMany
- code [ref=e13]: s.oneToMany(() => post)
`;

/** Two comment nodes in a census module: one marked, one ordinary. */
const SELF_EXEMPTION_WITNESS = `/* census-pattern-table: s.manyToOne(() => user) is this pattern's own example. */
// Ordinary estate usage in the same file stays censused: s.oneToMany(() => post)
`;

/**
 * The banned identifiers spelled INDEPENDENTLY of the detector's own constant:
 * plan §12.4's list, ruling D10's six additions, and ruling D21's three. A zero
 * census is green for a converted estate and equally green for a ban list that
 * misspells a symbol, and a witness generated from the list itself would agree
 * with its own typo — so the list needs one spelling that does not come from it.
 */
const BANNED_SYMBOLS = [
  "AnyPolymorphicRelation",
  "GetRelationType",
  "IsFieldsLessInverseOneToOne",
  "ManyToManyRelation",
  "ManyToManyRelationState",
  "PolymorphicRelationInfo",
  "PolymorphicRelationInfoOf",
  "PolymorphicRelationMap",
  "PolymorphicRelationState",
  "PolymorphicStateOf",
  "PolymorphicToManyRelation",
  "PolymorphicToManyRelationInfo",
  "PolymorphicToManyState",
  "PolymorphicToOneRelation",
  "PolymorphicToOneRelationInfo",
  "PolymorphicToOneState",
  "RelationInfo",
  "RelationResultKind",
  "RelationType",
  "ResolvedPolymorphicEdge",
  "_polymorphicStorage",
  "extractPolymorphicRelationMap",
  "findPairedManyToManyState",
  "getPolymorphicStorage",
  "getRelationInfo",
  "inverseOneToOneMustBeOptional",
  "isPolymorphicToOneRelationInfo",
  "manyToMany",
  "manyToOne",
  "oneToMany",
  "oneToOne",
  "polymorphicMemberCarrier",
  "polymorphicRelations",
  "polymorphicRelationsByModel",
  "polymorphicToMany",
  "polymorphicToOne",
  "setPolymorphicStorage",
  "setSource",
] as const;

/**
 * A historical architecture plan under §12.4's superseded-API banner: the one
 * textual region the gate permits a retired spelling in.
 */
const BANNERED_PLAN_WITNESS = `# An old plan
<!-- census-pattern-table falsification witness -->

> **Superseded relation spellings.** This document is a historical record.

\`\`\`ts
const post = s.model({ author: s.manyToOne(() => user) });
\`\`\`
`;

describe("relation-language census: estate enumeration", () => {
  it("includes existing tracked and untracked files but excludes tracked deletions", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "viborm-census-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
      writeFileSync(
        join(repositoryRoot, "tracked.ts"),
        "const getRelationInfo = 1;\n"
      );
      writeFileSync(
        join(repositoryRoot, "deleted.ts"),
        "const oneToMany = 1;\n"
      );
      execFileSync("git", ["add", "tracked.ts", "deleted.ts"], {
        cwd: repositoryRoot,
      });
      unlinkSync(join(repositoryRoot, "deleted.ts"));
      writeFileSync(
        join(repositoryRoot, "untracked.ts"),
        "const setSource = 1;\n"
      );

      expect(collectRelationLanguageCensus(repositoryRoot)).toEqual({
        identifiers: [
          "tracked.ts getRelationInfo 1",
          "untracked.ts setSource 1",
        ],
        chains: [],
        retiredDiscriminants: [],
        text: [],
      });
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});

describe("relation-language census: source AST gate", () => {
  it("spells no retired relation identifier anywhere in the estate", () => {
    expect(census.identifiers).toEqual([]);
  });

  it("spells no retired capability on any factory-rooted chain", () => {
    expect(census.chains).toEqual([]);
  });

  it("spells no retired runtime membership discriminant", () => {
    expect(census.retiredDiscriminants).toEqual([]);
  });

  it("detects every executable role of the retired discriminant", () => {
    expect(
      sourceRetiredDiscriminantEntries(
        "witness/retired-discriminants.ts",
        RETIRED_DISCRIMINANT_WITNESS
      )
    ).toEqual([
      "witness/retired-discriminants.ts kindCase 1",
      "witness/retired-discriminants.ts kindComparison 1",
      "witness/retired-discriminants.ts kindConstruction 1",
      "witness/retired-discriminants.ts literalType 1",
      "witness/retired-discriminants.ts membershipOrientationReturn 1",
    ]);
  });

  it("bans exactly §12.4's symbols, and detects every one of them", () => {
    expect([...RETIRED_RELATION_SYMBOLS]).toEqual([...BANNED_SYMBOLS]);
    const witness = BANNED_SYMBOLS.map((symbol) => `const ${symbol} = 1;`).join(
      "\n"
    );
    expect(sourceIdentifierEntries("witness/ban-list.ts", witness)).toEqual(
      BANNED_SYMBOLS.map((symbol) => `witness/ban-list.ts ${symbol} 1`)
    );
  });

  it("counts executable identifiers only, and never a lookalike", () => {
    expect(
      sourceIdentifierEntries("witness/source-gate.ts", SOURCE_WITNESS)
    ).toEqual([
      "witness/source-gate.ts PolymorphicRelationState 1",
      "witness/source-gate.ts getRelationInfo 1",
      "witness/source-gate.ts manyToMany 1",
      "witness/source-gate.ts manyToOne 1",
      "witness/source-gate.ts oneToOne 1",
      "witness/source-gate.ts polymorphicToOne 1",
    ]);
  });

  it("counts retired capabilities only on an ordinary-factory-rooted chain", () => {
    expect(
      sourceChainEntries("witness/source-gate.ts", SOURCE_WITNESS)
    ).toEqual([
      "witness/source-gate.ts A 1",
      "witness/source-gate.ts B 1",
      "witness/source-gate.ts fields() 1",
      "witness/source-gate.ts optional 1",
      "witness/source-gate.ts unique 1",
    ]);
  });
});

describe("relation-language census: tracked-text gate", () => {
  it("spells no retired pattern outside the §12.4 allowlist", () => {
    expect(census.text).toEqual([]);
  });

  it("exempts a bannered historical plan, and needs both halves to do it", () => {
    expect(
      trackedTextEntries("docs/architecture/old-plan.md", BANNERED_PLAN_WITNESS)
    ).toEqual([]);
    // The banner alone does not exempt a file outside the plan directory,
    // and the plan directory alone does not exempt an unbannered file.
    expect(trackedTextEntries("README.md", BANNERED_PLAN_WITNESS)).toEqual([
      "README.md factoryCall 1",
    ]);
    expect(
      trackedTextEntries(
        "docs/architecture/old-plan.md",
        BANNERED_PLAN_WITNESS.replace("**Superseded relation spellings.**", "")
      )
    ).toEqual(["docs/architecture/old-plan.md factoryCall 1"]);
  });

  it("owns the comments and literals of a source file, not its executable calls", () => {
    expect(
      trackedTextEntries("witness/source-gate.ts", SOURCE_WITNESS)
    ).toEqual([
      "witness/source-gate.ts factoryCall 2",
      "witness/source-gate.ts junctionSideCall 1",
    ]);
  });

  it("matches calls, imports, and side tokens in prose assets", () => {
    expect(trackedTextEntries("witness/guide.md", MARKDOWN_WITNESS)).toEqual([
      "witness/guide.md factoryCall 1",
      "witness/guide.md junctionSideCall 1",
      "witness/guide.md namedImport 1",
    ]);
  });

  it("leaves Prisma-side identifiers and rendered prose alone", () => {
    expect(trackedTextEntries("witness/schema.prisma", PRISMA_WITNESS)).toEqual(
      []
    );
    expect(trackedTextEntries("witness/page.yml", DOM_CAPTURE_WITNESS)).toEqual(
      ["witness/page.yml factoryCall 1"]
    );
  });

  it("exempts one marked node of a census module, not the whole file", () => {
    expect(
      trackedTextEntries(
        "tests/fixtures/relation-language-census.ts",
        SELF_EXEMPTION_WITNESS
      )
    ).toEqual(["tests/fixtures/relation-language-census.ts factoryCall 1"]);
  });
});
