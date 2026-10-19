import { performance } from "node:perf_hooks";
import { createClient } from "@drivers/sqlite3";
import { ForbiddenError } from "@errors";
import { s } from "@schema";
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

test("policy reuse preserves declaration edits and schema replacement", async () => {
  let evaluations = 0;
  const schema = { post: s.model({ id: s.string().id() }) };
  const base = createClient({ schema, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({ data: [{ id: "one" }, { id: "two" }] });
    const config = {
      actor: v.object({ userId: v.string() }),
      models: {
        post: {
          read: () => {
            evaluations++;
            return { id: "one" };
          },
        },
      },
    };
    const policy = permissions(config);
    const actor = { userId: "alice" };
    const before = base.$extends(policy).$as(actor);
    expect(await before.post.findMany()).toEqual([{ id: "one" }]);
    const first = evaluations;
    await base.$extends(policy).$as(actor).post.findMany();
    expect(evaluations).toBe(first);
    config.models.post.read = () => {
      evaluations++;
      return { id: "two" };
    };
    const after = base.$extends(policy).$as(actor);
    expect(await after.post.findMany()).toEqual([{ id: "two" }]);
    expect(evaluations).toBeGreaterThan(first);
    // A client keeps the declaration as it was applied, even for a model it
    // compiles after the edit.
    expect(await before.post.findMany()).toEqual([{ id: "one" }]);
    const second = evaluations;
    schema.post = s.model({ id: s.string().id() });
    const replaced = createClient({ schema, dataDir: ":memory:" });
    try {
      await syncLiveSchema(replaced);
      await replaced.$extends(policy).$as(actor).post.findMany();
      expect(evaluations).toBeGreaterThan(second);
    } finally {
      await replaced.$disconnect();
    }
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
    const witness = {
      name: "witness",
      client: () => {
        const ordinal = ++factories;
        return { $ordinal: () => ordinal };
      },
    };
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
    let definition: object | undefined;
    policy.rows(
      new Proxy(base, {
        get(target, key, receiver) {
          if (key === "$extends")
            return (value: object) => {
              definition = value;
              return base;
            };
          return Reflect.get(target, key, receiver);
        },
      })
    );
    measure("precompiledApply", () =>
      Reflect.apply(base.$extends, base, [definition])
    );
    measure("precompiledFreshClient", () => {
      const fresh = createClient({ schema, dataDir: ":memory:" });
      return Reflect.apply(fresh.$extends, fresh, [definition]);
    });
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

test("action enumeration changes invalidate reuse", async () => {
  const base = createClient({
    schema: { post: s.model({ id: s.string().id() }) },
    dataDir: ":memory:",
  });
  const model = { read: true };
  const policy = permissions({
    actor: v.object({ userId: v.string() }),
    models: { post: model },
  });
  base.$extends(policy);
  Object.defineProperty(model, "read", { enumerable: false });
  await expect(
    base.$extends(policy).$as({ userId: "alice" }).post.findMany()
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("can and assert answer the actions of the declaration as each application found it", async () => {
  const base = createClient({
    schema: { post: s.model({ id: s.string().id() }) },
    dataDir: ":memory:",
  });
  try {
    await syncLiveSchema(base);
    await base.post.create({ data: { id: "one" } });
    const model: { read: boolean; publish?: boolean } = { read: true };
    const policy = permissions({
      actor: v.object({ userId: v.string() }),
      models: { post: model },
    });
    const actor = { userId: "alice" };
    const before = base.$extends(policy).$as(actor);
    const again = base.$extends(policy).$as(actor);
    expect(await again.post.can("read", { id: "one" })).toBe(true);
    await expect(again.post.can("publish", { id: "one" })).rejects.toThrow(
      ForbiddenError
    );
    // An action added after an application is answered by the next one only.
    model.publish = true;
    const after = base.$extends(policy).$as(actor);
    expect(await after.post.can("publish", { id: "one" })).toBe(true);
    await expect(before.post.can("publish", { id: "one" })).rejects.toThrow(
      ForbiddenError
    );
    // A misspelling introduced later is refused when the policy is applied
    // again, every time, and an unchanged declaration is answered as before.
    Reflect.set(model, "mandatroy", {});
    for (let attempt = 0; attempt < 2; attempt++)
      expect(() => base.$extends(policy)).toThrow('spelled like "mandatory"');
    expect(() => policy.methods(base)).toThrow('spelled like "mandatory"');
    Reflect.deleteProperty(model, "mandatroy");
    const fixed = base.$extends(policy).$as(actor);
    expect(await fixed.post.can(["read", "publish"], { id: "one" })).toEqual({
      read: true,
      publish: true,
    });
    expect(
      await base.$extends(policy).$as(actor).post.can("publish", { id: "one" })
    ).toBe(true);
  } finally {
    await base.$disconnect();
  }
});

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

test("proxy property reads cannot retain a revoked grant", async () => {
  const base = createClient({
    schema: { post: s.model({ id: s.string().id() }) },
    dataDir: ":memory:",
  });
  let allowed = true;
  const model = new Proxy(
    { read: true },
    {
      get(target, key, receiver) {
        return key === "read" ? allowed : Reflect.get(target, key, receiver);
      },
    }
  );
  const policy = permissions({
    actor: v.object({ userId: v.string() }),
    models: { post: model },
  });
  try {
    await syncLiveSchema(base);
    await base.post.create({ data: { id: "one" } });
    expect(
      await base.$extends(policy).$as({ userId: "alice" }).post.findMany()
    ).toEqual([{ id: "one" }]);
    allowed = false;
    expect(
      await base.$extends(policy).$as({ userId: "alice" }).post.findMany()
    ).toEqual([]);
  } finally {
    await base.$disconnect();
  }
});

test("getter-backed rules and mutable Date operands are read on each application", async () => {
  const base = createClient({
    schema: { post: s.model({ id: s.string().id(), at: s.dateTime() }) },
    dataDir: ":memory:",
  });
  let allowed = true;
  const policy = permissions({
    actor: v.object({ userId: v.string() }),
    models: {
      post: {
        get read() {
          return allowed;
        },
      },
    },
  });
  const instant = new Date("2025-01-01T00:00:00Z");
  const dated = permissions({
    actor: v.object({ userId: v.string() }),
    models: { post: { read: { at: instant } } },
  });
  try {
    await syncLiveSchema(base);
    await base.post.createMany({
      data: [
        { id: "one", at: instant },
        { id: "two", at: new Date("2026-01-01T00:00:00Z") },
      ],
    });
    expect(
      await base.$extends(policy).$as({ userId: "alice" }).post.count()
    ).toBe(2);
    allowed = false;
    expect(
      await base.$extends(policy).$as({ userId: "alice" }).post.count()
    ).toBe(0);
    expect(
      await base
        .$extends(dated)
        .$as({ userId: "alice" })
        .post.findMany({ select: { id: true } })
    ).toEqual([{ id: "one" }]);
    expect(Object.isFrozen(instant)).toBe(false);
    instant.setUTCFullYear(2026);
    expect(
      await base
        .$extends(dated)
        .$as({ userId: "alice" })
        .post.findMany({ select: { id: true } })
    ).toEqual([{ id: "two" }]);
  } finally {
    await base.$disconnect();
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
