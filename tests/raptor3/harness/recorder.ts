import assert from "node:assert/strict";
import {
  G0_CAMPAIGN,
  G2_CAMPAIGN,
} from "../../../scripts/raptor3-manifest.mjs";
import {
  decodeEvidenceValue,
  encodeEvidenceValue,
} from "../../../benchmarks/operation-pipeline-evidence.mjs";
import type {
  ControlledEvent,
  ReplayRecord,
  ReplayTape,
  StatementCompletion,
} from "./protocol";

let controlsInUse = false;

export function recordingEventLimit(
  scenario: ReplayRecord["scenarioId"]
): number {
  return scenario.startsWith("g2-")
    ? G2_CAMPAIGN.completionLimit
    : G0_CAMPAIGN.completionLimit;
}

/** One serial operation owns the patched nondeterministic sources and its tape. */
export class Recorder {
  private readonly events: ControlledEvent[] = [];
  private randomState: number;
  private clockCalls = 0;
  private fault: unknown;
  readonly clockEpochMs: number;

  constructor(
    seed: number,
    private readonly replay?: ReplayTape,
    private readonly eventLimit = G0_CAMPAIGN.completionLimit
  ) {
    assert(
      Number.isSafeInteger(seed) && seed >= 0,
      "Schedule seed must be a nonnegative safe integer"
    );
    this.randomState = (seed ^ 0x9e3779b9) >>> 0;
    this.clockEpochMs = 1_700_000_000_000 + seed * 10_000;
  }

  record(event: ControlledEvent): void {
    try {
      assert(
        this.events.length < this.eventLimit,
        `Controlled event limit ${this.eventLimit} exceeded`
      );
      if (this.replay) {
        assert.deepEqual(
          event,
          this.replay.events[this.events.length],
          `Uncontrolled or changed event ${this.events.length}`
        );
      }
      this.events.push(
        decodeEvidenceValue(encodeEvidenceValue(event)) as ControlledEvent
      );
    } catch (failure) {
      this.fault ??= failure;
      throw this.fault;
    }
  }

  async complete(statement: StatementCompletion): Promise<void> {
    const releaseTurns = Math.floor(this.nextRandom() * 3);
    this.record({ kind: "completion", statement, releaseTurns });
    // A single actor has no competing transaction. These choices exercise
    // controlled completion/replay, not database isolation or race exploration.
    for (let turn = 0; turn < releaseTurns; turn += 1) await Promise.resolve();
  }

  release(eligible: readonly string[]): string {
    assert(eligible.length > 0, "No eligible transport completion");
    const selected = eligible[Math.floor(this.nextRandom() * eligible.length)]!;
    this.record({ kind: "release", eligible: [...eligible], selected });
    return selected;
  }

  finish(): ReplayTape {
    if (this.fault !== undefined) throw this.fault;
    if (this.replay)
      assert.equal(
        this.events.length,
        this.replay.events.length,
        "Replay left unconsumed events"
      );
    return { events: this.events };
  }

  async control<T>(run: () => Promise<T>): Promise<T> {
    assert(!controlsInUse, "Deterministic worlds must execute serially");
    const NativeDate = globalThis.Date;
    const randomDescriptor = Object.getOwnPropertyDescriptor(Math, "random");
    const uuidDescriptor = Object.getOwnPropertyDescriptor(
      globalThis.crypto,
      "randomUUID"
    );
    const originalUuid = globalThis.crypto.randomUUID;
    assert(
      randomDescriptor,
      "Required wall-clock/random boundary is unavailable"
    );
    controlsInUse = true;
    try {
      const now = () => {
        const value = this.clockEpochMs + this.clockCalls++;
        this.record({ kind: "clock", value });
        return value;
      };
      globalThis.Date = new Proxy(NativeDate, {
        construct(target, arguments_, newTarget) {
          return Reflect.construct(
            target,
            arguments_.length === 0 ? [now()] : arguments_,
            newTarget
          );
        },
        apply() {
          return new NativeDate(now()).toString();
        },
        get(target, key, receiver) {
          return key === "now" ? now : Reflect.get(target, key, receiver);
        },
      });
      Object.defineProperty(Math, "random", {
        ...randomDescriptor,
        value: () => {
          const value = this.nextRandom();
          this.record({ kind: "random", source: "math", value });
          return value;
        },
      });
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        writable: true,
        value: () => {
          const hex = Array.from({ length: 32 }, () =>
            Math.floor(this.nextRandom() * 16).toString(16)
          );
          hex[12] = "4";
          hex[16] = (8 + Math.floor(this.nextRandom() * 4)).toString(16);
          const value = `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
          this.record({ kind: "random", source: "uuid", value });
          return value;
        },
      });
      return await run();
    } finally {
      globalThis.Date = NativeDate;
      Object.defineProperty(Math, "random", randomDescriptor);
      if (uuidDescriptor)
        Object.defineProperty(globalThis.crypto, "randomUUID", uuidDescriptor);
      else {
        Reflect.deleteProperty(globalThis.crypto, "randomUUID");
        assert.equal(
          globalThis.crypto.randomUUID,
          originalUuid,
          "UUID boundary restoration failed"
        );
      }
      controlsInUse = false;
    }
  }

  private nextRandom(): number {
    this.randomState =
      (Math.imul(this.randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return this.randomState / 0x1_0000_0000;
  }
}
