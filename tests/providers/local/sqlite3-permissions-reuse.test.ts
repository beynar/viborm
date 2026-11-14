import { performance } from "node:perf_hooks";
import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { extension, methods } from "@src/index";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { expect, test } from "vitest";

test("reusing one policy on one base avoids recompiling its rules", async () => {
  let evaluations = 0;
  const base = createClient({
    schema: { post: s.model({ id: s.string().id() }) },
    dataDir: ":memory:",
  });
  try {
    await syncLiveSchema(base);
    const policy = permissions({
      actor: v.object({ userId: v.string() }),
      models: {
        post: {
          read: () => {
            evaluations++;
            return true;
          },
        },
      },
    });
    // A model compiles at its first call, not when the policy is applied.
    const first = base.$extends(policy).$as({ userId: "alice" });
    expect(evaluations).toBe(0);
    await first.post.findMany();
    const compiled = evaluations;
    expect(compiled).toBeGreaterThan(0);
    await base.$extends(policy).$as({ userId: "bob" }).post.findMany();
    expect(evaluations).toBe(compiled);
  } finally {
    await base.$disconnect();
  }
});

test("reused policy keeps clients, factories, actors, scopes and transactions separate", async () => {
  const schema = {
    post: s.model({ id: s.string().id(), ownerId: s.string() }),
  };
  const config = {
    actor: v.object({ userId: v.string() }),
    models: {
      post: {
        read: { ownerId: { actor: "userId" } },
        update: { ownerId: { actor: "userId" } },
      },
    },
  } as const;
  const policy = permissions(config);
  const a = createClient({ schema, dataDir: ":memory:" });
  const b = createClient({ schema, dataDir: ":memory:" });
  try {
    await syncLiveSchema(a);
    await syncLiveSchema(b);
    await a.post.createMany({
      data: [
        { id: "a1", ownerId: "alice" },
        { id: "a2", ownerId: "bob" },
      ],
    });
    await b.post.create({ data: { id: "b1", ownerId: "alice" } });
    let factories = 0;
    const witness = extension(
      "witness",
      methods(() => {
        const ordinal = ++factories;
        return { $ordinal: () => ordinal };
      })
    );
    const first = a.$extends(policy).$extends(witness);
    const again = a.$extends(policy).$extends(witness);
    const other = b.$extends(policy).$extends(witness);
    expect(first).not.toBe(again);
    expect([first.$ordinal(), again.$ordinal(), other.$ordinal()]).toEqual([
      1, 2, 3,
    ]);
    const inspection = policy.compile(schema);
    for (const predicate of Object.values(inspection.models.post!.predicates))
      Reflect.set(predicate, "OR", []);
    const read = a.$extends(policy);
    expect(await read.$as({ userId: "alice" }).post.findMany()).toEqual([
      { id: "a1", ownerId: "alice" },
    ]);
    expect(await again.$as({ userId: "bob" }).post.findMany()).toEqual([
      { id: "a2", ownerId: "bob" },
    ]);
    expect(await other.$as({ userId: "alice" }).post.findMany()).toEqual([
      { id: "b1", ownerId: "alice" },
    ]);
    expect(await read.$as({ userId: "alice" }, []).post.findMany()).toEqual([]);
    expect(
      await read
        .$as({ userId: "alice" }, ["post.update"])
        .$transaction((tx) => tx.post.findMany())
    ).toEqual([{ id: "a1", ownerId: "alice" }]);
    expect(Object.isFrozen(config.models.post.read)).toBe(false);
    expect(Object.isFrozen(config.models.post.read.ownerId)).toBe(false);
  } finally {
    await a.$disconnect();
    await b.$disconnect();
  }
});

test.skipIf(!process.env.VIBORM_POLICY_TIMINGS)(
  "measure acceptance policy application",
  async () => {
    const { policy } = await import(
      "@tests/types/permissions/acceptance-policy"
    );
    const { schema } = await import(
      "@tests/package/fixtures/permissions-app/schema"
    );
    const base = createClient({ schema, dataDir: ":memory:" });
    const samples: Record<string, number[]> = {};
    const measure = (name: string, run: () => unknown, count = 20) => {
      const times: number[] = [];
      for (let i = 0; i < count; i++) {
        const start = performance.now();
        run();
        times.push(performance.now() - start);
      }
      samples[name] = times;
    };
    if (process.env.VIBORM_POLICY_CPU_PROFILE) {
      const { Session } = await import("node:inspector/promises");
      const { writeFileSync } = await import("node:fs");
      const session = new Session();
      session.connect();
      try {
        await session.post("Profiler.enable");
        await session.post("Profiler.start");
        measure("compile", () => policy.compile(base.$schema), 5);
        const { profile } = await session.post("Profiler.stop");
        writeFileSync(
          process.env.VIBORM_POLICY_CPU_PROFILE,
          JSON.stringify(profile)
        );
      } finally {
        session.disconnect();
      }
    } else measure("compile", () => policy.compile(base.$schema));
    if (process.env.VIBORM_POLICY_COMPILED_OUTPUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        process.env.VIBORM_POLICY_COMPILED_OUTPUT,
        JSON.stringify(policy.compile(base.$schema))
      );
    }
    measure("apply", () => base.$extends(policy));
    measure("freshClientApply", () =>
      createClient({ schema, dataDir: ":memory:" }).$extends(policy)
    );
    const governed = base.$extends(policy);
    measure(
      "bind",
      () =>
        governed.$as({
          userId: "alice",
          organizationId: "org",
          network: "office",
        }),
      100
    );
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(samples).map(([name, values]) => [
            name,
            {
              first: values[0],
              median: [...values].sort((a, b) => a - b)[
                Math.floor(values.length / 2)
              ],
              samples: values,
            },
          ])
        )
      )
    );
  }
);

test("policy copying preserves non-enumerable array items and proxy operands", () => {
  const base = createClient({
    schema: { post: s.model({ id: s.string().id() }) },
    dataDir: ":memory:",
  });
  const values = ["one"];
  Object.defineProperty(values, "0", { enumerable: false });
  for (const items of [values, new Proxy(["one"], {})]) {
    const policy = permissions({
      actor: v.object({ userId: v.string() }),
      models: { post: { read: { id: { in: items } } } },
    });
    expect(() => base.$extends(policy)).not.toThrow();
  }
});

test.skipIf(!process.env.VIBORM_POLICY_COLD_TIMINGS)(
  "measure cold permissions through the first read",
  async () => {
    const { policy } = await import(
      "@tests/types/permissions/acceptance-policy"
    );
    const { schema } = await import(
      "@tests/package/fixtures/permissions-app/schema"
    );
    const base = createClient({ schema, dataDir: ":memory:" });
    try {
      const start = performance.now();
      const fresh = permissions(policy.config);
      const governed = base.$extends(fresh);
      const application = performance.now() - start;
      // Exclude fixture DDL/connection setup from extension overhead.
      await syncLiveSchema(base);
      const reading = performance.now();
      const rows = await governed
        .$as({
          userId: "u01",
          organizationId: "org1",
          network: "office",
          session: "s-u01",
        })
        .page.findMany({ select: { id: true } });
      const firstRead = performance.now() - reading;
      expect(rows).toEqual([]);
      console.log(
        JSON.stringify({
          cold: { application, firstRead, total: application + firstRead },
        })
      );
    } finally {
      await base.$disconnect();
    }
  }
);
