/**
 * `findUnique` batching: Prisma's dataloader, at the operation dispatch layer.
 *
 * Opt-in (`createClient({ findUniqueBatching: true })`, 1.4.1): calls issued
 * in the same tick that would each cost one round trip are answered by ONE
 * `findMany` over the keys they name, and each caller gets its own row back.
 * The shared read runs in its leader's own async context (the first call of
 * its batch), which may not be every member's: a driver that picks a database
 * by `AsyncLocalStorage`, or a trace per request, sees the leader's. That is
 * why it is opt-in. The merge happens below every per-call lifecycle step — request
 * transforms, controls, default omit, admission, query interceptors, the
 * official cache and observers all still see each call as its own operation —
 * and above the route, which runs the merged read like any other read.
 *
 * Two calls share a batch only when nothing that decides their rows differs:
 * the same engine (so the same client view, extension chain and bound
 * controls), outside every transaction, the same model, the same unique key
 * spelled the same way, the same projection (`select`/`include`/`omit`, nested
 * arguments included, compared structurally) and the same admitted controls.
 * The `where` must be the key alone: a value per member, nothing else.
 *
 * A row reaches a caller only when its decoded key is EXACTLY the caller's
 * admitted key. Whatever cannot be decided that way runs as the caller's own
 * unbatched operation, so a batch can cost a statement but never change an
 * answer:
 * - a string key without an exact match (a case-insensitive or padding
 *   collation can make the database find a row JavaScript does not match);
 * - a missing row for `findUniqueOrThrow` (its own error comes from its owner);
 * - a merged read that fails, for every caller of that read.
 * Only string, integer and bigint key members are batched. An integer or
 * bigint member's decoded value is its bound value, so a row JavaScript does
 * not match is a row the database did not return either: a missing integer
 * key answers `null` from the batch.
 */

import { passThroughParseResult } from "@adapters/adapter-result-parser";
import { normalizedBindParameterLimit } from "@drivers/bind-parameter-capacity";
import { deriveRecoverableExecutionContext } from "@drivers/execution-context";
import type { QueryExecutionContext } from "@drivers/exports";
import type { AdmittedControls } from "@extensions/controls";
import type { AnyModel } from "@schema/model";
import { findAddressableKey } from "@schema/model/keys";
import { isRecord } from "@validation/value-guards";
import { compileBindBudgetChunks } from "./bind-budget";
import type { QueryEngine } from "./query-engine";
import type { RoutedCandidateOperation } from "./raptor3/route/client-route";
import type { CallRows } from "./raptor3/shared/row-scope";

/** One `findUnique` call, as its pending operation knows it at dispatch. */
export interface FindUniqueCall {
  readonly engine: QueryEngine;
  readonly model: AnyModel;
  /** `findUnique` or `findUniqueOrThrow`. */
  readonly requested: string;
  /** The client-prepared input: controls removed, request transforms applied. */
  readonly args: Record<string, unknown>;
  readonly controls: AdmittedControls | undefined;
  /** The call's own row domain, resolved for the batch that runs it. */
  readonly rows: () => CallRows | undefined;
  readonly routed: RoutedCandidateOperation;
  readonly context: QueryExecutionContext;
  /** The call's own, unbatched execution. */
  readonly run: () => Promise<unknown>;
}

/** What a batch decided for one caller. */
type Decision = { readonly value: unknown } | typeof RUN_ALONE;
const RUN_ALONE = Symbol("run alone");

interface Member {
  readonly values: readonly unknown[];
  readonly signature: string;
  readonly orThrow: boolean;
  readonly decide: (decision: Decision) => void;
}

interface Batch {
  readonly leader: FindUniqueCall;
  /** Starts the batch in its leader's own continuation (its async context). */
  readonly start: () => void;
  readonly fields: readonly string[];
  readonly textKey: boolean;
  readonly members: Member[];
}

/** Key members whose decoded value is the bound value, by scalar type. */
const EXACT_KEY_VALUES: Readonly<Record<string, (value: unknown) => boolean>> =
  {
    string: (value) => typeof value === "string",
    int: (value) => typeof value === "number" && Number.isSafeInteger(value),
    bigint: (value) => typeof value === "bigint",
  };

let pending: Map<QueryEngine, Map<string, Batch[]>> | undefined;

/** The operation routes of the clients created with `findUniqueBatching`. */
const batchingRoutes = new WeakSet<object>();

/** Turn batching on for every engine of the client that owns `route`. */
export function enableFindUniqueBatching(route: object): void {
  batchingRoutes.add(route);
}

/**
 * After the current synchronous run AND the microtasks it queued, so resolvers
 * that each await once before calling still share a batch. Where there is no
 * `process.nextTick`, the end of the current synchronous run.
 */
const defer: (callback: () => void) => void = (() => {
  const host = (
    globalThis as {
      process?: { nextTick?: (callback: () => void) => void };
    }
  ).process;
  const nextTick = host?.nextTick;
  return typeof nextTick === "function"
    ? (callback) => nextTick.call(host, callback)
    : queueMicrotask;
})();

/**
 * Join a batch, or answer `undefined` when this call does not batch and must
 * run as it always has.
 */
export function batchFindUnique(
  call: FindUniqueCall
): Promise<unknown> | undefined {
  // A call on the originating client inside its own callback transaction
  // runs alone, and is refused there as it always was: in a batch, the shared
  // read would queue behind the transaction that waits for this call.
  if (!engineBatches(call.engine) || call.engine.driver.holdsConnectionScope())
    return undefined;
  let admitted: Record<string, unknown>;
  try {
    admitted = call.routed.preparedArgs;
  } catch {
    // The call's own execution admits again and rejects with the same error.
    return undefined;
  }
  const key = keyOf(call.model, admitted.where);
  if (key === undefined) return undefined;
  const { where: _where, ...projection } = call.args;
  const shape = signatureOf(projection);
  if (shape === undefined) return undefined;

  let decide!: (decision: Decision) => void;
  const decision = new Promise<Decision>((resolve) => {
    decide = resolve;
  });
  let lead!: (batch: Batch) => void;
  const leading = new Promise<Batch>((resolve) => {
    lead = resolve;
  });
  const member: Member = {
    values: key.values,
    signature: signatureOf(key.values)!,
    orThrow: call.requested !== "findUnique",
    decide,
  };
  const leads = enqueue(
    call,
    `${key.selector}\u0000${shape}`,
    key,
    member,
    lead
  );
  // Continuations run in the async context of the call that registered them:
  // the leader runs its batch in its own, and a call that runs alone runs in
  // its own. The tick's flush runs in whichever context queued first, and
  // only starts batches.
  const settled = leads
    ? leading.then((batch) => {
        runBatch(batch);
        return decision;
      })
    : decision;
  return settled.then((outcome) =>
    outcome === RUN_ALONE ? call.run() : outcome.value
  );
}

/**
 * The engine runs outside every transaction scope, and nothing below the
 * operation is keyed on the statement or the operation name: a statement
 * transform sees `findUnique`, and a result middleware is handed the operation
 * name, so either would observe the merged `findMany`.
 */
function engineBatches(engine: QueryEngine): boolean {
  const { driver } = engine;
  return (
    batchingRoutes.has(engine.route) &&
    driver === engine.route.driver &&
    (engine.extensionChain?.statement.length ?? 0) === 0 &&
    driver.result?.parseResult === undefined &&
    driver.adapter.result.parseResult === passThroughParseResult
  );
}

interface BatchKey {
  readonly selector: string;
  readonly fields: readonly string[];
  readonly values: readonly unknown[];
  readonly textKey: boolean;
}

/** The admitted `where` as one addressable key and nothing else, or nothing. */
function keyOf(model: AnyModel, where: unknown): BatchKey | undefined {
  if (!isRecord(where)) return undefined;
  const selectors = Object.keys(where);
  if (selectors.length !== 1) return undefined;
  const selector = selectors[0]!;
  const key = findAddressableKey(model, selector);
  if (key === undefined) return undefined;
  const value = where[selector];
  let values: unknown[];
  if (key.name === undefined) values = [value];
  else {
    if (!isRecord(value) || Object.keys(value).length !== key.fields.length)
      return undefined;
    values = key.fields.map((field) => value[field]);
  }
  // A member the model hides from every result cannot be read back to
  // dispatch a row, and no call may select it.
  const { scalars, omit } = model["~"].state;
  let textKey = false;
  for (const [index, field] of key.fields.entries()) {
    const state = scalars[field]?.["~"].state;
    const exact = state && !state.array && EXACT_KEY_VALUES[state.type];
    if (!exact?.(values[index]) || omit?.[field] === true) return undefined;
    if (state.type === "string") textKey = true;
  }
  return { selector, fields: key.fields, values, textKey };
}

/** Join or open a batch; `true` when this call opened it and leads it. */
function enqueue(
  call: FindUniqueCall,
  shape: string,
  key: BatchKey,
  member: Member,
  lead: (batch: Batch) => void
): boolean {
  if (pending === undefined) {
    pending = new Map();
    defer(flush);
  }
  let byShape = pending.get(call.engine);
  if (byShape === undefined) pending.set(call.engine, (byShape = new Map()));
  const signature = `${call.model["~"].names.ts}\u0000${shape}`;
  let batches = byShape.get(signature);
  if (batches === undefined) byShape.set(signature, (batches = []));
  let batch = batches.find((candidate) =>
    sameControls(candidate.leader.controls, call.controls)
  );
  let leads = false;
  if (batch === undefined) {
    const opened: Batch = {
      leader: call,
      start: () => lead(opened),
      fields: key.fields,
      textKey: key.textKey,
      members: [],
    };
    batch = opened;
    batches.push(batch);
    leads = true;
  }
  batch.members.push(member);
  return leads;
}

/** Admitted controls decide the row domain: the same values, the same rows. */
function sameControls(
  first: AdmittedControls | undefined,
  second: AdmittedControls | undefined
): boolean {
  if (first === second) return true;
  if (first === undefined || second === undefined) return false;
  const names = Object.keys(first);
  return (
    names.length === Object.keys(second).length &&
    names.every(
      (name) => Object.hasOwn(second, name) && first[name] === second[name]
    )
  );
}

function flush(): void {
  const batches = pending;
  pending = undefined;
  for (const byShape of batches!.values())
    for (const list of byShape.values())
      for (const batch of list) batch.start();
}

interface Chunk {
  readonly signatures: readonly string[];
  readonly read: RoutedCandidateOperation;
}

/**
 * Run one batch. Whatever goes wrong before a caller's row is decided sends
 * that caller back to its own execution; a caller is decided once, so a later
 * decision never replaces an earlier one.
 */
function runBatch(batch: Batch): void {
  const { members } = batch;
  const runAlone = (callers: readonly Member[]) => {
    for (const member of callers) member.decide(RUN_ALONE);
  };
  if (members.length === 1) {
    runAlone(members);
    return;
  }
  try {
    const bySignature = new Map<string, Member[]>();
    for (const member of members) {
      const same = bySignature.get(member.signature);
      if (same) same.push(member);
      else bySignature.set(member.signature, [member]);
    }
    const plan = planBatch(batch, [...bySignature.values()]);
    const { engine } = batch.leader;
    // Its callers recover a failure by running alone, so the shared read's
    // own failure is not logged or traced as an error.
    const context = deriveRecoverableExecutionContext(batch.leader.context);
    for (const chunk of plan.chunks) {
      const callers = chunk.signatures.flatMap((key) => bySignature.get(key)!);
      chunk.read
        .execute<Record<string, unknown>[]>({
          committedWriteSegment: undefined,
          context,
          driverOverride: undefined,
          engineDriver: engine.driver,
          isWrite: false,
          writeMayBeVisible: undefined,
        })
        .then(
          (rows) => {
            try {
              dispatch(batch, chunk, bySignature, plan.injected, rows);
            } catch {
              runAlone(callers);
            }
          },
          () => runAlone(callers)
        );
    }
  } catch {
    runAlone(members);
  }
}

/**
 * The merged reads, split where the driver's bind budget requires, through the
 * one chunking owner: the compiled statement is the meter.
 */
function planBatch(
  batch: Batch,
  keys: readonly (readonly Member[])[]
): { chunks: Chunk[]; injected: readonly string[] } {
  const { leader, fields } = batch;
  const projected = projectionWithKey(leader, fields);
  const rows = leader.rows();
  const reads = new Map<string, RoutedCandidateOperation>();
  const read = (start: number, end: number): RoutedCandidateOperation => {
    const id = `${start}:${end}`;
    let operation = reads.get(id);
    if (operation === undefined) {
      const values = keys.slice(start, end).map((same) => same[0]!.values);
      operation = leader.engine.route.operation(
        leader.model,
        "findMany",
        { ...projected.args, where: mergedWhere(fields, values) },
        rows
      );
      reads.set(id, operation);
    }
    return operation;
  };
  const signatures = keys.map((same) => same[0]!.signature);
  const limit = normalizedBindParameterLimit(
    leader.engine.driver.maxBindParametersPerStatement
  );
  const ranges =
    limit === undefined
      ? [{ start: 0, end: keys.length }]
      : compileBindBudgetChunks(
          keys.length,
          limit,
          (start, end) => read(start, end).buildStatement()!
        );
  return {
    chunks: ranges.map(({ start, end }) => ({
      signatures: signatures.slice(start, end),
      read: read(start, end),
    })),
    injected: projected.injected,
  };
}

/** One key member: `IN`; a compound key: one equality group per key. */
function mergedWhere(
  fields: readonly string[],
  values: readonly (readonly unknown[])[]
): Record<string, unknown> {
  if (fields.length === 1)
    return { [fields[0]!]: { in: values.map((value) => value[0]) } };
  return {
    OR: values.map((value) =>
      Object.fromEntries(fields.map((field, index) => [field, value[index]]))
    ),
  };
}

/**
 * The leader's projection with every key member read, so each row can be
 * dispatched; a member the caller does not read is removed again before the
 * row is handed over. A member can be missing because it is not selected or
 * because it is omitted (an omit wins over a select), so both are lifted.
 */
function projectionWithKey(
  leader: FindUniqueCall,
  fields: readonly string[]
): { args: Record<string, unknown>; injected: string[] } {
  const { where: _where, ...args } = leader.args;
  const selected = leader.routed.preparedArgs.select;
  const injected: string[] = [];
  if (!isRecord(selected)) return { args, injected };
  for (const field of fields) {
    if (selected[field] === true) continue;
    if (isRecord(args.select)) args.select = { ...args.select, [field]: true };
    if (isRecord(args.omit)) args.omit = { ...args.omit, [field]: false };
    injected.push(field);
  }
  return { args, injected };
}

function dispatch(
  batch: Batch,
  chunk: Chunk,
  bySignature: ReadonlyMap<string, readonly Member[]>,
  injected: readonly string[],
  rows: readonly Record<string, unknown>[]
): void {
  const found = new Map<string | undefined, Record<string, unknown>>();
  for (const row of rows) {
    const signature = signatureOf(batch.fields.map((field) => row[field]));
    for (const field of injected) delete row[field];
    if (!found.has(signature)) found.set(signature, row);
  }
  for (const signature of chunk.signatures) {
    const row = found.get(signature);
    for (const [index, member] of bySignature.get(signature)!.entries()) {
      if (row !== undefined)
        member.decide({ value: index === 0 ? row : copyResult(row) });
      else if (member.orThrow || batch.textKey) member.decide(RUN_ALONE);
      else member.decide({ value: null });
    }
  }
}

/**
 * A structural signature of plain argument data: equal signatures, equal
 * arguments. Anything else (a function, a fragment, a class instance) has
 * none, and the call does not batch.
 */
function signatureOf(value: unknown): string | undefined {
  switch (typeof value) {
    case "undefined":
      return "u";
    case "boolean":
    case "number":
      return String(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return `${value}n`;
    case "object":
      break;
    default:
      return undefined;
  }
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const signature = signatureOf(item);
      if (signature === undefined) return undefined;
      items.push(signature);
    }
    return `[${items.join(",")}]`;
  }
  if (value instanceof Date) return `D${value.getTime()}`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const entries: string[] = [];
  for (const [name, entry] of Object.entries(value)) {
    const signature = signatureOf(entry);
    if (signature === undefined) return undefined;
    entries.push(`${JSON.stringify(name)}:${signature}`);
  }
  return `{${entries.join(",")}}`;
}

/**
 * A second caller of the same key gets its own result, as it would have
 * unbatched: plain objects, arrays, dates and byte arrays are copied, keeping
 * the shape of what is shared inside the result (a node reached twice is one
 * copy); an immutable value (a Decimal) is shared. Members are defined, never
 * assigned, so a JSON key named `__proto__` stays an own member.
 */
function copyResult(
  value: unknown,
  copies = new Map<object, unknown>()
): unknown {
  if (typeof value !== "object" || value === null) return value;
  const known = copies.get(value);
  if (known !== undefined) return known;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array)
    return Uint8Array.prototype.slice.call(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const item of value) copy.push(copyResult(item, copies));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = Object.create(prototype) as object;
  copies.set(value, copy);
  for (const [name, entry] of Object.entries(value))
    Object.defineProperty(copy, name, {
      value: copyResult(entry, copies),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return copy;
}
