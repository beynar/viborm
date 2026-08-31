import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { ConnectionError } from "@errors";
import { describe, expect, it } from "vitest";

const RESET = "pg_advisory_unlock_all";

function failResetOn(
  client: PGlite,
  rejectWith: unknown = new Error("the session is gone")
): void {
  const answer: unknown = Reflect.get(client, "query");
  Object.defineProperty(client, "query", {
    configurable: true,
    value: (sql: string, params?: unknown[]) =>
      sql.includes(RESET)
        ? Promise.reject(rejectWith)
        : Reflect.apply(
            typeof answer === "function" ? answer : () => undefined,
            client,
            [sql, params]
          ),
  });
}

function discardingBody(): (
  pinned: unknown,
  control: { discard(): void }
) => Promise<string> {
  return (_pinned, control) => {
    control.discard();
    return Promise.resolve("done");
  };
}

function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => new Error("the pinned session was expected to fail"),
    (error: unknown) => error
  );
}

function prototypeTrapProxy(): unknown {
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    }
  );
}

describe("PGlite condemns the one client it cannot hand back", () => {
  it("refuses every later pinned session on a client it cannot prove clean", async () => {
    const client = new PGlite();
    try {
      failResetOn(client);
      const driver = new PGliteDriver({ client, namespace: "public" });
      const thrown = await rejection(
        driver._withPinnedSession(discardingBody())
      );
      expect(thrown instanceof Error ? thrown.message : "").toContain(
        "advisory-lock state"
      );
      const second = await rejection(
        driver._withPinnedSession(() => Promise.resolve(1))
      );
      expect(second instanceof Error ? second.message : "").toContain(
        "advisory-lock state"
      );
      const rows = await driver._executeRaw("SELECT 1 AS one");
      expect(rows.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  it("refuses pinning through EVERY wrapper over that one client", async () => {
    const shared = new PGlite();
    const independent = new PGlite();
    try {
      failResetOn(shared);
      const alpha = new PGliteDriver({ client: shared, namespace: "public" });
      const beta = new PGliteDriver({ client: shared, namespace: "public" });
      const elsewhere = new PGliteDriver({
        client: independent,
        namespace: "public",
      });
      const condemning = await rejection(
        alpha._withPinnedSession(discardingBody())
      );
      expect(condemning instanceof Error ? condemning.message : "").toContain(
        "advisory-lock state"
      );
      let entered = false;
      const refused = await rejection(
        beta._withPinnedSession(() => {
          entered = true;
          return Promise.resolve("body ran");
        })
      );
      expect(entered).toBe(false);
      expect(refused instanceof Error ? refused.message : "").toContain(
        "advisory-lock state"
      );
      await expect(
        elsewhere._withPinnedSession(() => Promise.resolve("ok"))
      ).resolves.toBe("ok");
    } finally {
      await shared.close();
      await independent.close();
    }
  });

  it("stays usable when the reset SUCCEEDS", async () => {
    const client = new PGlite();
    try {
      const driver = new PGliteDriver({ client, namespace: "public" });
      await driver._withPinnedSession(discardingBody());
      await expect(
        driver._withPinnedSession(() => Promise.resolve("again"))
      ).resolves.toBe("again");
    } finally {
      await client.close();
    }
  });

  it("keeps its typed refusal when the reset rejects with a hostile value", async () => {
    const client = new PGlite();
    try {
      failResetOn(client, prototypeTrapProxy());
      const driver = new PGliteDriver({ client, namespace: "public" });
      const thrown = await rejection(
        driver._withPinnedSession(discardingBody())
      );
      expect(thrown).toBeInstanceOf(ConnectionError);
      expect(thrown instanceof Error ? thrown.message : "").toContain(
        "advisory-lock state"
      );
      expect(
        thrown instanceof ConnectionError ? thrown.originalCause : undefined
      ).toBeInstanceOf(Error);
      const second = await rejection(
        driver._withPinnedSession(() => Promise.resolve(1))
      );
      expect(second instanceof Error ? second.message : "").toContain(
        "will pin no further migration session"
      );
      const rows = await driver._executeRaw("SELECT 1 AS one");
      expect(rows.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  it("refuses an already-admitted command through a second wrapper", async () => {
    const shared = new PGlite();
    const independent = new PGlite();
    try {
      failResetOn(shared);
      const alpha = new PGliteDriver({ client: shared, namespace: "public" });
      const beta = new PGliteDriver({ client: shared, namespace: "public" });
      const elsewhere = new PGliteDriver({
        client: independent,
        namespace: "public",
      });
      let alphaEntered!: () => void;
      const running = new Promise<void>((resolve) => {
        alphaEntered = resolve;
      });
      let releaseAlpha!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseAlpha = resolve;
      });
      const condemning = rejection(
        alpha._withPinnedSession(async (_pinned, control) => {
          alphaEntered();
          await held;
          control.discard();
          return "done";
        })
      );
      await running;
      let bodyRan = false;
      const refused = rejection(
        beta._withPinnedSession(async (pinned) => {
          bodyRan = true;
          await pinned._executeRaw("CREATE TABLE beta_ran (id int)");
          return "body ran";
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseAlpha();
      const condemnation = await condemning;
      expect(
        condemnation instanceof Error ? condemnation.message : ""
      ).toContain("advisory-lock state");
      const outcome = await refused;
      expect(bodyRan).toBe(false);
      expect(outcome instanceof Error ? outcome.message : "").toContain(
        "will pin no further migration session"
      );
      const created = await alpha._executeRaw(
        "SELECT to_regclass('beta_ran') AS present"
      );
      expect(created.rows).toEqual([{ present: null }]);
      await expect(
        elsewhere._withPinnedSession(() => Promise.resolve("ok"))
      ).resolves.toBe("ok");
    } finally {
      await shared.close();
      await independent.close();
    }
  });
});
