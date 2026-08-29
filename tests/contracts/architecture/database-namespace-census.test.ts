import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMITTED_DRIVER_OPTION_TYPES,
  ambientMysqlDatabaseEntries,
  attestationCopyEntries,
  attestationInferenceEntries,
  censusFiles,
  collectDatabaseNamespaceCensus,
  configurableSourceEntries,
  hardcodedPublicEntries,
  liveMigrationExecutorEntries,
  migrationContextExportEntries,
  modelScopeNamespaceEntries,
  POSTGRES_DEFAULT_NAMESPACE_OWNER,
  REJECTED_NAMESPACE_ALIASES,
  rejectedAliasMemberEntries,
  sessionRoutingEntries,
  sqliteAttachmentEntries,
} from "@tests/fixtures/database-namespace-census";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { describe, expect, it } from "vitest";

/**
 * The shipped-source census of the one database namespace representation
 * (`docs/architecture/database-namespace-plan.md` §9 Unit G).
 *
 * §9 asks for detectors covering the invariants "that behavior tests cannot
 * enumerate reliably". A behavior test proves what one code path does; these
 * prove that a SECOND path, a second spelling, or a second owner exists nowhere
 * in `src/**`. Detector semantics, regions, and disjointness live in
 * `tests/fixtures/database-namespace-census.ts`.
 *
 * An absence assertion is green for a converted estate and equally green for a
 * detector that matches nothing, so EVERY detector carries its own falsification
 * witness beside its assertion, and the alias ban list carries an independent
 * spelling of §13's rejected names that the detector's own constant must equal.
 *
 * Ten detectors assert zero. The eleventh names the admitted live-execution
 * owners, because live execution sites are not a thing the estate has none of:
 * what it pins is that they are exactly these and that no parallel driver path
 * stands beside them. Moving one re-pins the manifest in the same change.
 *
 * The file is an extended (non-`.core`) contract, so it runs in
 * `extended-local` under `pnpm test:all` — never inside a 30-second layer
 * budget, never in `package` or `provider-d1`, whose runtimes cannot spawn
 * `git` (`vitest.workspace.ts:64-75`).
 */

const census = collectDatabaseNamespaceCensus(REPOSITORY_ROOT);

/* ------------------------------------------------------------------ *
 * The pinned manifests
 * ------------------------------------------------------------------ */

/**
 * §4.1/§4.2: every PostgreSQL catalog operand is bound to the estate
 * namespace, so any hardcoded schema operand is a violation.
 */
const NO_HARDCODED_SCHEMA_OPERANDS: string[] = [];

/**
 * §5.2: every MySQL catalog read binds the resolved namespace, so any
 * ambient DATABASE() target is a violation.
 */
const NO_AMBIENT_DATABASE_TARGETS: string[] = [];

/**
 * §1.5: `MigrationContext` and `MigrationContextOptions` are internal with no
 * compatibility export, so any re-export is a violation.
 */
const NO_MIGRATION_CONTEXT_EXPORTS: string[] = [];

/**
 * §3.5: live migration execution runs on ONE pinned producer, and §12.13
 * forbids a parallel driver path. Every site named here executes on whatever
 * producer its caller hands it, which under a locked command is the pinned
 * session — including `context.ts`'s MySQL sequential-artifact arm, which must
 * not go through generic batch dispatch. `src/cli/commands/push.ts` and
 * `src/migrations/push/reset.ts` are absent because neither owns a drop program
 * of its own: the CLI holds confirmation and presentation, and `reset.ts`
 * reaches the one reset owner.
 */
const ADMITTED_LIVE_EXECUTION_OWNERS = [
  "src/migrations/context.ts executeRaw 3",
  "src/migrations/context.ts queryExecutorFactory 2",
  "src/migrations/foreign-keys.ts executeRaw 3",
  // §6.2's one live-namespace reset owner. Its statements run bare because
  // the committed-boundary bookkeeping lives with the CALLER's sequential
  // program (§6.3's one reporter in pinned-session.ts) — the clear is only
  // half of the program on both MySQL callers.
  "src/migrations/live-reset.ts executeRaw 4",
  "src/migrations/live-reset.ts queryExecutorFactory 1",
  // §3.5's pinned-session owner: target selection, the command-view catalog
  // read, and the sequential program's recording view. Exact-decimal migration
  // recovery adds two sites in THIS SAME owner: its catalog read and execution
  // of the recovery statements before the caller's program. Query executors
  // remain here too: strict-mode proof, pinned context, lock acquisition, and
  // lock release. The manifest counts sites so a new parallel path is red even
  // when it is added to an already admitted file.
  "src/migrations/pinned-session.ts executeRaw 5",
  "src/migrations/pinned-session.ts queryExecutorFactory 4",
  // The MySQL sequential arm executes beside the transactional arm (§3.5:
  // no manufactured atomicity), so the executor carries both spellings.
  "src/migrations/push/executor.ts executeRaw 3",
  "src/migrations/push/planner.ts executeRaw 2",
  "src/migrations/utils.ts executeRaw 1",
];

/* ------------------------------------------------------------------ *
 * Falsification witnesses
 * ------------------------------------------------------------------ */

/**
 * A spelled `USE`, an INTERPOLATED `USE`, a `SET search_path`, the same verbs in
 * prose, and the same verb in a comment. Only the three statements are
 * executable.
 *
 * The interpolated form is the shape the one shipped producer actually uses
 * (`mysqlSelectTargetStatement` builds `` `USE ${quoteIdentifier(name)}` ``), and
 * it is the shape a detector demanding a spelled identifier cannot see: a
 * template's head stops at the verb. The two prose controls end on the verb too
 * — one as a sentence, one as a template head — and neither may count, because
 * what makes a statement is the verb OPENING it.
 */
const SESSION_ROUTING_WITNESS = `const pin = "USE \`billing\`";
const selected = \`USE \${quoteIdentifier(namespace)}\`;
const path = 'SET LOCAL search_path TO "billing"';
const refusal = "A pooled connection may not USE another database";
const advice = \`This driver may not use \${database} here\`;
// SET search_path is refused at runtime; see plan section 13.
`;

/** One admitted owner path, used to prove the allowlist has two halves. */
const PINNED_SESSION_OWNER_WITNESS_PATH =
  "src/migrations/drivers/mysql/pinned-session.ts";

/**
 * A hardcoded SQL operand, a bare default value, and two lookalikes that must
 * survive: a longer word and a qualified name that merely contains `public`.
 */
const HARDCODED_PUBLIC_WITNESS = `const introspect = "SELECT 1 FROM pg_tables WHERE schemaname = 'public'";
const fallback = "public";
const unrelated = "publication";
const qualified = "namespace.public_table";
`;

/** The ambient catalog target, a bound alternative, and a same-named method. */
const AMBIENT_DATABASE_WITNESS = `const ambient = "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()";
const bound = "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?";
const method = provider.database();
// DATABASE() is the ambient default this gate forbids.
`;

/** Every member role an alias can occupy, plus a prose spelling and a comment. */
const REJECTED_ALIAS_WITNESS = `interface LegacyOptions {
  databaseSchema?: string;
  pgSchema?: string;
}
const held = { databaseName: "app", keyspace: "billing" };
adapter.searchPath = "billing";
const prose = "databaseNamespace is rejected";
// keyspace is rejected too.
`;

/** Two state declarations and one legitimate physical read. */
const MODEL_SCOPE_WITNESS = `interface ModelState {
  namespace?: string;
}
const scope = { namespace: "billing" };
const rendered = adapter.namespace;
`;

/** One admitted option type, two second sources, and one unowned local. */
const CONFIGURABLE_SOURCE_WITNESS = `export interface PgDriverOptions {
  namespace?: string;
}
export interface VibORMConfig {
  namespace?: string;
}
export interface CacheDriverOptions {
  namespace?: string;
}
const local = { namespace: "billing" };
`;

/** Both attachment statement forms, both banned members, and a lookalike word. */
const SQLITE_ATTACHMENT_WITNESS = `export interface SQLite3DriverOptions {
  attachment?: string;
  namespace?: string;
}
const open = "ATTACH DATABASE ? AS aux";
const close = "DETACH DATABASE aux";
const unrelated = "attachments are a different feature";
// ATTACH DATABASE is deliberately unsupported.
`;

/** Transport inference, class inference, and the admitted pass-through. */
const ATTESTATION_INFERENCE_WITNESS = `const migrationNamespaceAttestation =
  serverVersion.startsWith("8.") ? "non-redirecting" : undefined;
driver.migrationNamespaceAttestation =
  pool instanceof DirectPool ? "non-redirecting" : undefined;
const passthrough = { migrationNamespaceAttestation: normalized };
`;

/** One command-option declaration and one admitted consumption. */
const ATTESTATION_COPY_WITNESS = `export interface ApplyFullOptions {
  migrationNamespaceAttestation?: "non-redirecting";
}
const admitted = context.driver.migrationNamespaceAttestation;
`;

/** Both laundering routes, one unrelated re-export, and the legal local export. */
const MIGRATION_CONTEXT_EXPORT_WITNESS = `export { MigrationContext } from "./context";
export type { MigrationContextOptions } from "./context";
export * from "./context";
export { MigrationDriver } from "./drivers";
export class MigrationContext {}
`;

/** Two driver primitives, one factory, and one consumer of the single owner. */
const LIVE_EXECUTOR_WITNESS = `await driver._executeRaw(ddl);
await tx._executeRaw(sql, params);
const executor = createQueryExecutor(driver);
await context.executeRaw(sql);
`;

/**
 * §13's rejected dialect-native spellings, written INDEPENDENTLY of the
 * detector's own constant. A zero census is green for a clean estate and
 * equally green for a ban list that misspells a name, and a witness generated
 * from the list itself would agree with its own typo — so the list needs one
 * spelling that does not come from it.
 */
const REJECTED_ALIAS_SPELLINGS = [
  "databaseName",
  "databaseNamespace",
  "databaseSchema",
  "keyspace",
  "pgSchema",
  "searchPath",
];

/** §1.1's seven option types, spelled independently for the same reason. */
const ADMITTED_OPTION_TYPE_SPELLINGS = [
  "BunSQLDriverOptions",
  "MySQL2DriverOptions",
  "NeonHTTPDriverOptions",
  "PGliteDriverOptions",
  "PgDriverOptions",
  "PlanetScaleDriverOptions",
  "PostgresDriverOptions",
];

/* ------------------------------------------------------------------ *
 * Estate enumeration
 * ------------------------------------------------------------------ */

describe("database-namespace census: estate enumeration", () => {
  it("censuses shipped source only, including untracked, excluding deletions", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "viborm-ns-census-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
      execFileSync("git", ["config", "user.email", "census@example.test"], {
        cwd: repositoryRoot,
      });
      execFileSync("git", ["config", "user.name", "census"], {
        cwd: repositoryRoot,
      });
      execFileSync("mkdir", ["-p", join(repositoryRoot, "src", "drivers")]);
      execFileSync("mkdir", ["-p", join(repositoryRoot, "tests")]);
      writeFileSync(join(repositoryRoot, "src", "tracked.ts"), "export {};\n");
      writeFileSync(join(repositoryRoot, "src", "deleted.ts"), "export {};\n");
      writeFileSync(join(repositoryRoot, "src", "AGENTS.md"), "prose\n");
      writeFileSync(
        join(repositoryRoot, "tests", "outside.ts"),
        "export {};\n"
      );
      execFileSync(
        "git",
        [
          "add",
          "src/tracked.ts",
          "src/deleted.ts",
          "src/AGENTS.md",
          "tests/outside.ts",
        ],
        { cwd: repositoryRoot }
      );
      unlinkSync(join(repositoryRoot, "src", "deleted.ts"));
      writeFileSync(
        join(repositoryRoot, "src", "drivers", "untracked.ts"),
        "export {};\n"
      );

      expect(censusFiles(repositoryRoot)).toEqual([
        "src/drivers/untracked.ts",
        "src/tracked.ts",
      ]);
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Detector 1 — runtime session routing
 * ------------------------------------------------------------------ */

describe("database-namespace census: runtime session routing", () => {
  it("emits no runtime SET search_path and no USE statement", () => {
    expect(census.sessionRouting).toEqual([]);
  });

  it("detects both statements, ignores prose, and exempts only the pinned owner", () => {
    // Two `USE` statements — one spelled, one interpolated — and neither prose
    // spelling, which is what keeps the count at two rather than four.
    expect(
      sessionRoutingEntries(
        "src/drivers/mysql2/index.ts",
        SESSION_ROUTING_WITNESS
      )
    ).toEqual([
      "src/drivers/mysql2/index.ts setSearchPath 1",
      "src/drivers/mysql2/index.ts useDatabase 2",
    ]);
    // The allowlist exempts `USE` for one named module and nothing else: BOTH
    // spellings go quiet for the owner, and the same module still cannot mutate
    // the PostgreSQL search path.
    expect(
      sessionRoutingEntries(
        PINNED_SESSION_OWNER_WITNESS_PATH,
        SESSION_ROUTING_WITNESS,
        [PINNED_SESSION_OWNER_WITNESS_PATH]
      )
    ).toEqual([`${PINNED_SESSION_OWNER_WITNESS_PATH} setSearchPath 1`]);
  });

  it("reads the pinned owner's OWN interpolated USE, so the allowlist is live", () => {
    // The two halves of the allowlist, over the real shipped source rather than
    // a witness: exempted the owner contributes nothing, and un-exempted it
    // contributes exactly the one `USE` it is exempted for. Without this, the
    // owner's entry is a declaration that guards nothing — which is what it was
    // until the detector learned to read a template head.
    const owner = readFileSync(
      join(REPOSITORY_ROOT, PINNED_SESSION_OWNER_WITNESS_PATH),
      "utf8"
    );

    expect(
      sessionRoutingEntries(PINNED_SESSION_OWNER_WITNESS_PATH, owner, [
        PINNED_SESSION_OWNER_WITNESS_PATH,
      ])
    ).toEqual([]);
    expect(
      sessionRoutingEntries(PINNED_SESSION_OWNER_WITNESS_PATH, owner, [])
    ).toEqual([`${PINNED_SESSION_OWNER_WITNESS_PATH} useDatabase 1`]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 2 — hardcoded PostgreSQL schema
 * ------------------------------------------------------------------ */

describe("database-namespace census: hardcoded PostgreSQL schema", () => {
  it("spells no hardcoded schema operand anywhere in src", () => {
    expect(census.hardcodedPublic).toEqual(NO_HARDCODED_SCHEMA_OPERANDS);
  });

  it("separates the SQL operand from the adapter default, and skips lookalikes", () => {
    expect(
      hardcodedPublicEntries(
        "src/migrations/drivers/postgres/introspect.ts",
        HARDCODED_PUBLIC_WITNESS
      )
    ).toEqual([
      "src/migrations/drivers/postgres/introspect.ts defaultPublicValue 1",
      "src/migrations/drivers/postgres/introspect.ts sqlPublicLiteral 1",
    ]);
    // The one owner may spell the default value; nobody may spell the operand.
    expect(
      hardcodedPublicEntries(
        POSTGRES_DEFAULT_NAMESPACE_OWNER,
        HARDCODED_PUBLIC_WITNESS
      )
    ).toEqual([`${POSTGRES_DEFAULT_NAMESPACE_OWNER} sqlPublicLiteral 1`]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 3 — MySQL ambient database
 * ------------------------------------------------------------------ */

describe("database-namespace census: MySQL ambient database", () => {
  it("targets no ambient DATABASE() anywhere in src", () => {
    expect(census.ambientMysqlDatabase).toEqual(NO_AMBIENT_DATABASE_TARGETS);
  });

  it("counts the SQL function only, never a comment or a same-named method", () => {
    expect(
      ambientMysqlDatabaseEntries(
        "src/migrations/drivers/mysql/introspect.ts",
        AMBIENT_DATABASE_WITNESS
      )
    ).toEqual([
      "src/migrations/drivers/mysql/introspect.ts databaseFunction 1",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 4 — rejected alias members
 * ------------------------------------------------------------------ */

describe("database-namespace census: rejected alias members", () => {
  it("declares no rejected dialect-native alias anywhere in shipped source", () => {
    expect(census.rejectedAliasMembers).toEqual([]);
  });

  it("bans exactly section 13's spellings, and detects every member role", () => {
    expect([...REJECTED_NAMESPACE_ALIASES]).toEqual(REJECTED_ALIAS_SPELLINGS);
    expect([...ADMITTED_DRIVER_OPTION_TYPES]).toEqual(
      ADMITTED_OPTION_TYPE_SPELLINGS
    );
    expect(
      rejectedAliasMemberEntries(
        "src/drivers/pg/index.ts",
        REJECTED_ALIAS_WITNESS
      )
    ).toEqual([
      "src/drivers/pg/index.ts databaseName 1",
      "src/drivers/pg/index.ts databaseSchema 1",
      "src/drivers/pg/index.ts keyspace 1",
      "src/drivers/pg/index.ts pgSchema 1",
      "src/drivers/pg/index.ts searchPath 1",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 5 — model and query-scope state
 * ------------------------------------------------------------------ */

describe("database-namespace census: model and query-scope state", () => {
  it("keeps the namespace out of model and query-scope state", () => {
    expect(census.modelScopeNamespace).toEqual([]);
  });

  it("counts state declarations in those regions only, never a physical read", () => {
    expect(
      modelScopeNamespaceEntries("src/schema/model.ts", MODEL_SCOPE_WITNESS)
    ).toEqual(["src/schema/model.ts stateMember 2"]);
    expect(
      modelScopeNamespaceEntries(
        "src/adapters/database-adapter.ts",
        MODEL_SCOPE_WITNESS
      )
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 6 — second configurable source
 * ------------------------------------------------------------------ */

describe("database-namespace census: second configurable source", () => {
  it("configures the namespace from the seven driver option types only", () => {
    expect(census.configurableSources).toEqual([]);
  });

  it("admits the seven, counts every other option type, and yields its regions", () => {
    expect(
      configurableSourceEntries(
        "src/client/client.ts",
        CONFIGURABLE_SOURCE_WITNESS
      )
    ).toEqual(["src/client/client.ts optionMember 2"]);
    // Model/query-scope belongs to detector 5, so no occurrence is counted twice.
    expect(
      configurableSourceEntries(
        "src/schema/model.ts",
        CONFIGURABLE_SOURCE_WITNESS
      )
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 7 — SQLite attachment surface
 * ------------------------------------------------------------------ */

describe("database-namespace census: SQLite attachment surface", () => {
  it("exposes no attachment statement, alias, or SQLite namespace option", () => {
    expect(census.sqliteAttachment).toEqual([]);
  });

  it("bans the statement estate-wide and the members on SQLite surfaces only", () => {
    expect(
      sqliteAttachmentEntries(
        "src/drivers/sqlite3/index.ts",
        SQLITE_ATTACHMENT_WITNESS
      )
    ).toEqual([
      "src/drivers/sqlite3/index.ts attachStatement 2",
      "src/drivers/sqlite3/index.ts attachmentMember 1",
      "src/drivers/sqlite3/index.ts sqliteNamespaceMember 1",
    ]);
    expect(
      sqliteAttachmentEntries(
        "src/drivers/pg/index.ts",
        SQLITE_ATTACHMENT_WITNESS
      )
    ).toEqual(["src/drivers/pg/index.ts attachStatement 2"]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 8 — attestation inference
 * ------------------------------------------------------------------ */

describe("database-namespace census: attestation inference", () => {
  it("derives the attestation from no transport, class, or target evidence", () => {
    expect(census.attestationInference).toEqual([]);
  });

  it("counts inference in a producer's value, and lets a pass-through through", () => {
    expect(
      attestationInferenceEntries(
        "src/drivers/mysql2/index.ts",
        ATTESTATION_INFERENCE_WITNESS
      )
    ).toEqual([
      "src/drivers/mysql2/index.ts classInference 1",
      "src/drivers/mysql2/index.ts transportInference 1",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 9 — attestation copies
 * ------------------------------------------------------------------ */

describe("database-namespace census: attestation copies", () => {
  it("copies the attestation into no adapter, journal, cache, or command option", () => {
    expect(census.attestationCopies).toEqual([]);
  });

  it("counts a declaration per forbidden region, and never a consumption", () => {
    expect(
      attestationCopyEntries(
        "src/migrations/apply/index.ts",
        ATTESTATION_COPY_WITNESS
      )
    ).toEqual(["src/migrations/apply/index.ts commandOption 1"]);
    expect(
      attestationCopyEntries(
        "src/adapters/database-adapter.ts",
        ATTESTATION_COPY_WITNESS
      )
    ).toEqual(["src/adapters/database-adapter.ts forbiddenOwner 1"]);
    // The driver that OWNS the fact declares it, and stays green.
    expect(
      attestationCopyEntries(
        "src/drivers/mysql2/index.ts",
        ATTESTATION_COPY_WITNESS
      )
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 10 — MigrationContext export surface
 * ------------------------------------------------------------------ */

describe("database-namespace census: MigrationContext export surface", () => {
  it("re-exports no context surface anywhere in src", () => {
    expect(census.migrationContextExports).toEqual(
      NO_MIGRATION_CONTEXT_EXPORTS
    );
  });

  it("counts both laundering routes, and leaves the module-local export alone", () => {
    expect(
      migrationContextExportEntries(
        "src/migrations/index.ts",
        MIGRATION_CONTEXT_EXPORT_WITNESS
      )
    ).toEqual([
      "src/migrations/index.ts reexport:MigrationContext 1",
      "src/migrations/index.ts reexport:MigrationContextOptions 1",
      "src/migrations/index.ts starReexport 1",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Detector 11 — live migration executors
 * ------------------------------------------------------------------ */

describe("database-namespace census: live migration executors", () => {
  it("opens no live execution site outside the admitted owners", () => {
    expect(census.liveMigrationExecutors).toEqual(
      ADMITTED_LIVE_EXECUTION_OWNERS
    );
  });

  it("counts driver primitives in migration regions, never a context consumer", () => {
    expect(
      liveMigrationExecutorEntries(
        "src/migrations/apply/index.ts",
        LIVE_EXECUTOR_WITNESS
      )
    ).toEqual([
      "src/migrations/apply/index.ts executeRaw 2",
      "src/migrations/apply/index.ts queryExecutorFactory 1",
    ]);
    expect(
      liveMigrationExecutorEntries(
        "src/drivers/mysql2/index.ts",
        LIVE_EXECUTOR_WITNESS
      )
    ).toEqual([]);
  });
});
