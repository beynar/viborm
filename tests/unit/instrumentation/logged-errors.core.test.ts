import {
  isErrorLogged,
  markErrorLogged,
  transferLoggedErrorEvidence,
} from "@instrumentation/logged-errors";
import { describe, expect, test } from "vitest";

function loggedMarkerSurface(error: Error) {
  return {
    own: Object.hasOwn(error, "logged"),
    visible: "logged" in error,
  };
}

describe("logged error evidence", () => {
  test("records a frozen error without changing its public shape", () => {
    const error = Object.freeze(new Error("frozen failure"));
    const ownKeys = Reflect.ownKeys(error);

    expect(isErrorLogged(error)).toBe(false);
    markErrorLogged(error);

    expect(isErrorLogged(error)).toBe(true);
    expect(Reflect.ownKeys(error)).toEqual(ownKeys);
    expect(loggedMarkerSurface(error)).toEqual({ own: false, visible: false });
  });

  test("keeps evidence scoped to each exact error", () => {
    const first = new Error("first failure");
    const second = new Error("second failure");
    const nextRequest = new Error("next request failure");

    markErrorLogged(first);
    expect(isErrorLogged(first)).toBe(true);
    expect(isErrorLogged(second)).toBe(false);

    markErrorLogged(second);
    expect(isErrorLogged(first)).toBe(true);
    expect(isErrorLogged(second)).toBe(true);
    expect(isErrorLogged(nextRequest)).toBe(false);
  });

  test("transfers only existing evidence to a frozen successor", () => {
    const unreported = new Error("unreported source");
    const untouched = Object.freeze(new Error("untouched successor"));
    transferLoggedErrorEvidence(unreported, untouched);
    expect(isErrorLogged(untouched)).toBe(false);
    markErrorLogged(unreported);
    expect(isErrorLogged(untouched)).toBe(false);

    const reported = Object.freeze(new Error("reported source"));
    const successor = Object.freeze(new Error("replacement failure"));
    markErrorLogged(reported);
    transferLoggedErrorEvidence(reported, successor);

    expect(isErrorLogged(reported)).toBe(true);
    expect(isErrorLogged(successor)).toBe(true);
    expect(loggedMarkerSurface(reported)).toEqual({
      own: false,
      visible: false,
    });
    expect(loggedMarkerSurface(successor)).toEqual({
      own: false,
      visible: false,
    });
  });
});
