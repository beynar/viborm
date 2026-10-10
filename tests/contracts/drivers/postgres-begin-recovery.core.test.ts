import { PostgresDriver, vibormTypes } from "@drivers/postgres";
import {
  type DriverTransactionOptions,
  readSuppressedFailures,
} from "@drivers/shared";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

class BeginProbe extends PostgresDriver {
  invoke(
    client: postgres.Sql<Record<string, unknown>>,
    callback: (tx: postgres.TransactionSql) => Promise<string>,
    options?: DriverTransactionOptions
  ): Promise<string> {
    return this.transaction(client, callback, undefined, options);
  }
}

function fixture() {
  const client = postgres({ types: vibormTypes });
  const release = vi.fn();
  const lease = Object.assign(postgres({ types: vibormTypes }), {
    release,
    savepoint: () => {
      throw new Error("Unexpected savepoint in the controlled BEGIN fixture");
    },
    prepare: () => {
      throw new Error("Unexpected prepare in the controlled BEGIN fixture");
    },
  });
  const end = vi.spyOn(client, "end");
  const reserve = vi.spyOn(client, "reserve");
  const driver = new BeginProbe({ client });
  return { client, release, lease, end, reserve, driver };
}
const closed = () =>
  Object.assign(new Error("Physical socket closed"), {
    code: "CONNECTION_CLOSED",
  });
const stale = () =>
  Object.assign(new Error("Prior fatal response"), { code: "57P01" });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("postgres.js failed BEGIN recovery", () => {
  it("drains a stale acquisition without replaying callback or closing the borrowed pool", async () => {
    const { client, release, lease, end, reserve, driver } = fixture();
    const primary = closed();
    const prior = stale();
    vi.spyOn(client, "begin").mockRejectedValue(primary);
    reserve.mockRejectedValueOnce(prior).mockResolvedValueOnce(lease);
    const callback = vi.fn(async () => "unreachable");
    await expect(driver.invoke(client, callback)).rejects.toBe(primary);
    expect(callback).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    expect(readSuppressedFailures(primary)).toEqual([prior]);
    await driver._disconnect();
    expect(end).not.toHaveBeenCalled();
  });

  it("successful native BEGIN has no recovery lease", async () => {
    const { client, lease, reserve, driver } = fixture();
    Object.defineProperty(client, "begin", {
      configurable: true,
      value: (callback: (tx: postgres.TransactionSql) => Promise<string>) =>
        callback(lease),
    });
    const callback = vi.fn(async () => "committed");
    await expect(driver.invoke(client, callback)).resolves.toBe("committed");
    expect(callback).toHaveBeenCalledOnce();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("retains primary and both terminal acquisition failures, then stays usable because no live session remains", async () => {
    const { client, end, reserve, driver } = fixture();
    const primary = closed();
    const prior = stale();
    const terminal = closed();
    vi.spyOn(client, "begin").mockRejectedValue(primary);
    reserve.mockRejectedValueOnce(prior).mockRejectedValueOnce(terminal);
    await expect(driver.invoke(client, async () => "unreachable")).rejects.toBe(
      primary
    );
    expect(readSuppressedFailures(primary)).toEqual([prior, terminal]);
    const dispatch = vi.fn(async () =>
      Object.assign([{ x: 1 }], { count: 1, command: "SELECT" })
    );
    Object.defineProperty(client, "unsafe", { value: dispatch });
    await expect(driver._executeRaw("SELECT 1")).resolves.toMatchObject({
      rowCount: 1,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    await driver._disconnect();
    expect(end).not.toHaveBeenCalled();
  });

  it("keeps one cleanup deadline and releases a lease arriving after expiry", async () => {
    vi.useFakeTimers();
    const { client, release, lease, end, reserve, driver } = fixture();
    const primary = closed();
    let arrive: ((value: typeof lease) => void) | undefined;
    vi.spyOn(client, "begin").mockRejectedValue(primary);
    reserve.mockRejectedValueOnce(stale()).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          arrive = resolve;
        })
    );
    const invocation = driver.invoke(client, async () => "unreachable", {
      maxWaitMs: 20,
    });
    const settled = expect(invocation).rejects.toBe(primary);
    await vi.advanceTimersByTimeAsync(20);
    await settled;
    expect(readSuppressedFailures(primary)).toHaveLength(2);
    expect(readSuppressedFailures(primary)[1]).toMatchObject({ code: "V5002" });
    if (!arrive) throw new Error("The acquisition did not start");
    arrive(lease);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
  });

  it("does not start a second lease when the original deadline is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { client, lease, reserve, driver } = fixture();
    const primary = closed();
    vi.spyOn(client, "begin").mockRejectedValue(primary);
    reserve
      .mockImplementationOnce(async () => {
        vi.setSystemTime(20);
        throw stale();
      })
      .mockResolvedValueOnce(lease);
    await expect(
      driver.invoke(client, async () => "unreachable", { maxWaitMs: 20 })
    ).rejects.toBe(primary);
    expect(reserve).toHaveBeenCalledOnce();
  });

  it("never probes after callback entry or a configuration refusal", async () => {
    const { client, lease, reserve, driver } = fixture();
    const callbackFailure = closed();
    Object.defineProperty(client, "begin", {
      configurable: true,
      value: (callback: (tx: postgres.TransactionSql) => Promise<string>) =>
        callback(lease),
    });
    await expect(
      driver.invoke(client, async () => {
        throw callbackFailure;
      })
    ).rejects.toBe(callbackFailure);
    Object.defineProperty(client, "begin", {
      value: () =>
        Promise.reject(
          Object.assign(new Error("Authentication refused"), { code: "28P01" })
        ),
    });
    await expect(
      driver.invoke(client, async () => "unreachable")
    ).rejects.toThrow("Authentication refused");
    expect(reserve).not.toHaveBeenCalled();
  });
});
