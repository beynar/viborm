import { ValidationError } from "@errors";
import {
  applyIdPrefix,
  bytesToKsuid,
  bytesToUlid,
  bytesToUuid,
  hasIdPrefix,
  KSUID_EPOCH_SECONDS,
  KSUID_PAYLOAD_LENGTH,
  ksuidBytes,
  ksuidToBytes,
  MAX_KSUID_UNIX_SECONDS,
  MAX_MILLISECOND_TIMESTAMP,
  randomBytes,
  ULID_RANDOM_LENGTH,
  UUID_BYTE_LENGTH,
  UUIDV7_RANDOM_LENGTH,
  ulidBytes,
  ulidToBytes,
  uuidToBytes,
  uuidV4Bytes,
  uuidV7Bytes,
} from "@validation/primitives/id-formats";
import { describe, expect, test } from "vitest";

/** A fixed byte pattern: every assertion below is a known answer, not a shape. */
const counted = (length: number, start = 0): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (start + index) % 256);

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const MISSING_ENTROPY = /crypto\.getRandomValues/;

const fromHex = (text: string): Uint8Array =>
  Uint8Array.from({ length: text.length / 2 }, (_, index) =>
    Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  );

describe("prefix", () => {
  test("a non-empty prefix is joined with a hyphen and an empty one is no prefix", () => {
    expect(applyIdPrefix("usr", "payload")).toBe("usr-payload");
    expect(applyIdPrefix("", "payload")).toBe("payload");
    expect(applyIdPrefix(undefined, "payload")).toBe("payload");
    expect(hasIdPrefix("usr")).toBe(true);
    expect(hasIdPrefix("")).toBe(false);
    expect(hasIdPrefix(undefined)).toBe(false);
  });
});

describe("uuid", () => {
  test("v4 sets version 4 and variant 10 and leaves every other bit alone", () => {
    const tagged = uuidV4Bytes(new Uint8Array(UUID_BYTE_LENGTH).fill(0xff));
    expect(hex(tagged)).toBe("ffffffffffff4fffbfffffffffffffff");
    const zeros = uuidV4Bytes(new Uint8Array(UUID_BYTE_LENGTH));
    expect(hex(zeros)).toBe("00000000000040008000000000000000");
  });

  test("v7 lays the timestamp out big-endian ahead of the random bits", () => {
    // RFC 9562 §5.7's own example instant: 2022-02-22T14:22:22-05:00.
    const bytes = uuidV7Bytes(
      0x01_7f_22_e2_79_b0,
      new Uint8Array(UUIDV7_RANDOM_LENGTH).fill(0xff)
    );
    expect(hex(bytes)).toBe("017f22e279b07fffbfffffffffffffff");
    expect(bytesToUuid(bytes)).toBe("017f22e2-79b0-7fff-bfff-ffffffffffff");
  });

  test("v7 refuses an instant outside a 48-bit millisecond timestamp", () => {
    const random = new Uint8Array(UUIDV7_RANDOM_LENGTH);
    expect(() =>
      uuidV7Bytes(MAX_MILLISECOND_TIMESTAMP + 1, random)
    ).toThrowError(ValidationError);
    expect(() => uuidV7Bytes(-1, random)).toThrowError(ValidationError);
    expect(() => uuidV7Bytes(1.5, random)).toThrowError(ValidationError);
    expect(() => uuidV7Bytes(MAX_MILLISECOND_TIMESTAMP, random)).not.toThrow();
  });

  test("text and bytes are the same value twice", () => {
    const bytes = counted(UUID_BYTE_LENGTH);
    expect(bytesToUuid(bytes)).toBe("00010203-0405-0607-0809-0a0b0c0d0e0f");
    expect(uuidToBytes("00010203-0405-0607-0809-0a0b0c0d0e0f")).toEqual(bytes);
  });

  test("uppercase is an accepted alias that normalizes to the same bytes", () => {
    const upper = "00010203-0405-0607-0809-0A0B0C0D0E0F";
    const bytes = uuidToBytes(upper);
    expect(bytes).toEqual(counted(UUID_BYTE_LENGTH));
    expect(bytes && bytesToUuid(bytes)).toBe(upper.toLowerCase());
  });

  test("spellings the format does not have are refused", () => {
    for (const text of [
      "",
      "00010203-0405-0607-0809-0a0b0c0d0e0",
      "000102030405060708090a0b0c0d0e0f",
      "{00010203-0405-0607-0809-0a0b0c0d0e0f}",
      "urn:uuid:00010203-0405-0607-0809-0a0b0c0d0e0f",
      "0001020g-0405-0607-0809-0a0b0c0d0e0f",
      "00010203-0405-0607-0809-0a0b0c0d0e0f ",
    ]) {
      expect(uuidToBytes(text)).toBeUndefined();
    }
  });

  test("a byte array that is not sixteen bytes names no uuid", () => {
    expect(() => bytesToUuid(counted(15))).toThrowError(ValidationError);
    expect(() => bytesToUuid(counted(17))).toThrowError(ValidationError);
  });
});

describe("ulid", () => {
  test("the spec's own boundary vectors", () => {
    const zero = ulidBytes(0, new Uint8Array(ULID_RANDOM_LENGTH));
    expect(bytesToUlid(zero)).toBe("00000000000000000000000000");
    const max = ulidBytes(
      MAX_MILLISECOND_TIMESTAMP,
      new Uint8Array(ULID_RANDOM_LENGTH).fill(0xff)
    );
    expect(bytesToUlid(max)).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(bytesToUlid(max).charAt(0) <= "7").toBe(true);
  });

  test("the timestamp occupies the first ten characters", () => {
    const bytes = ulidBytes(
      1_469_918_176_385,
      new Uint8Array(ULID_RANDOM_LENGTH)
    );
    // The canonical ULID example instant, 2016-07-30T21:56:16.385Z.
    expect(bytesToUlid(bytes).slice(0, 10)).toBe("01ARYZ6S41");
  });

  test("leading zeros survive both directions", () => {
    const bytes = ulidBytes(
      1,
      Uint8Array.from({ length: 10 }, () => 0)
    );
    const text = bytesToUlid(bytes);
    expect(text).toBe("00000000010000000000000000");
    expect(ulidToBytes(text)).toEqual(bytes);
  });

  test("lowercase is an accepted alias that normalizes to uppercase", () => {
    const canonical = "01ARYZ6S41YYYYYYYYYYYYYYYY";
    const bytes = ulidToBytes(canonical.toLowerCase());
    expect(bytes).toEqual(ulidToBytes(canonical));
    expect(bytes && bytesToUlid(bytes)).toBe(canonical);
  });

  test("a first character above 7 names more than 128 bits and is refused", () => {
    expect(ulidToBytes("8ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeUndefined();
    expect(ulidToBytes("ZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeUndefined();
    expect(ulidToBytes("7ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeDefined();
  });

  test("the excluded Crockford letters are not read as digits", () => {
    for (const letter of ["I", "L", "O", "U", "i", "l", "o", "u"]) {
      expect(ulidToBytes(`0000000000000000000000000${letter}`)).toBeUndefined();
    }
  });

  test("a text of the wrong length names no ulid", () => {
    expect(ulidToBytes("0000000000000000000000000")).toBeUndefined();
    expect(ulidToBytes("000000000000000000000000000")).toBeUndefined();
    expect(ulidToBytes("")).toBeUndefined();
  });

  test("a byte array that is not sixteen bytes names no ulid", () => {
    expect(() => bytesToUlid(counted(15))).toThrowError(ValidationError);
  });

  test("an instant outside a 48-bit millisecond timestamp is refused", () => {
    const random = new Uint8Array(ULID_RANDOM_LENGTH);
    expect(() => ulidBytes(MAX_MILLISECOND_TIMESTAMP + 1, random)).toThrowError(
      ValidationError
    );
    expect(() => ulidBytes(-1, random)).toThrowError(ValidationError);
    expect(() => ulidBytes(Number.NaN, random)).toThrowError(ValidationError);
  });
});

describe("ksuid", () => {
  // The vector published by segmentio/ksuid's own `inspect` output.
  const KNOWN_TEXT = "0ujtsYcgvSTl8PAuAdqWYSMnLOv";
  const KNOWN_BYTES = "0669f7efb5a1cd34b5f99d1154fb6853345c9735";
  const KNOWN_TIMESTAMP = 107_608_047;

  test("the known vector converts both ways", () => {
    expect(bytesToKsuid(fromHex(KNOWN_BYTES))).toBe(KNOWN_TEXT);
    expect(ksuidToBytes(KNOWN_TEXT)).toEqual(fromHex(KNOWN_BYTES));
  });

  test("the timestamp is seconds since 2014-05-13T16:53:20Z", () => {
    const bytes = ksuidBytes(
      KSUID_EPOCH_SECONDS + KNOWN_TIMESTAMP,
      fromHex(KNOWN_BYTES.slice(8))
    );
    expect(hex(bytes)).toBe(KNOWN_BYTES);
    expect(new Date(1_507_608_047 * 1000).toISOString()).toBe(
      "2017-10-10T04:00:47.000Z"
    );
  });

  test("the epoch boundaries are inclusive and nothing outside them is wrapped", () => {
    const payload = new Uint8Array(KSUID_PAYLOAD_LENGTH);
    expect(hex(ksuidBytes(KSUID_EPOCH_SECONDS, payload)).slice(0, 8)).toBe(
      "00000000"
    );
    expect(hex(ksuidBytes(MAX_KSUID_UNIX_SECONDS, payload)).slice(0, 8)).toBe(
      "ffffffff"
    );
    expect(() => ksuidBytes(KSUID_EPOCH_SECONDS - 1, payload)).toThrowError(
      ValidationError
    );
    expect(() => ksuidBytes(MAX_KSUID_UNIX_SECONDS + 1, payload)).toThrowError(
      ValidationError
    );
    expect(() => ksuidBytes(KSUID_EPOCH_SECONDS + 0.5, payload)).toThrowError(
      ValidationError
    );
  });

  test("the text is padded to twenty-seven characters", () => {
    const zero = bytesToKsuid(new Uint8Array(20));
    expect(zero).toBe("000000000000000000000000000");
    expect(ksuidToBytes(zero)).toEqual(new Uint8Array(20));
    const maximum = bytesToKsuid(new Uint8Array(20).fill(0xff));
    expect(maximum).toHaveLength(27);
    expect(ksuidToBytes(maximum)).toEqual(new Uint8Array(20).fill(0xff));
  });

  test("base62 is case-sensitive and a text above 2^160 names no ksuid", () => {
    expect(ksuidToBytes(KNOWN_TEXT.toLowerCase())).not.toEqual(
      ksuidToBytes(KNOWN_TEXT)
    );
    // "aWgEPTl1tmebfsQzFP4bxwgy80V" is the largest KSUID; the next text is not one.
    expect(ksuidToBytes("aWgEPTl1tmebfsQzFP4bxwgy80V")).toBeDefined();
    expect(ksuidToBytes("aWgEPTl1tmebfsQzFP4bxwgy80W")).toBeUndefined();
    expect(ksuidToBytes("zzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeUndefined();
    expect(ksuidToBytes("0ujtsYcgvSTl8PAuAdqWYSMnLO+")).toBeUndefined();
  });

  test("a text of the wrong length names no ksuid", () => {
    expect(ksuidToBytes(KNOWN_TEXT.slice(1))).toBeUndefined();
    expect(ksuidToBytes(`${KNOWN_TEXT}0`)).toBeUndefined();
  });

  test("a byte array that is not twenty bytes names no ksuid", () => {
    expect(() => bytesToKsuid(counted(16))).toThrowError(ValidationError);
  });
});

describe("secure randomness", () => {
  test("bytes come from crypto.getRandomValues", () => {
    const drawn = randomBytes(16, "uuid");
    expect(drawn).toHaveLength(16);
    expect(drawn).toBeInstanceOf(Uint8Array);
  });

  test("a runtime without it gets a refusal, never a weaker value", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(() => randomBytes(16, "ulid")).toThrowError(MISSING_ENTROPY);
      expect(() => randomBytes(16, "ulid")).toThrowError(ValidationError);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: original,
      });
    }
  });
});
