import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { decodeCanonicalBase64, encodeBase64 } from "@src/migrations/base64";
import { normalizeDownOptions } from "@src/migrations/down-input";
import { normalizeGenerateOptions } from "@src/migrations/generate-input";
import {
  assertAcceptedPlan,
  assertConsent,
  hasConsent,
  parseConsent,
  parsePlanningOptions,
  snapshotPushOptions,
} from "@src/migrations/push-consent";
import { pushV1 } from "@src/migrations/push-v1";
import type { PushConsent, PushTargetIdentity } from "@src/migrations/v1-types";
import { describe, expect, it, vi } from "vitest";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function sqliteConsent(): PushConsent {
  return {
    format: "1",
    target: { dialect: "sqlite", location: null, bindingId: "local" },
    planHash: HASH_A,
    mode: "diff",
    validation: "full",
    resolutions: [{ id: "rename:user", decision: "proceed" }],
  };
}

function consentedPlan() {
  const target: PushTargetIdentity = {
    dialect: "sqlite",
    location: null,
    bindingId: "local",
  };
  return Object.freeze({
    mode: "diff",
    validation: "full",
    target,
    sourceFingerprint: HASH_B,
    planHash: HASH_A,
    resolutions: Object.freeze([
      Object.freeze({ id: "rename:user", decision: "proceed" }),
    ]),
  });
}

describe("migration hostile-input boundaries", () => {
  it("round-trips canonical base64 without a runtime-specific codec", () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0]),
      new Uint8Array([0, 255]),
      new Uint8Array([0, 127, 128]),
      new Uint8Array([0, 1, 2, 3]),
    ]) {
      const encoded = encodeBase64(bytes);
      expect(decodeCanonicalBase64(encoded)).toEqual(bytes);
    }

    expect(decodeCanonicalBase64("A===")).toBeUndefined();
    expect(decodeCanonicalBase64("AB==")).toBeUndefined();
    expect(decodeCanonicalBase64("AA=A")).toBeUndefined();
  });

  it("normalizes one immutable down selector", () => {
    expect(normalizeDownOptions({})).toEqual({ steps: 1, dryRun: false });
    expect(normalizeDownOptions({ steps: 2, dryRun: true })).toEqual({
      steps: 2,
      dryRun: true,
    });
    for (const to of [
      { id: HASH_A },
      { prefix: "a2617f" },
      { name: "release" },
    ]) {
      const normalized = normalizeDownOptions({ to });
      expect(normalized).toEqual({ steps: 1, to, dryRun: false });
      expect(Object.isFrozen(normalized)).toBe(true);
      expect(normalized.to).not.toBe(to);
    }
  });

  /**
   * `"id" in record` walks the prototype chain, so a polluted
   * `Object.prototype.id` once made `down({ to: { name: "baseline" } })` select
   * the inherited id and roll back to the WRONG state. Only the caller's own
   * key names a selector. The pollution window is closed synchronously in
   * `finally`, before any assertion, so no other suite can observe it.
   */
  it.each([
    ["id", HASH_A],
    ["prefix", "a2617f"],
  ])("resolves the own name selector while Object.prototype.%s is polluted", (key, value) => {
    Object.defineProperty(Object.prototype, key, {
      value,
      configurable: true,
    });
    let selector: unknown;
    try {
      selector = normalizeDownOptions({ to: { name: "baseline" } }).to;
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }

    expect(selector).toEqual({ name: "baseline" });
    expect(Object.hasOwn(Object.prototype, key)).toBe(false);
  });

  it("reads each down option once and detaches the selector", () => {
    let reads = 0;
    const selector = { name: "release" };
    const options = Object.defineProperty({}, "to", {
      enumerable: true,
      get() {
        reads += 1;
        return selector;
      },
    });

    const normalized = normalizeDownOptions(options);
    selector.name = "mutated";

    expect(reads).toBe(1);
    expect(normalized.to).toEqual({ name: "release" });
  });

  it.each([
    [{ steps: 1, to: { id: HASH_A } }, "either steps or to"],
    [{ steps: 0 }, "positive safe integer"],
    [{ steps: Number.MAX_SAFE_INTEGER + 1 }, "positive safe integer"],
    [{ dryRun: "yes" }, "dryRun must be a boolean"],
    [{ to: {} }, "exactly one selector key"],
    [{ to: { id: HASH_A, name: "release" } }, "exactly one selector key"],
    [{ to: { prefix: "" } }, "must be a non-empty string"],
  ])("refuses an invalid down shape %#", (value, message) => {
    expect(() => normalizeDownOptions(value)).toThrow(message);
  });

  it("snapshots generation inputs before asynchronous work can observe mutation", () => {
    const statements = [sql.raw("SELECT 1")];
    const transitions = [
      {
        from: null,
        execution: "transactional",
        up: statements,
        rollback: {
          kind: "irreversible",
          reason: "the source data is unavailable",
        },
      },
    ];
    const options = {
      name: "release",
      dryRun: true,
      skipValidation: true,
      manualMigration: { transitions },
    };

    const normalized = normalizeGenerateOptions(options);
    options.name = "mutated";
    statements.push(sql.raw("SELECT 2"));
    transitions.push({
      from: null,
      execution: "transactional",
      up: [],
      rollback: {
        kind: "irreversible",
        reason: "mutated",
      },
    });

    expect(normalized.name).toBe("release");
    expect(normalized.manualMigration?.transitions).toHaveLength(1);
    expect(normalized.manualMigration?.transitions[0]?.up).toHaveLength(1);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.manualMigration?.transitions)).toBe(true);
  });

  it("detaches complete manual checks and rollback programs", () => {
    const destinationChecks = [
      { kind: "trusted-read" as const, query: sql`SELECT ${1}`, equals: true },
    ];
    const originChecks = [
      { kind: "trusted-read" as const, query: sql`SELECT ${0}`, equals: false },
    ];
    const rollbackSql = [sql`DELETE FROM ledger WHERE id = ${"old"}`];
    const normalized = normalizeGenerateOptions({
      from: HASH_A,
      resolve: () => undefined,
      manualMigration: {
        destinationChecks,
        transitions: [
          {
            from: HASH_A,
            execution: "stepwise",
            up: [sql`INSERT INTO ledger (id) VALUES (${"new"})`],
            originChecks,
            rollback: {
              kind: "manual",
              execution: "transactional",
              sql: rollbackSql,
            },
          },
        ],
      },
    });

    destinationChecks.length = 0;
    originChecks.length = 0;
    rollbackSql.length = 0;

    expect(normalized.from).toBe(HASH_A);
    expect(normalized.resolve).toBeTypeOf("function");
    expect(normalized.manualMigration?.destinationChecks).toHaveLength(1);
    expect(
      normalized.manualMigration?.transitions[0]?.originChecks
    ).toHaveLength(1);
    expect(normalized.manualMigration?.transitions[0]?.rollback).toMatchObject({
      kind: "manual",
      execution: "transactional",
      sql: [expect.objectContaining({ values: ["old"] })],
    });
  });

  it("translates unreadable generation arrays to a typed migration failure", () => {
    const failure = new Error("iterator unavailable");
    const transitions = new Proxy([], {
      get(target, key, receiver) {
        if (key === Symbol.iterator) throw failure;
        return Reflect.get(target, key, receiver);
      },
    });

    expect(() =>
      normalizeGenerateOptions({ manualMigration: { transitions } })
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        originalCause: expect.objectContaining({
          message: "Underlying error details redacted",
          name: failure.name,
        }),
      })
    );
  });

  it("snapshots planning options and invokes the admitted resolver", () => {
    const resolve = vi.fn(() => undefined);
    const options = {
      dryRun: false,
      forceReset: true,
      skipValidation: true,
      resolve,
    };
    const parsed = parsePlanningOptions(options, true);
    options.forceReset = false;

    expect(parsed).toMatchObject({
      dryRun: true,
      forceReset: true,
      skipValidation: true,
    });
    expect(parsed.resolve).toBeDefined();
    if (parsed.resolve) {
      Reflect.apply(parsed.resolve, undefined, [{ type: "destructive" }]);
    }
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("reads public push options once before selecting the command path", () => {
    let reads = 0;
    const options = Object.defineProperty({}, "dryRun", {
      enumerable: true,
      get() {
        reads += 1;
        return true;
      },
    });

    const snapshot = snapshotPushOptions(options);
    expect(reads).toBe(1);
    expect(snapshot).toEqual({ dryRun: true });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("settles a public push option before command routing", async () => {
    let reads = 0;
    const options = Object.defineProperty({}, "dryRun", {
      enumerable: true,
      get() {
        reads += 1;
        return "yes";
      },
    });

    const pushed = Reflect.apply(pushV1, undefined, [undefined, options]);
    await expect(pushed).rejects.toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      message: "push options.dryRun must be boolean",
    });
    expect(reads).toBe(1);
  });

  it("translates unreadable push options to INVALID_INPUT", () => {
    const failure = new Error("options getter failed");
    const options = Object.defineProperty({}, "dryRun", {
      enumerable: true,
      get() {
        throw failure;
      },
    });

    expect(() => parsePlanningOptions(options, false)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.INVALID_INPUT,
        originalCause: expect.objectContaining({
          message: "Underlying error details redacted",
          name: failure.name,
        }),
      })
    );
  });

  it("translates an uninspectable option record to INVALID_INPUT", () => {
    const failure = new Error("option keys unavailable");
    const options = new Proxy(
      {},
      {
        ownKeys() {
          throw failure;
        },
      }
    );

    expect(() => snapshotPushOptions(options)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.INVALID_INPUT,
        originalCause: expect.objectContaining({
          message: "Underlying error details redacted",
          name: failure.name,
        }),
      })
    );
  });

  it.each([
    [{ dryRun: "yes" }, "dryRun must be boolean"],
    [{ forceReset: "yes" }, "forceReset must be boolean"],
    [{ skipValidation: "yes" }, "skipValidation must be boolean"],
    [{ resolve: "later" }, "resolve must be a function"],
    [{ force: true }, "contains unknown key force"],
  ])("refuses an invalid push option shape %#", (value, message) => {
    expect(() => parsePlanningOptions(value, false)).toThrow(message);
  });

  it("parses and detaches consent for every database target", () => {
    const targets: PushTargetIdentity[] = [
      {
        dialect: "postgresql",
        database: "app",
        namespace: "tenant",
        bindingId: "pg",
      },
      { dialect: "mysql", database: "app", bindingId: "mysql" },
      { dialect: "sqlite", location: null, bindingId: "sqlite" },
    ];

    for (const target of targets) {
      const resolution = { id: "rename:user", decision: "proceed" };
      const resolutions = [resolution];
      const parsed = parseConsent({ ...sqliteConsent(), target, resolutions });
      resolution.decision = "reject";
      expect(parsed.target).toEqual(target);
      expect(parsed.resolutions[0]?.decision).toBe("proceed");
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.target)).toBe(true);
      expect(Object.isFrozen(parsed.resolutions)).toBe(true);
    }
  });

  it("translates unreadable consent to CONSENT_MISMATCH", () => {
    const failure = new Error("consent getter failed");
    const consent = Object.defineProperty({}, "format", {
      enumerable: true,
      get() {
        throw failure;
      },
    });

    expect(() => parseConsent(consent)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
        originalCause: expect.objectContaining({
          message: "Underlying error details redacted",
          name: failure.name,
        }),
      })
    );
  });

  it("translates unreadable target fields to CONSENT_MISMATCH", () => {
    const failure = new Error("target getter failed");
    const target = Object.defineProperty({}, "dialect", {
      enumerable: true,
      get() {
        throw failure;
      },
    });

    expect(() => parseConsent({ ...sqliteConsent(), target })).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
        originalCause: expect.objectContaining({
          message: "Underlying error details redacted",
          name: failure.name,
        }),
      })
    );
  });

  it("checks the accepted plan and consent against the locked replan", () => {
    const plan = consentedPlan();
    const consent = sqliteConsent();
    expect(() => assertAcceptedPlan(plan, plan)).not.toThrow();
    expect(() => assertConsent(consent, plan)).not.toThrow();

    expect(() =>
      assertAcceptedPlan(plan, { ...plan, sourceFingerprint: HASH_A })
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
        message: "The live push plan changed before the locked replan",
      })
    );
    expect(() =>
      assertConsent(consent, { ...plan, planHash: HASH_B })
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
        meta: expect.objectContaining({
          expectedChecksum: HASH_A,
          actualChecksum: HASH_B,
        }),
      })
    );
    expect(hasConsent(snapshotPushOptions({ consent }))).toBe(true);
    expect(hasConsent(snapshotPushOptions({ dryRun: true }))).toBe(false);
  });
});

describe("coverage low value", () => {
  it("pins exact-record key refusals", () => {
    expect(() => snapshotPushOptions({ [Symbol("dryRun")]: true })).toThrow(
      "contains unknown key Symbol(dryRun)"
    );
    expect(() => snapshotPushOptions([])).toThrow("must be an object");
    expect(() =>
      parseConsent({
        ...sqliteConsent(),
        target: {
          dialect: "mysql",
          database: "app",
          bindingId: "mysql",
          location: null,
        },
      })
    ).toThrow("contains unknown key location");
  });

  it("pins the remaining consent discriminant refusals", () => {
    for (const consent of [
      { ...sqliteConsent(), format: "2" },
      { ...sqliteConsent(), mode: "unknown" },
      { ...sqliteConsent(), validation: "partial" },
      { ...sqliteConsent(), planHash: "not-a-hash" },
      { ...sqliteConsent(), resolutions: "none" },
      {
        ...sqliteConsent(),
        resolutions: [{ id: 1, decision: "proceed" }],
      },
      { ...sqliteConsent(), target: null },
      { ...sqliteConsent(), target: { dialect: "oracle" } },
      {
        ...sqliteConsent(),
        target: { dialect: "sqlite", location: 1, bindingId: "sqlite" },
      },
      {
        ...sqliteConsent(),
        target: { dialect: "mysql", database: "", bindingId: "mysql" },
      },
    ]) {
      expect(() => parseConsent(consent)).toThrowError(
        expect.objectContaining({
          code: VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
        })
      );
    }
  });
});
