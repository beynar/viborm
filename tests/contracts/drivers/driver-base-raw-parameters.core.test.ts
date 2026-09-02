/**
 * `$raw` parameters are the one input VibORM does not validate upstream, so the
 * driver base decides — by REFLECTION ONLY, never by invoking caller code —
 * which containers it may detach before dispatch.
 *
 * The admission rule is structural: a value is an interpretable JSON container
 * only when its prototype is INDISTINGUISHABLE from the built-in one, member
 * for member and descriptor for descriptor. That is what lets a cross-realm
 * array through while refusing a hand-built look-alike, and it is the part
 * worth pinning: every way a look-alike can differ is a way a container with
 * caller-owned behavior could otherwise be treated as inert and traversed.
 *
 * A record that fails admission stays OPAQUE — handed to the provider exactly
 * as given, never traversed. An ARRAY that fails is refused outright, because
 * an array reaches provider array semantics and VibORM cannot check behavior it
 * refuses to run.
 *
 * `provider-parameter-boundary.core.test.ts` owns the admitted graph's shape;
 * this file owns the admission decision itself.
 */

import { snapshotProviderParameters } from "@drivers/provider-parameter-snapshot";
import { QueryError } from "@errors";
import { describe, expect, test } from "vitest";

const rawContext = { model: "$raw", operation: "$executeRaw" };
const unnamedRawContext = { model: "$raw" };

const REFUSED_ARRAY = /received raw array parameter 0/;
const UNNAMED_OPERATION = /^Operation "statement" received/;

/** A structural copy of one built-in prototype, member for member. */
function cloneOwnShape(source: object, parent: object | null): object {
  const clone = Object.create(parent) as object;
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) Object.defineProperty(clone, key, descriptor);
  }
  return clone;
}

const fakeObjectPrototype = (): object => cloneOwnShape(Object.prototype, null);
const fakeArrayPrototype = (): object =>
  cloneOwnShape(Array.prototype, fakeObjectPrototype());

function recordWith(prototype: object): object {
  return Object.setPrototypeOf({ field: "value" }, prototype);
}

function arrayWith(prototype: object): unknown[] {
  return Object.setPrototypeOf(["item"], prototype) as unknown[];
}

/** Replace the `Symbol.unscopables` member of an Array.prototype look-alike. */
function withUnscopables(value: unknown): object {
  const prototype = fakeArrayPrototype();
  Object.defineProperty(prototype, Symbol.unscopables, {
    configurable: true,
    enumerable: false,
    value,
    writable: false,
  });
  return prototype;
}

const realUnscopables = Array.prototype[
  Symbol.unscopables
] as unknown as Record<string, boolean>;

function unscopablesCopy(
  edit: (key: string, index: number) => [string, unknown] | undefined
): object {
  const copy = Object.create(null) as Record<string, unknown>;
  let index = 0;
  for (const key of Object.keys(realUnscopables)) {
    const replacement = edit(key, index);
    index += 1;
    if (replacement === undefined) continue;
    copy[replacement[0]] = replacement[1];
  }
  return copy;
}

describe("a structurally identical built-in prototype is admitted", () => {
  test("normalizes a look-alike record onto the local Object prototype", () => {
    const value = recordWith(fakeObjectPrototype());

    const snapshot = snapshotProviderParameters([value], rawContext);

    expect(snapshot[0]).not.toBe(value);
    expect(Object.getPrototypeOf(snapshot[0])).toBe(Object.prototype);
    expect(snapshot[0]).toEqual({ field: "value" });
  });

  test("normalizes a look-alike array onto the local Array prototype", () => {
    const value = arrayWith(fakeArrayPrototype());

    const snapshot = snapshotProviderParameters([value], rawContext);

    expect(snapshot[0]).not.toBe(value);
    expect(Object.getPrototypeOf(snapshot[0])).toBe(Array.prototype);
    expect(snapshot[0]).toEqual(["item"]);
  });
});

describe("a record whose prototype is not the built-in stays opaque", () => {
  test.each([
    {
      label: "a renamed member",
      build() {
        const prototype = fakeObjectPrototype();
        const descriptor = Object.getOwnPropertyDescriptor(
          prototype,
          "toString"
        );
        Reflect.deleteProperty(prototype, "toString");
        if (descriptor) {
          Object.defineProperty(prototype, "toStringLater", descriptor);
        }
        return prototype;
      },
    },
    {
      label: "a member made enumerable",
      build() {
        const prototype = fakeObjectPrototype();
        Object.defineProperty(prototype, "toString", {
          configurable: true,
          enumerable: true,
          value: Object.prototype.toString,
          writable: true,
        });
        return prototype;
      },
    },
    {
      label: "a member frozen against writes",
      build() {
        const prototype = fakeObjectPrototype();
        Object.defineProperty(prototype, "toString", {
          configurable: true,
          enumerable: false,
          value: Object.prototype.toString,
          writable: false,
        });
        return prototype;
      },
    },
    {
      label: "a member replaced by a different implementation",
      build() {
        const prototype = fakeObjectPrototype();
        Object.defineProperty(prototype, "toString", {
          configurable: true,
          enumerable: false,
          value: () => "custom",
          writable: true,
        });
        return prototype;
      },
    },
    {
      label: "a member turned into an accessor",
      build() {
        const prototype = fakeObjectPrototype();
        Object.defineProperty(prototype, "valueOf", {
          configurable: true,
          enumerable: false,
          get: () => Object.prototype.valueOf,
        });
        return prototype;
      },
    },
    {
      label: "members that refuse to be listed",
      build() {
        return new Proxy(Object.create(null), {
          ownKeys() {
            throw new Error("prototype members are private");
          },
        });
      },
    },
    {
      label: "an identity that refuses to be read",
      build() {
        return new Proxy(Object.create(null), {
          getPrototypeOf() {
            throw new Error("prototype identity is private");
          },
        });
      },
    },
  ])("leaves a record with $label untouched", ({ build }) => {
    const value = recordWith(build());

    expect(snapshotProviderParameters([value], rawContext)[0]).toBe(value);
  });

  test("leaves an ordinary record carrying an enumerable accessor untouched", () => {
    let reads = 0;
    const value = Object.defineProperty({}, "computed", {
      enumerable: true,
      get() {
        reads += 1;
        return "provider-owned";
      },
    });

    expect(snapshotProviderParameters([value], rawContext)[0]).toBe(value);
    expect(reads).toBe(0);
  });

  test("leaves a record whose members refuse reflection untouched", () => {
    const value = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("member list is private");
        },
      }
    );

    expect(snapshotProviderParameters([value], rawContext)[0]).toBe(value);
  });

  test("copies only the members reflection actually describes", () => {
    const value = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => undefined,
        ownKeys: () => ["ghost"],
      }
    );

    const snapshot = snapshotProviderParameters([value], rawContext);

    expect(snapshot[0]).not.toBe(value);
    expect(Object.keys(snapshot[0] as object)).toEqual([]);
  });
});

describe("an array whose prototype is not the built-in is refused", () => {
  test.each([
    {
      label: "an unscopables record with an ordinary prototype",
      build: () => withUnscopables({ ...realUnscopables }),
    },
    {
      label: "an unscopables record missing members",
      build: () =>
        withUnscopables(
          unscopablesCopy((key, index) =>
            index === 0 ? undefined : [key, true]
          )
        ),
    },
    {
      label: "an unscopables record with a renamed member",
      build: () =>
        withUnscopables(
          unscopablesCopy((key, index) =>
            index === 0 ? [`${key}Later`, true] : [key, true]
          )
        ),
    },
    {
      label: "an unscopables record with a changed value",
      build: () =>
        withUnscopables(
          unscopablesCopy((key, index) =>
            index === 0 ? [key, false] : [key, true]
          )
        ),
    },
    {
      label: "an unscopables record whose identity refuses to be read",
      build: () =>
        withUnscopables(
          new Proxy(Object.create(null), {
            getPrototypeOf() {
              throw new Error("unscopables identity is private");
            },
          })
        ),
    },
    {
      label: "an identity that refuses to be read",
      build: () =>
        new Proxy(Object.create(null), {
          getPrototypeOf() {
            throw new Error("prototype identity is private");
          },
        }),
    },
  ])("refuses an array with $label", ({ build }) => {
    const value = arrayWith(build());

    expect(() => snapshotProviderParameters([value], rawContext)).toThrow(
      QueryError
    );
    expect(() => snapshotProviderParameters([value], rawContext)).toThrow(
      REFUSED_ARRAY
    );
  });

  test("refuses an array whose members refuse reflection", () => {
    const value = new Proxy([], {
      ownKeys() {
        throw new Error("member list is private");
      },
    });

    expect(() => snapshotProviderParameters([value], rawContext)).toThrow(
      REFUSED_ARRAY
    );
  });
});

describe("a refusal names the statement it belongs to", () => {
  test("falls back to a generic subject when the raw call has no operation", () => {
    expect(() =>
      snapshotProviderParameters([new Date(Number.NaN)], unnamedRawContext)
    ).toThrow(UNNAMED_OPERATION);

    const refusedArray = new Proxy([], {
      ownKeys() {
        throw new Error("member list is private");
      },
    });
    expect(() =>
      snapshotProviderParameters([refusedArray], unnamedRawContext)
    ).toThrow(UNNAMED_OPERATION);
  });
});
