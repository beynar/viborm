// biome-ignore-all lint/suspicious/noBitwiseOperators: the deterministic PRNG
// below is upstream's own injection point, and a big-endian timestamp is a bit
// layout.

import { ValidationError } from "@errors";
import { init as upstreamCuid2 } from "@paralleldrive/cuid2";
import { string } from "@schema/scalars";
import { isGeneratorDefault } from "@schema/scalars/common";
import {
  createCuid2,
  createUlidGenerator,
} from "@schema/scalars/string/autogenerate";
import {
  KSUID_EPOCH_SECONDS,
  ksuidToBytes,
  ULID_RANDOM_LENGTH,
  ulidToBytes,
  uuidToBytes,
} from "@validation/primitives/id-formats";
import { afterEach, describe, expect, test, vi } from "vitest";

const NANOID_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const CUID_PATTERN = /^[a-z][0-9a-z]{23}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USER_PREFIX = /^usr-/;
const A_PREFIX = /^a-/;
const NANOID_LENGTH_BOUND = /between 1 and 65536/;
const ID_PREFIX_CONFLICT = /already declares/;
const ULID_EXHAUSTED = /2\^80/;

/** The closure a generator modifier installed, called once. */
const generate = (scalar: { ["~"]: { state: { default?: unknown } } }) => {
  const closure = scalar["~"].state.default;
  if (typeof closure !== "function") {
    throw new TypeError("A generator must install a callable default");
  }
  return String(closure());
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("declared generators", () => {
  const CASES = [
    ["uuid", () => string().uuid(), () => string().uuid("usr")],
    ["uuidv7", () => string().uuidv7(), () => string().uuidv7("usr")],
    ["ulid", () => string().ulid(), () => string().ulid("usr")],
    ["ksuid", () => string().ksuid(), () => string().ksuid("usr")],
    ["nanoid", () => string().nanoid(), () => string().nanoid(12, "usr")],
    ["cuid", () => string().cuid(), () => string().cuid("usr")],
  ] as const;

  test.each(
    CASES
  )("%s records its declaration and installs its own closure", (kind, plain, prefixed) => {
    const state = plain()["~"].state;
    expect(state.autoGenerate?.kind).toBe(kind);
    expect(state.hasDefault).toBe(true);
    expect(state.optional).toBe(true);
    expect(isGeneratorDefault(state.default)).toBe(true);
    expect(prefixed()["~"].state.autoGenerate?.prefix).toBe("usr");
  });

  test.each(
    CASES
  )("%s applies a declared prefix and nothing otherwise", (_kind, plain, prefixed) => {
    expect(generate(plain())).not.toMatch(USER_PREFIX);
    expect(generate(prefixed())).toMatch(USER_PREFIX);
  });

  test("each format generates its own canonical value", () => {
    expect(generate(string().uuid())).toMatch(UUID_V4);
    expect(generate(string().uuidv7())).toMatch(UUID_V7);
    expect(ulidToBytes(generate(string().ulid()))).toBeDefined();
    expect(ksuidToBytes(generate(string().ksuid()))).toBeDefined();
    expect(generate(string().cuid())).toMatch(CUID_PATTERN);
    expect(generate(string().nanoid())).toHaveLength(21);
  });

  test("a prefixed value is the prefix, a hyphen, and the bare payload", () => {
    const [prefix, payload] = generate(string().ulid("usr")).split("-");
    expect(prefix).toBe("usr");
    expect(payload && ulidToBytes(payload)).toBeDefined();
    expect(uuidToBytes(generate(string().uuid("u")).slice(2))).toBeDefined();
  });

  test("an empty prefix is no prefix", () => {
    expect(generate(string().ulid(""))).toHaveLength(26);
    expect(string().ulid("")["~"].state.autoGenerate?.prefix).toBe("");
  });

  test("a later generator wins and a custom default replaces only the closure", () => {
    const switched = string().uuid().ulid();
    expect(switched["~"].state.autoGenerate?.kind).toBe("ulid");
    expect(generate(switched)).toHaveLength(26);

    const overridden = string()
      .uuid()
      .default(() => "fixed");
    expect(overridden["~"].state.autoGenerate?.kind).toBe("uuid");
    expect(isGeneratorDefault(overridden["~"].state.default)).toBe(false);
    expect(generate(overridden)).toBe("fixed");
  });
});

describe("nanoid", () => {
  test("every character comes from the url alphabet", () => {
    for (const character of generate(string().nanoid(64))) {
      expect(NANOID_ALPHABET).toContain(character);
    }
  });

  test("the declared length is the payload length, not the value length", () => {
    expect(generate(string().nanoid(8))).toHaveLength(8);
    expect(generate(string().nanoid(8, "usr"))).toHaveLength(12);
    expect(string().nanoid(8)["~"].state.autoGenerate?.length).toBe(8);
  });

  /**
   * Both ends, at DECLARATION. The upper one is the entropy source's per-call
   * quota: a longer nanoid used to declare cleanly and then throw a platform
   * `QuotaExceededError` from inside the closure, once per row.
   */
  test("a length no id can have is refused at declaration", () => {
    for (const length of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      65_537,
      2 ** 40,
    ]) {
      expect(() => string().nanoid(length)).toThrowError(ValidationError);
      expect(() => string().nanoid(length)).toThrowError(NANOID_LENGTH_BOUND);
    }
  });

  test("the longest length the entropy source serves still mints an id", () => {
    expect(generate(string().nanoid(65_536))).toHaveLength(65_536);
  });
});

describe("id", () => {
  test("a bare .id() is a ULID primary key that the create type may omit", () => {
    const state = string().id()["~"].state;
    expect(state.isId).toBe(true);
    expect(state.isUnique).toBe(true);
    expect(state.hasDefault).toBe(true);
    expect(state.optional).toBe(true);
    expect(state.autoGenerate).toEqual({ kind: "ulid", prefix: undefined });
  });

  test(".id() never replaces a generator already declared", () => {
    const after = string().uuid("a").id();
    const before = string().id().uuid("a");
    expect(after["~"].state.autoGenerate).toEqual(
      before["~"].state.autoGenerate
    );
    expect(after["~"].state.autoGenerate).toEqual({
      kind: "uuid",
      prefix: "a",
    });
    for (const scalar of [after, before]) {
      expect(scalar["~"].state.isId).toBe(true);
      expect(scalar["~"].state.isUnique).toBe(true);
      expect(scalar["~"].state.hasDefault).toBe(true);
      expect(generate(scalar)).toMatch(A_PREFIX);
    }
  });

  test(".id(prefix) after a generator names two prefixes and is refused", () => {
    expect(() => string().uuid("a").id("b")).toThrowError(ValidationError);
    expect(() => string().uuid("a").id("b")).toThrowError(ID_PREFIX_CONFLICT);
    expect(() => string().ulid().id("b")).toThrowError(ValidationError);
    expect(() => string().id("b")).not.toThrow();
  });

  /**
   * An empty string is how a caller spells "no prefix" everywhere else
   * (`hasIdPrefix`), so it names nothing here either and contradicts nothing.
   */
  test('.id("") after a generator is a key declaration, not a second prefix', () => {
    const prefixed = string().uuid("a").id("");
    expect(prefixed["~"].state.autoGenerate).toEqual({
      kind: "uuid",
      prefix: "a",
    });
    expect(prefixed["~"].state.isId).toBe(true);
    expect(generate(prefixed)).toMatch(A_PREFIX);
    expect(string().uuid().id("")["~"].state.autoGenerate).toEqual({
      kind: "uuid",
      prefix: undefined,
    });
    expect(generate(string().id().id(""))).not.toContain("-");
  });

  test(".id(prefix) with no generator declared prefixes the ULID", () => {
    expect(generate(string().id("usr"))).toMatch(USER_PREFIX);
    expect(string().id("usr")["~"].state.autoGenerate).toEqual({
      kind: "ulid",
      prefix: "usr",
    });
  });
});

describe("ulid monotonicity", () => {
  const fixedRandom = (fill: number) => (length: number) =>
    new Uint8Array(length).fill(fill);

  test("same-millisecond calls increment the random block", () => {
    const next = createUlidGenerator({
      now: () => 1_469_918_176_385,
      random: fixedRandom(0),
    });
    const first = next();
    const second = next();
    const third = next();
    expect(first.slice(0, 10)).toBe(second.slice(0, 10));
    expect(second > first).toBe(true);
    expect(third > second).toBe(true);
    expect(ulidToBytes(second)?.slice(6)).toEqual(
      Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    );
  });

  test("a carry crosses byte boundaries", () => {
    const next = createUlidGenerator({
      now: () => 1,
      random: () => Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]),
    });
    next();
    expect(ulidToBytes(next())?.slice(6)).toEqual(
      Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1, 0, 0])
    );
  });

  test("a clock that moves backwards never emits a smaller identifier", () => {
    let clock = 1_600_000_000_000;
    const next = createUlidGenerator({
      now: () => clock,
      random: fixedRandom(0),
    });
    const first = next();
    clock = 1000;
    const second = next();
    expect(second.slice(0, 10)).toBe(first.slice(0, 10));
    expect(second > first).toBe(true);
    clock = 1_600_000_000_001;
    expect(next().slice(0, 10)).not.toBe(first.slice(0, 10));
  });

  test("a fresh millisecond draws a fresh block instead of incrementing", () => {
    let clock = 10;
    const next = createUlidGenerator({
      now: () => clock,
      random: fixedRandom(7),
    });
    next();
    clock = 11;
    expect(ulidToBytes(next())?.slice(6)).toEqual(
      new Uint8Array(ULID_RANDOM_LENGTH).fill(7)
    );
  });

  test("exhausting the random block refuses instead of going backwards", () => {
    const next = createUlidGenerator({
      now: () => 5,
      random: fixedRandom(0xff),
    });
    expect(ulidToBytes(next())?.slice(6)).toEqual(
      new Uint8Array(ULID_RANDOM_LENGTH).fill(0xff)
    );
    expect(() => next()).toThrowError(ValidationError);
    expect(() => next()).toThrowError(ULID_EXHAUSTED);
  });

  test("one sequence is shared by every ulid field in the process", () => {
    const first = generate(string().ulid());
    const second = generate(string().id());
    expect(second > first).toBe(true);
  });
});

describe("cuid2", () => {
  /** A deterministic PRNG: `random` is the injection point upstream publishes. */
  const mulberry32 = (seed: number) => {
    let state = seed;
    return () => {
      state = (state | 0) + 0x6d_2b_79_f5;
      state |= 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  };
  const counterFrom = (start: number) => {
    let count = start;
    return () => {
      const current = count;
      count++;
      return current;
    };
  };
  const FINGERPRINT = "e2z8m1q4x7c0v3b6n9k2j5h8g1f4d7s0";

  test("produces exactly what @paralleldrive/cuid2 produces", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T10:11:12.345Z"));
    for (const length of [2, 10, 24, 32]) {
      // Each side gets its OWN counter: a shared one would be advanced twice
      // per sample and the two implementations would never see the same input.
      const options = () => ({
        random: mulberry32(42),
        counter: counterFrom(1_234_567),
        length,
        fingerprint: FINGERPRINT,
      });
      const native = createCuid2(options());
      const upstream = upstreamCuid2(options());
      for (let sample = 0; sample < 128; sample++) {
        vi.setSystemTime(new Date(1_600_000_000_000 + sample * 37));
        expect(native()).toBe(upstream());
      }
    }
  });

  test("the shape the format promises", () => {
    const id = generate(string().cuid());
    expect(id).toHaveLength(24);
    expect(id).toMatch(CUID_PATTERN);
    expect(generate(string().cuid())).not.toBe(id);
  });
});

describe("secure randomness", () => {
  test("a runtime without crypto.getRandomValues refuses every generator", () => {
    const scalars = [
      string().uuid(),
      string().uuidv7(),
      string().ulid(),
      string().ksuid(),
      string().nanoid(),
      string().cuid(),
    ];
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
    try {
      for (const scalar of scalars) {
        expect(() => generate(scalar)).toThrowError(ValidationError);
      }
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: original,
      });
    }
  });

  test("importing the schema entry draws no entropy", async () => {
    vi.resetModules();
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const schema = await import("@schema");
    expect(spy).not.toHaveBeenCalled();
    // Declaring a field installs a closure; the closure is what draws.
    expect(schema.s.string().ksuid()["~"].state.default).toBeTypeOf("function");
    expect(spy).not.toHaveBeenCalled();
    generate(schema.s.string().ksuid());
    expect(spy).toHaveBeenCalled();
  });
});

describe("ksuid", () => {
  test("the timestamp is the current second in the ksuid epoch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T10:11:12.345Z"));
    const bytes = ksuidToBytes(generate(string().ksuid()));
    const seconds = Math.floor(Date.parse("2026-09-12T10:11:12.345Z") / 1000);
    expect(bytes?.slice(0, 4)).toEqual(
      Uint8Array.from([
        (seconds - KSUID_EPOCH_SECONDS) >>> 24,
        ((seconds - KSUID_EPOCH_SECONDS) >>> 16) & 255,
        ((seconds - KSUID_EPOCH_SECONDS) >>> 8) & 255,
        (seconds - KSUID_EPOCH_SECONDS) & 255,
      ])
    );
  });
});

describe("uuidv7", () => {
  test("the timestamp is the current millisecond, big-endian", () => {
    vi.useFakeTimers();
    const instant = Date.parse("2026-09-12T10:11:12.345Z");
    vi.setSystemTime(new Date(instant));
    const bytes = uuidToBytes(generate(string().uuidv7()));
    expect(bytes?.slice(0, 6)).toEqual(
      Uint8Array.from([
        Math.floor(instant / 2 ** 40) % 256,
        Math.floor(instant / 2 ** 32) % 256,
        Math.floor(instant / 2 ** 24) % 256,
        Math.floor(instant / 2 ** 16) % 256,
        Math.floor(instant / 2 ** 8) % 256,
        instant % 256,
      ])
    );
  });

  test("two values minted in one millisecond still differ", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T10:11:12.345Z"));
    expect(generate(string().uuidv7())).not.toBe(generate(string().uuidv7()));
  });
});
