/**
 * Snowflake key-pair authentication, checked against an independent
 * implementation: the signature verifies with the public key, and the
 * fingerprint is the SHA-256 Node computes over the key's SPKI DER — which is
 * what `DESCRIBE USER` reports as `RSA_PUBLIC_KEY_FP`.
 */

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  jwtAccount,
  pkcs1ToPkcs8,
  privateKeyBytes,
  SnowflakeAuthenticator,
} from "@drivers/snowflake/auth";
import { beforeAll, describe, expect, it } from "vitest";

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

let pkcs8Pem: string;
let pkcs1Pem: string;
let expectedFingerprint: string;
let publicKey: CryptoKey;

const pem = (label: string, der: Uint8Array) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;

const fromBase64Url = (text: string) =>
  Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"]
  );
  publicKey = pair.publicKey;
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey)
  );
  pkcs8Pem = pem("PRIVATE KEY", pkcs8);
  pkcs1Pem = createPrivateKey(pkcs8Pem)
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  const spki = createPublicKey(pkcs8Pem).export({ type: "spki", format: "der" });
  expectedFingerprint = `SHA256:${createHash("sha256").update(spki).digest("base64")}`;
});

async function decode(token: string) {
  const [header, payload, signature] = token.split(".");
  const verified = await crypto.subtle.verify(
    RSA,
    publicKey,
    fromBase64Url(signature!),
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return {
    header: JSON.parse(fromBase64Url(header!).toString("utf8")),
    payload: JSON.parse(fromBase64Url(payload!).toString("utf8")),
    verified,
  };
}

describe("Snowflake key-pair JWT", () => {
  it("signs RS256 claims Snowflake reads: upper-case account and user, SPKI fingerprint, one hour", async () => {
    const now = 1_700_000_000_000;
    const auth = new SnowflakeAuthenticator(
      { account: "myorg-acct.privatelink", username: "reader", privateKey: pkcs8Pem },
      () => now
    );
    const { token, type } = await auth.authorization();
    expect(type).toBe("KEYPAIR_JWT");
    const { header, payload, verified } = await decode(token);
    expect(verified).toBe(true);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({
      iss: `MYORG-ACCT.READER.${expectedFingerprint}`,
      sub: "MYORG-ACCT.READER",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });

  it("accepts a PKCS#1 key, wrapped into the PKCS#8 WebCrypto imports", async () => {
    expect(pkcs1Pem).toContain("BEGIN RSA PRIVATE KEY");
    const auth = new SnowflakeAuthenticator({
      account: "a",
      username: "u",
      privateKey: pkcs1Pem,
    });
    const { payload, verified } = await decode(
      (await auth.authorization()).token
    );
    expect(verified).toBe(true);
    expect(payload.iss).toBe(`A.U.${expectedFingerprint}`);
    // The wrapper is the exact PKCS#8 encoding Node writes for the same key.
    const pkcs1Der = createPrivateKey(pkcs8Pem).export({
      type: "pkcs1",
      format: "der",
    });
    expect(Buffer.from(pkcs1ToPkcs8(new Uint8Array(pkcs1Der)))).toEqual(
      Buffer.from(privateKeyBytes(pkcs8Pem))
    );
  });

  it("reuses the token until a minute before it expires, then signs a new one", async () => {
    let now = 1_700_000_000_000;
    const auth = new SnowflakeAuthenticator(
      { account: "a", username: "u", privateKey: pkcs8Pem },
      () => now
    );
    const first = (await auth.authorization()).token;
    now += 3_539_000;
    expect((await auth.authorization()).token).toBe(first);
    now += 1000;
    const renewed = (await auth.authorization()).token;
    expect(renewed).not.toBe(first);
    expect((await decode(renewed)).payload.iat).toBe(1_700_003_540);
  });

  it("names the account as a JWT does: no region, no suffix, upper case", () => {
    expect(jwtAccount("xy12345.us-east-1")).toBe("XY12345");
    expect(jwtAccount("myorg-myaccount")).toBe("MYORG-MYACCOUNT");
  });
});

describe("Snowflake credentials", () => {
  it("sends an OAuth token as given, or as its function answers it", async () => {
    let calls = 0;
    const auth = new SnowflakeAuthenticator({
      account: "a",
      token: () => `t${++calls}`,
    });
    expect(await auth.authorization()).toEqual({ token: "t1", type: "OAUTH" });
    expect(await auth.authorization()).toEqual({ token: "t2", type: "OAUTH" });
    expect(
      await new SnowflakeAuthenticator({
        account: "a",
        token: "pat",
        tokenType: "PROGRAMMATIC_ACCESS_TOKEN",
      }).authorization()
    ).toEqual({ token: "pat", type: "PROGRAMMATIC_ACCESS_TOKEN" });
  });

  it("refuses no credential, two credentials and a key without its user", () => {
    expect(() => new SnowflakeAuthenticator({ account: "a" })).toThrow(
      "exactly one credential"
    );
    expect(
      () =>
        new SnowflakeAuthenticator({
          account: "a",
          username: "u",
          privateKey: pkcs8Pem,
          token: "t",
        })
    ).toThrow("exactly one credential");
    expect(
      () => new SnowflakeAuthenticator({ account: "a", privateKey: pkcs8Pem })
    ).toThrow("needs the username");
  });

  it("refuses an encrypted key and a PEM that is not a private key, before any request", async () => {
    expect(() =>
      privateKeyBytes(
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----"
      )
    ).toThrow("is encrypted");
    expect(() =>
      privateKeyBytes(
        "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"
      )
    ).toThrow("is not an RSA private key");
    await expect(
      new SnowflakeAuthenticator({
        account: "a",
        username: "u",
        privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
      }).authorization()
    ).rejects.toThrow("could not be imported");
  });
});
