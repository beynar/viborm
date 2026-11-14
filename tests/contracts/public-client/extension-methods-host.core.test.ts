/**
 * The methods host runs one `methods` factory per view and checks what it
 * returns; a first moment refuses a promise and, in `call`, a function. Each
 * test states one refusal or one answer through the public builders.
 */

import { createClient } from "@drivers/sqlite3";
import { ClientInitializationError, QueryError } from "@errors";
import { s } from "@schema";
import { call, extension, methods } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({ id: s.string().id(), name: s.string() });
const post = s.model({ id: s.string().id(), title: s.string() });
const schema = { user, post };

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
  [method: string]: unknown;
}
// The chains below are applied whatever their declared state: only their
// behaviour is read.
interface Loose {
  user: Delegate;
  post: Delegate;
  $extends(value: unknown): Loose;
  $transaction<T>(run: (tx: Loose) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
  [member: string]: unknown;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function seeded(): Promise<Loose> {
  const base = createClient({ schema, dataDir: ":memory:" }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  await base.post.create({ data: { id: "a", title: "one" } });
  return base;
}

const returning = (name: string, value: unknown) =>
  extension(
    name,
    methods(() => value as never)
  );

describe("methods: what the factory returns", () => {
  test("a factory that throws, or returns no object, is refused where the view is made", async () => {
    const base = await seeded();
    expect(() =>
      base.$extends(
        extension(
          "throws",
          methods(() => {
            throw new Error("no");
          })
        )
      )
    ).toThrow(ClientInitializationError);
    expect(() =>
      base.$extends(
        extension(
          "throws-again",
          methods(() => {
            throw new Error("no");
          })
        )
      )
    ).toThrow('Extension "throws-again" methods factory failed.');
    expect(() => base.$extends(returning("number", 1))).toThrow(
      'Extension "number" methods factory must return an object.'
    );
    expect(() => base.$extends(returning("bare", { hello: () => 1 }))).toThrow(
      'Extension "bare" methods returned "hello", which is neither a $ client method nor a model.'
    );
  });

  test("a client method is a function that takes no name the client already answers", async () => {
    const base = await seeded();
    expect(() => base.$extends(returning("value", { $value: 1 }))).toThrow(
      'Extension "value" client method "$value" must be a function.'
    );
    for (const name of ["$transaction", "$queryRaw"])
      expect(() =>
        base.$extends(returning("core", { [name]: () => 1 }))
      ).toThrow(
        `Extension "core" client method "${name}" collides with the existing client surface.`
      );
  });

  test("a model entry is an object of methods, or a function of its delegate and the scope", async () => {
    const base = await seeded();
    expect(() => base.$extends(returning("entry", { post: 1 }))).toThrow(
      'Extension "entry" methods.post must be an object of methods.'
    );
    for (const name of ["findMany", "then", "$rows"])
      expect(() =>
        base.$extends(returning("model", { post: { [name]: () => 1 } }))
      ).toThrow(
        `Extension "model" model method "post.${name}" collides with the existing model surface.`
      );
    const scoped = base.$extends(
      returning("scoped", {
        post: (delegate: Delegate, scope: Loose) => ({
          same: () => delegate === scope.post,
          async total(this: Delegate) {
            return (await this.findMany()).length;
          },
        }),
      })
    );
    expect((scoped.post.same as () => boolean)()).toBe(true);
    expect(await (scoped.post.total as () => Promise<number>)()).toBe(1);
    // A model the factory leaves out answers what the chain before it did.
    expect(await scoped.user.findMany()).toEqual([]);
  });

  test("the factory runs once per view: at once for the client $extends returns, at first use in a transaction", async () => {
    const base = await seeded();
    let runs = 0;
    const client = base.$extends(
      extension(
        "counted",
        methods(() => {
          runs += 1;
          return { $hello: () => "hi", post: { hello: () => "post" } };
        })
      )
    );
    expect(runs).toBe(1);
    expect((client.$hello as () => string)()).toBe("hi");
    expect((client.post.hello as () => string)()).toBe("post");
    expect(runs).toBe(1);
    await client.$transaction(async (tx) => {
      expect(runs).toBe(1);
      expect((tx.post.hello as () => string)()).toBe("post");
      expect((tx.$hello as () => string)()).toBe("hi");
    });
    expect(runs).toBe(2);
  });
});

describe("call: what a first moment returns", () => {
  test("a promise is refused, and a function in a call (write around())", async () => {
    const base = await seeded();
    const refused = async (name: string, handler: () => unknown) => {
      const client = base.$extends(extension(name, call(handler as never)));
      const error = await client.post.findMany().then(
        () => undefined,
        (failure: unknown) => failure
      );
      expect(error).toBeInstanceOf(QueryError);
      return error;
    };
    expect(await refused("async", async () => undefined)).toMatchObject({
      message: 'Extension "async" first moment for post.findMany returned a promise.',
    });
    expect(await refused("wraps", () => () => undefined)).toMatchObject({
      message:
        'Extension "wraps" first moment for post.findMany returned a function: write around().',
    });
  });
});
