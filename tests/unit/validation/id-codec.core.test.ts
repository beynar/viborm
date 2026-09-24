import { normalizeBinaryValue } from "@validation/primitives/binary-shapes";
import {
  canonicalizeId,
  decodePhysicalId,
  describeIdDomain,
  encodePhysicalId,
  type IdDomain,
  idByteLength,
  isCompactIdFormat,
  isIdFormat,
  sameIdDomain,
} from "@validation/primitives/id-codec";
import { describe, expect, test } from "vitest";

const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KSUID = "0ujtsYcgvSTl8PAuAdqWYSMnLOv";
const NANOID = "V1StGXR8_Z5jdHi6B-myT";
const CUID = "tz4a98xxat96iws9zmbrgj3a";

const domain = (
  format: IdDomain["format"],
  extra: Omit<IdDomain, "format"> = {}
): IdDomain => ({ format, ...extra });

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  );

/** The hex of whatever bytes a call produced, and a readable miss when it did not. */
const hexOf = (value: string | Uint8Array | undefined): string =>
  value instanceof Uint8Array
    ? [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    : `not bytes: ${String(value)}`;

const widthOf = (value: string | Uint8Array | undefined): number =>
  value instanceof Uint8Array ? value.length : -1;

describe("the domain vocabulary", () => {
  test("the six string generators name a domain and the other three do not", () => {
    for (const kind of ["uuid", "uuidv7", "ulid", "ksuid", "nanoid", "cuid"]) {
      expect(isIdFormat(kind)).toBe(true);
    }
    for (const kind of ["increment", "now", "updatedAt", undefined]) {
      expect(isIdFormat(kind)).toBe(false);
    }
  });

  test("only the four fixed-width formats are compact", () => {
    expect(isCompactIdFormat("uuid")).toBe(true);
    expect(isCompactIdFormat("uuidv7")).toBe(true);
    expect(isCompactIdFormat("ulid")).toBe(true);
    expect(isCompactIdFormat("ksuid")).toBe(true);
    expect(isCompactIdFormat("nanoid")).toBe(false);
    expect(isCompactIdFormat("cuid")).toBe(false);
  });

  test("byte widths are the formats' own; text formats have none", () => {
    expect(idByteLength("uuid")).toBe(16);
    expect(idByteLength("uuidv7")).toBe(16);
    expect(idByteLength("ulid")).toBe(16);
    expect(idByteLength("ksuid")).toBe(20);
    expect(idByteLength("nanoid")).toBeUndefined();
    expect(idByteLength("cuid")).toBeUndefined();
  });
});

describe("domain equality", () => {
  test("an empty prefix is the same declaration as no prefix", () => {
    expect(sameIdDomain(domain("uuid"), domain("uuid", { prefix: "" }))).toBe(
      true
    );
  });

  test("a different prefix, format or nanoid width is a different domain", () => {
    expect(sameIdDomain(domain("uuid", { prefix: "a" }), domain("uuid"))).toBe(
      false
    );
    expect(sameIdDomain(domain("uuid"), domain("uuidv7"))).toBe(false);
    expect(
      sameIdDomain(
        domain("nanoid", { length: 10 }),
        domain("nanoid", { length: 12 })
      )
    ).toBe(false);
  });

  test("an omitted nanoid length is the declared default, not a wildcard", () => {
    expect(
      sameIdDomain(domain("nanoid"), domain("nanoid", { length: 21 }))
    ).toBe(true);
    expect(
      sameIdDomain(domain("nanoid"), domain("nanoid", { length: 22 }))
    ).toBe(false);
  });

  test("a length on a fixed-width format is not part of its identity", () => {
    expect(sameIdDomain(domain("uuid", { length: 8 }), domain("uuid"))).toBe(
      true
    );
  });

  test("an absent domain equals only another absent one", () => {
    expect(sameIdDomain(undefined, undefined)).toBe(true);
    expect(sameIdDomain(undefined, domain("uuid"))).toBe(false);
    expect(sameIdDomain(domain("uuid"), undefined)).toBe(false);
  });
});

describe("describing a domain", () => {
  test("it names the format, the nanoid width and the prefix", () => {
    expect(describeIdDomain(domain("uuid"))).toBe("a uuid value");
    expect(describeIdDomain(domain("uuid", { prefix: "usr" }))).toBe(
      "a uuid value prefixed 'usr-'"
    );
    expect(describeIdDomain(domain("nanoid", { length: 8 }))).toBe(
      "a nanoid value of length 8"
    );
    expect(describeIdDomain(domain("nanoid", { prefix: "n" }))).toBe(
      "a nanoid value of length 21 prefixed 'n-'"
    );
  });
});

describe("admission", () => {
  test("a canonical value of each format is admitted unchanged", () => {
    expect(canonicalizeId(UUID, domain("uuid"))).toBe(UUID);
    expect(canonicalizeId(UUID, domain("uuidv7"))).toBe(UUID);
    expect(canonicalizeId(ULID, domain("ulid"))).toBe(ULID);
    expect(canonicalizeId(KSUID, domain("ksuid"))).toBe(KSUID);
    expect(canonicalizeId(NANOID, domain("nanoid"))).toBe(NANOID);
    expect(canonicalizeId(CUID, domain("cuid"))).toBe(CUID);
  });

  test("an uppercase UUID and a lowercase ULID are aliases, normalized once", () => {
    expect(canonicalizeId(UUID.toUpperCase(), domain("uuid"))).toBe(UUID);
    expect(canonicalizeId(ULID.toLowerCase(), domain("ulid"))).toBe(ULID);
  });

  test("KSUID, NanoID and CUID2 are case-sensitive with no alias", () => {
    // An upper-cased KSUID is base62 too — and a DIFFERENT identifier, which is
    // exactly why nothing folds its case.
    const shouted = canonicalizeId(KSUID.toUpperCase(), domain("ksuid"));
    expect(shouted).toBe(KSUID.toUpperCase());
    expect(shouted).not.toBe(KSUID);
    expect(canonicalizeId(NANOID.toUpperCase(), domain("nanoid"))).toBe(
      NANOID.toUpperCase()
    );
    expect(canonicalizeId(CUID.toUpperCase(), domain("cuid"))).toBeUndefined();
  });

  test("a non-string is not a value of any domain", () => {
    for (const value of [1, null, undefined, {}, ["a"], new Uint8Array(16)]) {
      expect(canonicalizeId(value, domain("uuid"))).toBeUndefined();
    }
  });

  test("a spelling outside the format is refused rather than repaired", () => {
    expect(canonicalizeId(UUID.replaceAll("-", ""), domain("uuid"))).toBe(
      undefined
    );
    expect(canonicalizeId(`{${UUID}}`, domain("uuid"))).toBeUndefined();
    expect(canonicalizeId(`urn:uuid:${UUID}`, domain("uuid"))).toBe(undefined);
    // A ULID whose first character exceeds 7 names more than 128 bits.
    expect(canonicalizeId(`8${ULID.slice(1)}`, domain("ulid"))).toBe(undefined);
    // `I`, `L`, `O` and `U` are not Crockford digits.
    expect(canonicalizeId("0IARZ3NDEKTSV4RRFFQ69G5FA", domain("ulid"))).toBe(
      undefined
    );
    expect(canonicalizeId("zzzzzzzzzzzzzzzzzzzzzzzzzzz", domain("ksuid"))).toBe(
      undefined
    );
    expect(canonicalizeId(ULID.slice(1), domain("ulid"))).toBeUndefined();
    // The FIRST character is read before the rest, so an excluded letter there
    // is its own refusal rather than a digit out of range.
    expect(canonicalizeId(`I${ULID.slice(1)}`, domain("ulid"))).toBeUndefined();
  });

  test("a nanoid is admitted at its declared length over its own alphabet", () => {
    expect(canonicalizeId(NANOID, domain("nanoid", { length: 21 }))).toBe(
      NANOID
    );
    expect(
      canonicalizeId(NANOID, domain("nanoid", { length: 20 }))
    ).toBeUndefined();
    expect(canonicalizeId("V1StGXR8", domain("nanoid", { length: 8 }))).toBe(
      "V1StGXR8"
    );
    // `!` is not in the 64-character alphabet.
    expect(
      canonicalizeId("V1StGXR!", domain("nanoid", { length: 8 }))
    ).toBeUndefined();
  });

  test("a cuid2 is a lowercase letter then 23 lowercase alphanumerics", () => {
    expect(canonicalizeId(CUID, domain("cuid"))).toBe(CUID);
    expect(canonicalizeId(`9${CUID.slice(1)}`, domain("cuid"))).toBeUndefined();
    expect(canonicalizeId(CUID.slice(1), domain("cuid"))).toBeUndefined();
  });

  test("a prefix is matched whole; nothing splits generically on a hyphen", () => {
    const prefixed = domain("uuid", { prefix: "usr" });
    expect(canonicalizeId(`usr-${UUID}`, prefixed)).toBe(`usr-${UUID}`);
    expect(canonicalizeId(UUID, prefixed)).toBeUndefined();
    expect(canonicalizeId(`org-${UUID}`, prefixed)).toBeUndefined();
    expect(canonicalizeId(`us-r-${UUID}`, prefixed)).toBeUndefined();
    // The alias normalization happens inside the prefix, not across it.
    expect(canonicalizeId(`usr-${UUID.toUpperCase()}`, prefixed)).toBe(
      `usr-${UUID}`
    );
  });

  test("an empty prefix declares none, so the bare payload is the value", () => {
    expect(canonicalizeId(UUID, domain("uuid", { prefix: "" }))).toBe(UUID);
    expect(
      canonicalizeId(`-${UUID}`, domain("uuid", { prefix: "" }))
    ).toBeUndefined();
  });

  test("a prefixed value of a hyphen-free format still needs the exact marker", () => {
    const prefixed = domain("ulid", { prefix: "ev" });
    expect(canonicalizeId(`ev-${ULID}`, prefixed)).toBe(`ev-${ULID}`);
    expect(canonicalizeId(`ev${ULID}`, prefixed)).toBeUndefined();
  });
});

describe("physical encoding", () => {
  test("text storage holds the whole public string, prefix included", () => {
    expect(encodePhysicalId(UUID, domain("uuid"), "text")).toBe(UUID);
    expect(
      encodePhysicalId(`usr-${UUID}`, domain("uuid", { prefix: "usr" }), "text")
    ).toBe(`usr-${UUID}`);
    expect(encodePhysicalId(CUID, domain("cuid"), "text")).toBe(CUID);
  });

  test("text storage normalizes an alias before it is written", () => {
    expect(encodePhysicalId(UUID.toUpperCase(), domain("uuid"), "text")).toBe(
      UUID
    );
    expect(encodePhysicalId(ULID.toLowerCase(), domain("ulid"), "text")).toBe(
      ULID
    );
  });

  test("a PostgreSQL uuid column takes the payload as canonical uuid text", () => {
    expect(encodePhysicalId(UUID, domain("uuid"), "uuid")).toBe(UUID);
    expect(
      encodePhysicalId(`usr-${UUID}`, domain("uuid", { prefix: "usr" }), "uuid")
    ).toBe(UUID);
  });

  test("byte storage holds the payload's own bytes at the format's width", () => {
    expect(hexOf(encodePhysicalId(UUID, domain("uuid"), "bytes"))).toBe(
      "a0eebc999c0b4ef8bb6d6bb9bd380a11"
    );
    expect(widthOf(encodePhysicalId(ULID, domain("ulid"), "bytes"))).toBe(16);
    expect(widthOf(encodePhysicalId(KSUID, domain("ksuid"), "bytes"))).toBe(20);
  });

  test("the declared prefix is never stored", () => {
    const prefixed = domain("ulid", { prefix: "ev" });
    expect(encodePhysicalId(`ev-${ULID}`, prefixed, "bytes")).toEqual(
      encodePhysicalId(ULID, domain("ulid"), "bytes")
    );
  });

  test("a value outside the domain has no physical form", () => {
    expect(encodePhysicalId("nope", domain("uuid"), "bytes")).toBeUndefined();
    expect(
      encodePhysicalId(UUID, domain("uuid", { prefix: "usr" }), "uuid")
    ).toBe(undefined);
  });

  test("a text format has no byte form even when a caller asks for one", () => {
    expect(encodePhysicalId(CUID, domain("cuid"), "bytes")).toBeUndefined();
    expect(encodePhysicalId(NANOID, domain("nanoid"), "bytes")).toBe(undefined);
  });
});

describe("physical decoding", () => {
  test("every driver binary shape decodes to the same public string", () => {
    const raw = bytes("a0eebc999c0b4ef89b6d6bb9bd380a11");
    const shapes: unknown[] = [
      raw,
      Buffer.from(raw),
      raw.buffer.slice(0),
      [...raw],
      hexOf(raw),
      `\\x${hexOf(raw)}`,
      `base64:type252:${Buffer.from(raw).toString("base64")}`,
    ];
    for (const shape of shapes) {
      expect(decodePhysicalId(shape, domain("ulid"), "bytes")).toBe(
        decodePhysicalId(raw, domain("ulid"), "bytes")
      );
    }
  });

  test("bytes decode into each compact format's own canonical text", () => {
    const uuidBytes = bytes("a0eebc999c0b4ef8bb6d6bb9bd380a11");
    expect(decodePhysicalId(uuidBytes, domain("uuid"), "bytes")).toBe(UUID);
    expect(
      decodePhysicalId(
        encodePhysicalId(ULID, domain("ulid"), "bytes"),
        domain("ulid"),
        "bytes"
      )
    ).toBe(ULID);
    expect(
      decodePhysicalId(
        encodePhysicalId(KSUID, domain("ksuid"), "bytes"),
        domain("ksuid"),
        "bytes"
      )
    ).toBe(KSUID);
  });

  test("the declared prefix is re-applied on the way out", () => {
    const prefixed = domain("uuid", { prefix: "usr" });
    expect(
      decodePhysicalId(
        bytes("a0eebc999c0b4ef8bb6d6bb9bd380a11"),
        prefixed,
        "bytes"
      )
    ).toBe(`usr-${UUID}`);
    expect(decodePhysicalId(UUID, prefixed, "uuid")).toBe(`usr-${UUID}`);
    expect(decodePhysicalId(`usr-${UUID}`, prefixed, "text")).toBe(
      `usr-${UUID}`
    );
  });

  test("a PostgreSQL uuid column's text is normalized on the way out", () => {
    expect(decodePhysicalId(UUID.toUpperCase(), domain("uuid"), "uuid")).toBe(
      UUID
    );
  });

  test("a wrong width, a malformed shape and a wrong type all refuse", () => {
    expect(
      decodePhysicalId(bytes("a0eebc99"), domain("uuid"), "bytes")
    ).toBeUndefined();
    expect(decodePhysicalId("zz", domain("uuid"), "bytes")).toBeUndefined();
    expect(decodePhysicalId(7, domain("uuid"), "bytes")).toBeUndefined();
    expect(decodePhysicalId(7, domain("uuid"), "uuid")).toBeUndefined();
    expect(decodePhysicalId("not-a-uuid", domain("uuid"), "uuid")).toBe(
      undefined
    );
    expect(decodePhysicalId("nope", domain("cuid"), "text")).toBeUndefined();
  });

  test("a text format has no byte reading", () => {
    expect(
      decodePhysicalId(bytes("00".repeat(16)), domain("cuid"), "bytes")
    ).toBeUndefined();
  });

  test("a round trip through every representation is the identity", () => {
    const cases: readonly (readonly [IdDomain, string])[] = [
      [domain("uuid"), UUID],
      [domain("uuidv7", { prefix: "ev" }), `ev-${UUID}`],
      [domain("ulid"), ULID],
      [domain("ksuid", { prefix: "k" }), `k-${KSUID}`],
      [domain("nanoid"), NANOID],
      [domain("cuid"), CUID],
    ];
    for (const [subject, value] of cases) {
      const representation = idByteLength(subject.format) ? "bytes" : "text";
      const physical = encodePhysicalId(value, subject, representation);
      expect(decodePhysicalId(physical, subject, representation)).toBe(value);
    }
  });
});

describe("the shared binary shape normalization", () => {
  test("a malformed hex, base64 and byte array each name their shape", () => {
    expect(normalizeBinaryValue("abc").unsupported).toBe("hex string");
    expect(normalizeBinaryValue("base64:type252:*").unsupported).toBe(
      "base64 string"
    );
    expect(normalizeBinaryValue("base64:typeX").unsupported).toBe(
      "base64 string"
    );
    expect(normalizeBinaryValue([1, 2, 300]).unsupported).toBe("byte array");
    expect(normalizeBinaryValue(7).unsupported).toBe("number");
    expect(normalizeBinaryValue(null).unsupported).toBe("object");
  });

  test("an empty base64 payload is an empty byte string", () => {
    expect(normalizeBinaryValue("base64:type252:").bytes).toEqual(
      new Uint8Array()
    );
  });

  test("base64 padding decodes to one and two fewer bytes", () => {
    expect(hexOf(normalizeBinaryValue("base64:type252:AQID").bytes!)).toBe(
      "010203"
    );
    expect(hexOf(normalizeBinaryValue("base64:type252:AQI=").bytes!)).toBe(
      "0102"
    );
    expect(hexOf(normalizeBinaryValue("base64:type252:AQ==").bytes!)).toBe(
      "01"
    );
  });

  test("a typed view is copied out of its buffer, never aliased into it", () => {
    const buffer = new Uint8Array([1, 2, 3, 4]);
    const view = buffer.subarray(1, 3);
    const normalized = normalizeBinaryValue(view).bytes;
    expect(hexOf(normalized)).toBe("0203");
    buffer[1] = 9;
    expect(hexOf(normalized)).toBe("0203");
  });
});
