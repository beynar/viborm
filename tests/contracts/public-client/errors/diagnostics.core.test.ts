import {
  attachRecordSeriesProgress,
  getTrustedErrorCause,
  getTrustedRecordSeriesProgress,
  hasCommittedRecordSeriesProgress,
  hasRecordSeriesProgress,
  QueryEngineError,
  registerTrustedError,
  registerTrustedRecordSeriesProgress,
  type RecordSeriesProgress,
  resolveDiagnosticDisclosure,
  sanitizeDiagnosticParameters,
  sanitizeErrorCause,
  sanitizeErrorForLogging,
  sanitizeErrorMetadata,
  sanitizeLogMetadata,
  sanitizeRecordSeriesProgress,
  serializeSanitizedError,
  serializeTrustedError,
  UniqueConstraintError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import {
  boundTrustedString,
  createSafeRecord,
  defineHidden,
  defineSafe,
  filterSafeErrorProperty,
  freezeDiagnosticValue,
  getNestedCause,
  isArrayValue,
  isError,
  isRecord,
  safeArrayLength,
  safeDateString,
  safeErrorString,
  safeHasOwn,
  safeOwnPropertyDescriptor,
  safeRead,
  sanitizeBytes,
  sanitizeProviderCode,
  sanitizeProviderErrno,
  sanitizeProviderStatus,
  sanitizeSqlState,
  sanitizeString,
  sanitizeTrustedCode,
  sanitizeTrustedPrismaCode,
  toError,
  TRUNCATED_DIAGNOSTIC_VALUE,
  UNREADABLE_DIAGNOSTIC_VALUE,
} from "@src/errors/diagnostic-safety";

describe("diagnostic disclosure contracts", () => {
  it("defaults closed and admits only explicit disclosure flags", () => {
    expect(resolveDiagnosticDisclosure()).toEqual({
      includeParams: false,
      includeSql: false,
    });
    expect(
      resolveDiagnosticDisclosure({ includeParams: true, includeSql: true })
    ).toEqual({ includeParams: true, includeSql: true });

    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("unreadable disclosure");
        },
      }
    );
    expect(resolveDiagnosticDisclosure(hostile)).toEqual({
      includeParams: false,
      includeSql: false,
    });
  });

  it("keeps only declared metadata with valid domain values", () => {
    const progress: RecordSeriesProgress = {
      atomicity: "segment",
      phase: "member",
      committedSegments: 1,
      completedMembers: 2,
      committedWriteMembers: 1,
      mayHaveCommittedSegment: true,
      memberPath: [0, 2],
      totalMembers: 4,
    };
    const input = {
      autoIncrement: true,
      columns: ["id", "tenantId"],
      commitCertainty: "may-have-committed",
      model: "user",
      params: ["secret"],
      providerCode: "SQLITE_BUSY",
      providerErrno: 19,
      providerSqlState: "23505",
      providerStatus: 503,
      query: "SELECT 1",
      recordSeriesProgress: progress,
      timeout: 10,
      token: "must not escape",
    };

    expect(sanitizeErrorMetadata(input)).toEqual({
      autoIncrement: true,
      columns: ["id", "tenantId"],
      commitCertainty: "may-have-committed",
      model: "user",
      providerCode: "SQLITE_BUSY",
      providerErrno: 19,
      providerSqlState: "23505",
      providerStatus: 503,
      recordSeriesProgress: progress,
      timeout: 10,
    });
    expect(
      sanitizeErrorMetadata(input, { includeParams: true, includeSql: true })
    ).toEqual({
      autoIncrement: true,
      columns: ["id", "tenantId"],
      commitCertainty: "may-have-committed",
      model: "user",
      params: ["secret"],
      providerCode: "SQLITE_BUSY",
      providerErrno: 19,
      providerSqlState: "23505",
      providerStatus: 503,
      query: "SELECT 1",
      recordSeriesProgress: progress,
      timeout: 10,
    });

    expect(
      sanitizeErrorMetadata({
        autoIncrement: "yes",
        columns: "id",
        commitCertainty: "unknown",
        params: "secret",
        query: 1,
        timeout: -1,
      })
    ).toEqual({});

    const sparseColumns = Array<string>(1);
    expect(sanitizeErrorMetadata({ columns: sparseColumns })).toEqual({});
    expect(sanitizeErrorMetadata({ columns: [1] })).toEqual({});
  });

  it("validates logging events and statuses independently", () => {
    expect(
      sanitizeLogMetadata({
        deprecation: "use the extension API",
        event: "hit",
        status: "success",
      })
    ).toEqual({
      deprecation: "use the extension API",
      event: "hit",
      status: "success",
    });
    expect(
      sanitizeLogMetadata({
        deprecation: 1,
        event: "unknown",
        status: "pending",
      })
    ).toEqual({});
  });

  it("sanitizes the complete parameter value vocabulary", () => {
    const circular: Record<string, unknown> = { id: 1 };
    circular.self = circular;
    const bytes = new Uint8Array([1, 2, 3]);
    const parameters = sanitizeDiagnosticParameters([
      null,
      2,
      true,
      3n,
      undefined,
      Symbol("marker"),
      () => "hidden",
      new Date("2020-01-02T03:04:05.006Z"),
      new Date(Number.NaN),
      bytes.buffer,
      new DataView(bytes.buffer),
      circular,
      new Error("provider secret"),
    ]);

    expect(parameters.slice(0, 9)).toEqual([
      null,
      2,
      true,
      "3",
      "[Undefined]",
      "Symbol(marker)",
      "[Function]",
      "2020-01-02T03:04:05.006Z",
      "[Invalid Date]",
    ]);
    expect(parameters[9]).toMatchObject({
      byteLength: 3,
      bytes: [1, 2, 3],
      type: "binary",
    });
    expect(parameters[10]).toMatchObject({
      byteLength: 3,
      bytes: [1, 2, 3],
      type: "binary",
    });
    expect(parameters[11]).toEqual({ id: 1, self: "[Circular]" });
    expect(parameters[12]).toMatchObject({
      message: "Underlying error details redacted",
      name: "Error",
    });
  });

  it("bounds parameter arrays, depth, entries, and unreadable elements", () => {
    const overlong = sanitizeDiagnosticParameters(
      Array.from({ length: 129 }, (_, index) => index)
    );
    expect(overlong).toHaveLength(129);
    expect(overlong.at(-1)).toBe(TRUNCATED_DIAGNOSTIC_VALUE);

    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 10; depth += 1) {
      nested = { nested };
    }
    expect(JSON.stringify(sanitizeDiagnosticParameters([nested]))).toContain(
      TRUNCATED_DIAGNOSTIC_VALUE
    );

    const unreadable: unknown[] = [];
    Object.defineProperty(unreadable, "0", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    Object.defineProperty(unreadable, "length", { value: 1 });
    expect(sanitizeDiagnosticParameters(unreadable)).toEqual([
      UNREADABLE_DIAGNOSTIC_VALUE,
    ]);

    const crowded: Record<string, unknown> = {};
    for (let index = 0; index < 260; index += 1) {
      crowded[`key${index}`] = index;
    }
    const [sanitizedCrowded] = sanitizeDiagnosticParameters([crowded]);
    expect(isRecord(sanitizedCrowded)).toBe(true);
    if (!isRecord(sanitizedCrowded)) {
      throw new Error("expected sanitized record");
    }
    expect(sanitizedCrowded.truncated).toBe(TRUNCATED_DIAGNOSTIC_VALUE);

    const nestedCrowded = sanitizeDiagnosticParameters([
      Array.from({ length: 128 }, (_, index) => index),
      Array.from({ length: 128 }, (_, index) => index),
    ]);
    const secondNestedValues = nestedCrowded[1];
    if (!Array.isArray(secondNestedValues)) {
      throw new Error("expected a sanitized nested array");
    }
    expect(secondNestedValues.at(-1)).toBe(TRUNCATED_DIAGNOSTIC_VALUE);
  });

  it("does not invoke parameter accessors or include inherited values", () => {
    let accessorCalls = 0;
    const inherited = { inherited: "ignored" };
    const value = Object.assign(Object.create(inherited), {
      cause: {
        code: "SQLITE_BUSY",
        detail: "private detail",
        hint: "private hint",
        message: "private message",
        stack: "private stack",
      },
      ["k".repeat(65)]: "bounded key",
    });
    Object.defineProperty(value, "computed", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "must not execute";
      },
    });

    expect(sanitizeDiagnosticParameters([value])).toEqual([
      {
        cause: {
          code: "SQLITE_BUSY",
          detail: "private detail",
          hint: "private hint",
          message: "private message",
          stack: "private stack",
        },
        computed: UNREADABLE_DIAGNOSTIC_VALUE,
        ["k".repeat(65)]: "bounded key",
      },
    ]);
    expect(accessorCalls).toBe(0);
  });
});

describe("trusted error diagnostics", () => {
  it("keeps the registered snapshot stable after public mutation", () => {
    const error = new UniqueConstraintError("duplicate", {
      cause: Object.assign(new Error("provider secret"), { code: "23505" }),
      meta: { constraint: "users_email_key" },
    });
    error.message = "mutated";
    error.name = "MutatedError";
    error.meta.constraint = "mutated";

    expect(serializeTrustedError(error)).toMatchObject({
      code: VibORMErrorCode.UNIQUE_CONSTRAINT,
      message: "duplicate",
      meta: { constraint: "users_email_key" },
      name: "UniqueConstraintError",
      prismaCode: "P2002",
    });
    expect(getTrustedErrorCause(error)?.message).toBe(
      "Underlying error details redacted"
    );
  });

  it("sanitizes explicit trusted registrations", () => {
    const error = new Error("public shell");
    registerTrustedError(error, {
      cause: new Error("provider secret"),
      code: "not-a-viborm-code",
      message: "m".repeat(5_000),
      meta: { operation: "findMany", token: "hidden" },
      name: "N".repeat(5_000),
      prismaCode: "not-a-prisma-code",
      timestamp: new Date(Number.NaN),
    });

    const serialized = serializeTrustedError(error);
    expect(serialized).toMatchObject({
      code: VibORMErrorCode.INTERNAL_ERROR,
      meta: { operation: "findMany" },
      timestamp: "Invalid Date",
    });
    expect(serialized?.message).toBe(boundTrustedString("m".repeat(5_000)));
    expect(serialized?.name).toBe(boundTrustedString("N".repeat(5_000)));
    expect(serialized).not.toHaveProperty("prismaCode");
    expect(serialized?.cause).toMatchObject({
      message: "Underlying error details redacted",
    });
  });

  it("redacts raw errors while retaining safe provider identifiers", () => {
    const cause = Object.assign(new Error("provider secret"), {
      code: "SQLITE_BUSY",
      errno: 5,
      sqlState: "40001",
      status: 503,
    });
    const redactedCause = sanitizeErrorCause(cause);
    expect(redactedCause).toMatchObject({
      code: "SQLITE_BUSY",
      errno: 5,
      message: "Underlying error details redacted",
      sqlState: "40001",
      status: 503,
    });

    const logged = sanitizeErrorForLogging(cause);
    expect(logged).toMatchObject({
      code: "SQLITE_BUSY",
      message: "Error details redacted",
      name: "Error",
    });
    expect(serializeSanitizedError(logged)).toMatchObject({
      code: "SQLITE_BUSY",
      message: "Error details redacted",
    });
    expect(serializeSanitizedError(undefined)).toBeUndefined();
  });

  it("logs trusted snapshots with disclosed metadata and progress", () => {
    const error = new UniqueConstraintError("duplicate", {
      cause: new Error("provider secret"),
      diagnostics: { includeParams: true, includeSql: true },
      meta: { params: ["value"], query: "INSERT INTO users" },
    });
    registerTrustedRecordSeriesProgress(error, {
      atomicity: "segment",
      phase: "member",
      committedSegments: 1,
      completedMembers: 1,
      committedWriteMembers: 1,
    });

    const logged = sanitizeErrorForLogging(error, {
      includeParams: true,
      includeSql: true,
    });
    expect(logged).toMatchObject({
      code: VibORMErrorCode.UNIQUE_CONSTRAINT,
      message: "duplicate",
      meta: {
        params: ["value"],
        query: "INSERT INTO users",
        recordSeriesProgress: { committedSegments: 1 },
      },
      name: "UniqueConstraintError",
      prismaCode: "P2002",
    });
    expect(serializeSanitizedError(logged)).toMatchObject({
      cause: { message: "Underlying error details redacted" },
      meta: { recordSeriesProgress: { committedSegments: 1 } },
    });

    const withoutPrismaCode = sanitizeErrorForLogging(
      new VibORMError("internal", VibORMErrorCode.INTERNAL_ERROR)
    );
    expect(withoutPrismaCode).not.toHaveProperty("prismaCode");
    expect(serializeTrustedError(new Error("foreign"))).toBeUndefined();
  });

  it("serializes nested and circular causes without recursion", () => {
    const parent = new Error("parent");
    const child = new Error("child");
    Object.defineProperty(parent, "cause", { value: child });
    Object.defineProperty(child, "cause", { value: parent });
    Object.defineProperty(parent, "meta", {
      value: {
        code: "SQLITE_BUSY",
        detail: "private detail",
        hint: "private hint",
        message: "private message",
        stack: "private stack",
      },
    });

    expect(serializeSanitizedError(parent)).toMatchObject({
      cause: {
        cause: { message: "[Circular]", name: "Error" },
        message: "child",
      },
      message: "parent",
      meta: { code: "Underlying error details redacted" },
    });
  });

  it("bounds circular and deeply nested Error causes", () => {
    const circular = new Error("circular");
    Object.defineProperty(circular, "cause", { value: circular });
    expect(serializeSanitizedError(sanitizeErrorCause(circular))).toMatchObject({
      cause: { message: "[Circular]" },
    });

    let nested = new Error("leaf");
    for (let depth = 0; depth < 10; depth += 1) {
      nested = new Error(`depth ${depth}`, { cause: nested });
    }
    let terminal = sanitizeErrorCause(nested);
    for (let depth = 0; depth < 9; depth += 1) {
      const next = getNestedCause(terminal);
      if (!next) throw new Error("expected the bounded cause chain");
      terminal = next;
    }
    expect(terminal.message).toBe(TRUNCATED_DIAGNOSTIC_VALUE);
  });
});

describe("record-series progress diagnostics", () => {
  const progress: RecordSeriesProgress = {
    atomicity: "segment",
    phase: "suffix",
    committedSegments: 2,
    completedMembers: 3,
    committedWriteMembers: 2,
    mayHaveCommittedSegment: true,
    memberPath: [1, 4],
    totalMembers: 5,
  };

  it("freezes valid progress and rejects each malformed domain", () => {
    const sanitized = sanitizeRecordSeriesProgress(progress);
    expect(sanitized).toEqual(progress);
    expect(Object.isFrozen(sanitized)).toBe(true);
    expect(Object.isFrozen(sanitized?.memberPath)).toBe(true);

    const phases: RecordSeriesProgress["phase"][] = [
      "capture",
      "planning",
      "prefix",
      "member",
      "suffix",
      "result",
      "invalidation",
    ];
    for (const phase of phases) {
      expect(sanitizeRecordSeriesProgress({ ...progress, phase })?.phase).toBe(
        phase
      );
    }

    for (const invalid of [
      null,
      { ...progress, atomicity: "operation" },
      { ...progress, phase: "unknown" },
      { ...progress, committedSegments: -1 },
      { ...progress, completedMembers: 0.5 },
      { ...progress, committedWriteMembers: Number.NaN },
      { ...progress, mayHaveCommittedSegment: false },
      { ...progress, totalMembers: -1 },
      { ...progress, memberPath: "0" },
      { ...progress, memberPath: Array<number>(1) },
      { ...progress, memberPath: [0, -1] },
      { ...progress, memberPath: Array.from({ length: 33 }, () => 0) },
    ]) {
      expect(sanitizeRecordSeriesProgress(invalid)).toBeUndefined();
    }
  });

  it("attaches one trusted observation and preserves it on reuse", () => {
    const error = new QueryEngineError("series failed");
    expect(attachRecordSeriesProgress(error, progress)).toBe(error);
    expect(getTrustedRecordSeriesProgress(error)).toEqual(progress);
    expect(hasRecordSeriesProgress(error)).toBe(true);
    expect(hasCommittedRecordSeriesProgress(error)).toBe(true);

    attachRecordSeriesProgress(error, {
      ...progress,
      committedSegments: 0,
      mayHaveCommittedSegment: true,
    });
    expect(getTrustedRecordSeriesProgress(error)).toEqual(progress);
  });

  it("wraps foreign Errors but leaves invalid foreign progress untouched", () => {
    const cause = new Error("series provider failed");
    const wrapped = attachRecordSeriesProgress(cause, progress);
    expect(wrapped).toBeInstanceOf(QueryEngineError);
    expect(hasRecordSeriesProgress(wrapped)).toBe(true);

    const thrown = "not an Error";
    expect(
      attachRecordSeriesProgress(thrown, {
        ...progress,
        committedSegments: -1,
      })
    ).toBe(thrown);
    expect(hasRecordSeriesProgress(thrown)).toBe(false);
    expect(hasCommittedRecordSeriesProgress(thrown)).toBe(false);
  });

  it("recognizes an uncertain segment even with no confirmed prefix", () => {
    const error = new VibORMError("uncertain", VibORMErrorCode.QUERY_FAILED);
    registerTrustedRecordSeriesProgress(error, {
      atomicity: "segment",
      phase: "member",
      committedSegments: 0,
      completedMembers: 0,
      committedWriteMembers: 0,
      mayHaveCommittedSegment: true,
    });
    expect(hasCommittedRecordSeriesProgress(error)).toBe(true);
  });

  it("recognizes a valid series with no committed segment", () => {
    const error = new VibORMError("not committed", VibORMErrorCode.QUERY_FAILED);
    registerTrustedRecordSeriesProgress(error, {
      atomicity: "segment",
      phase: "planning",
      committedSegments: 0,
      completedMembers: 0,
      committedWriteMembers: 0,
    });
    expect(getTrustedRecordSeriesProgress(error)).toEqual({
      atomicity: "segment",
      phase: "planning",
      committedSegments: 0,
      completedMembers: 0,
      committedWriteMembers: 0,
    });
    expect(hasCommittedRecordSeriesProgress(error)).toBe(false);

    expect(
      hasCommittedRecordSeriesProgress(
        new VibORMError("no progress", VibORMErrorCode.QUERY_FAILED)
      )
    ).toBe(false);
  });
});

describe("coverage low value", () => {
  it("keeps hostile reflection helpers total", () => {
    const revokedRecord = Proxy.revocable<Record<string, unknown>>({}, {});
    revokedRecord.revoke();
    expect(safeRead(revokedRecord.proxy, "value")).toBe(
      UNREADABLE_DIAGNOSTIC_VALUE
    );
    expect(safeHasOwn(revokedRecord.proxy, "value")).toBe(false);
    expect(safeOwnPropertyDescriptor(revokedRecord.proxy, "value")).toBeUndefined();
    expect(isRecord(revokedRecord.proxy)).toBe(false);
    expect(isError(revokedRecord.proxy)).toBe(false);

    const revokedArray = Proxy.revocable<unknown[]>([], {});
    revokedArray.revoke();
    expect(isArrayValue(revokedArray.proxy)).toBe(false);
    expect(safeArrayLength(revokedArray.proxy)).toBe(0);

    const unreadableValue = Proxy.revocable({}, {});
    unreadableValue.revoke();
    expect(sanitizeDiagnosticParameters([unreadableValue.proxy])).toEqual([
      UNREADABLE_DIAGNOSTIC_VALUE,
    ]);

    const unreadableKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("unreadable keys");
        },
      }
    );
    expect(sanitizeDiagnosticParameters([unreadableKeys])).toEqual([
      { unreadable: UNREADABLE_DIAGNOSTIC_VALUE },
    ]);
  });

  it("keeps owned diagnostic writes total if a target rejects them", () => {
    const frozen = Object.freeze({});
    expect(() => defineSafe(frozen, "visible", true)).not.toThrow();
    expect(() => defineHidden(frozen, Symbol("hidden"), true)).not.toThrow();
    expect(frozen).toEqual({});

    const safe = createSafeRecord();
    defineSafe(safe, "__proto__", "plain data");
    expect(Object.getPrototypeOf(safe)).toBeNull();
    expect(Object.hasOwn(safe, "__proto__")).toBe(true);
    expect(Reflect.get(safe, "__proto__")).toBe("plain data");
  });

  it("bounds byte, string, date, and Error diagnostics", () => {
    const byteBudget = { characters: 0, entries: 250 };
    expect(sanitizeBytes(new Uint8Array(20), byteBudget)).toMatchObject({
      byteLength: 20,
      bytes: [0, 0, 0, 0, 0, 0],
      truncated: true,
    });
    expect(byteBudget.entries).toBe(256);

    const stringBudget = { characters: 32_767, entries: 0 };
    expect(sanitizeString("long", stringBudget)).toBe(
      `l${TRUNCATED_DIAGNOSTIC_VALUE}`
    );
    expect(sanitizeString("", stringBudget)).toBe("");

    const proxiedDate = new Proxy(new Date(), {});
    expect(safeDateString(proxiedDate)).toBe("Invalid Date");
    expect(safeDateString(new Date(Number.NaN))).toBe("Invalid Date");

    const error = new Error("readable");
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("unreadable message");
      },
    });
    expect(safeErrorString(error, "message", { characters: 0, entries: 0 })).toBe(
      UNREADABLE_DIAGNOSTIC_VALUE
    );

    Object.defineProperty(error, "name", { value: 7 });
    expect(safeErrorString(error, "name", { characters: 0, entries: 0 })).toBe(
      "Error"
    );
  });

  it("rejects forged trusted snapshots", () => {
    const error = new Proxy(new Error("forged"), {
      get(target, key, receiver) {
        if (typeof key === "symbol") {
          return {
            code: 1,
            disclosure: { includeParams: false, includeSql: false },
            message: "forged",
            meta: {},
            name: "Error",
            timestamp: "now",
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(serializeTrustedError(error)).toBeUndefined();
  });

  it("falls back for an unregistered toJSON receiver and empty class name", () => {
    const registered = new VibORMError("registered", VibORMErrorCode.QUERY_FAILED);
    const unregisteredReceiver = new Proxy(registered, {
      get(target, key, receiver) {
        return typeof key === "symbol"
          ? undefined
          : Reflect.get(target, key, receiver);
      },
    });
    expect(VibORMError.prototype.toJSON.call(unregisteredReceiver)).toEqual({
      code: VibORMErrorCode.INTERNAL_ERROR,
      message: "VibORM operation failed",
      meta: {},
      name: "VibORMError",
      timestamp: "Invalid Date",
    });

    class EmptyDiagnosticNameError extends VibORMError {
      static override readonly diagnosticName = "";
    }
    expect(
      new EmptyDiagnosticNameError("empty", VibORMErrorCode.INTERNAL_ERROR).name
    ).toBe("VibORMError");

    let getterReads = 0;
    class AccessorDiagnosticNameError extends VibORMError {}
    Object.defineProperty(AccessorDiagnosticNameError, "diagnosticName", {
      get() {
        getterReads += 1;
        throw new Error("diagnostic name getter must not run");
      },
    });
    expect(
      new AccessorDiagnosticNameError(
        "accessor",
        VibORMErrorCode.INTERNAL_ERROR
      ).name
    ).toBe("VibORMError");
    expect(getterReads).toBe(0);

    class DetachedError {}
    const detached = Reflect.construct(
      VibORMError,
      ["detached", VibORMErrorCode.INTERNAL_ERROR],
      DetachedError
    );
    expect(Reflect.get(detached, "name")).toBe("VibORMError");

    const hostileNewTarget = new Proxy(function HostileError() {}, {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor denied");
      },
      getPrototypeOf() {
        throw new Error("prototype denied");
      },
    });
    const hostile = Reflect.construct(
      VibORMError,
      ["hostile", VibORMErrorCode.INTERNAL_ERROR],
      hostileNewTarget
    );
    expect(Reflect.get(hostile, "name")).toBe("VibORMError");
  });

  it("filters every provider identifier representation", () => {
    expect(sanitizeProviderCode(19)).toBe(19);
    expect(sanitizeProviderCode("V10001")).toBe("V10001");
    expect(sanitizeProviderCode("23505")).toBe("23505");
    expect(sanitizeProviderCode("SQLITE_BUSY")).toBe("SQLITE_BUSY");
    expect(sanitizeProviderCode("unknown-secret")).toBeUndefined();
    expect(sanitizeProviderCode("x".repeat(65))).toBeUndefined();
    expect(sanitizeProviderErrno(0)).toBe(0);
    expect(sanitizeProviderErrno(-1)).toBeUndefined();
    expect(sanitizeSqlState("23505")).toBe("23505");
    expect(sanitizeSqlState("ZZZZZ")).toBeUndefined();
    expect(sanitizeProviderStatus(503)).toBe(503);
    expect(sanitizeProviderStatus("503")).toBe("503");
    expect(sanitizeProviderStatus(99)).toBeUndefined();
    expect(sanitizeProviderStatus("50x")).toBeUndefined();
    expect(sanitizeTrustedCode("V12001")).toBe("V12001");
    expect(sanitizeTrustedCode("invalid")).toBe(VibORMErrorCode.INTERNAL_ERROR);
    expect(sanitizeTrustedPrismaCode("P2002")).toBe("P2002");
    expect(sanitizeTrustedPrismaCode("P20")).toBeUndefined();

    expect(filterSafeErrorProperty("errno", 19)).toBe(19);
    expect(filterSafeErrorProperty("sqlState", "23505")).toBe("23505");
    expect(filterSafeErrorProperty("sqlstate", "23505")).toBe("23505");
    expect(filterSafeErrorProperty("status", 503)).toBe(503);
    expect(filterSafeErrorProperty("statusCode", "503")).toBe("503");
    expect(filterSafeErrorProperty("code", "SQLITE_BUSY")).toBe("SQLITE_BUSY");
  });

  it("keeps recursive freezing and thrown-value conversion total", () => {
    const nested = { child: { value: 1 } };
    expect(freezeDiagnosticValue(nested)).toBe(nested);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested.child)).toBe(true);

    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("unreadable keys");
        },
      }
    );
    expect(freezeDiagnosticValue(hostile)).toBe(hostile);

    const error = new Error("existing");
    expect(toError(error)).toBe(error);
    expect(toError("thrown")).toMatchObject({ message: "thrown" });
    const unstringifiable = {
      [Symbol.toPrimitive]() {
        throw new Error("no string form");
      },
    };
    expect(toError(unstringifiable).message).toBe(
      "a thrown object whose own string conversion threw"
    );
  });

  it("prefers originalCause and then cause without trusting accessors", () => {
    const original = new Error("original");
    const cause = new Error("cause");
    const withOriginal = Object.assign(new Error("outer"), {
      cause,
      originalCause: original,
    });
    expect(getNestedCause(withOriginal)).toBe(original);
    expect(getNestedCause(Object.assign(new Error("outer"), { cause }))).toBe(
      cause
    );
    expect(getNestedCause(new Error("outer"))).toBeUndefined();
  });
});
