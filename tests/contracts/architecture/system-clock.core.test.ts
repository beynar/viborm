import { systemClock } from "@src/clock";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("system clock", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads the host clock", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    expect(systemClock.now()).toBe(1_700_000_000_000);
  });

  it("arms and cancels host timers through the same handle", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const timer = systemClock.setTimeout(callback, 25);

    vi.advanceTimersByTime(24);
    expect(callback).not.toHaveBeenCalled();

    timer.cancel();
    vi.advanceTimersByTime(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it("runs a callback when its host timer expires", () => {
    vi.useFakeTimers();
    const callback = vi.fn();

    systemClock.setTimeout(callback, 25);
    vi.advanceTimersByTime(25);

    expect(callback).toHaveBeenCalledOnce();
  });

  it("releases a Node timer from the event loop", () => {
    const hostSetTimeout = globalThis.setTimeout;
    const unref = vi.fn();
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms) => {
      const timer = hostSetTimeout(callback, ms);
      Reflect.set(timer, "unref", unref);
      return timer;
    });

    const timer = systemClock.setTimeout(() => undefined, 60_000);
    timer.unref?.();
    timer.cancel();

    expect(unref).toHaveBeenCalledOnce();
  });

  it("tolerates timer hosts without unref", () => {
    const hostSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms) => {
      const timer = hostSetTimeout(callback, ms);
      Reflect.set(timer, "unref", undefined);
      return timer;
    });

    const timer = systemClock.setTimeout(() => undefined, 60_000);
    expect(() => timer.unref?.()).not.toThrow();
    timer.cancel();
  });
});
