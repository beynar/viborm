import { SQLite3Driver } from "@src/drivers/sqlite3";
import { createClient, s } from "@src/index";

export const probeGeneration = () => {
  const model = s.model({
    id: s.string().id(),
    name: s.string(),
    externalRef: s.string().uuid(),
  });
  const client = createClient({
    schema: { model },
    driver: new SQLite3Driver(),
  });
  // @ts-expect-error - a format on a non-key field requires its value
  client.model.create({ data: { name: "record" } });
  client.model.create({
    data: {
      name: "record",
      externalRef: "00000000-0000-4000-8000-000000000000",
    },
  });
  const natural = createClient({
    schema: {
      model: s.model({
        id: s.string().id({ generate: false }),
        name: s.string(),
      }),
    },
    driver: new SQLite3Driver(),
  });
  // @ts-expect-error - a natural key has no implicit default
  natural.model.create({ data: { name: "record" } });
  natural.model.create({ data: { id: "FR", name: "France" } });
  const optedOut = createClient({
    schema: {
      model: s.model({
        id: s.string().id().id({ generate: false }),
        name: s.string(),
      }),
    },
    driver: new SQLite3Driver(),
  });
  // @ts-expect-error - disabling a previously installed generator restores required input
  optedOut.model.create({ data: { name: "record" } });
  const generated = createClient({
    schema: {
      model: s.model({
        id: s.string().id(),
        ref: s.string().uuid({ generate: true }),
      }),
    },
    driver: new SQLite3Driver(),
  });
  generated.model.create({ data: {} });
};

s.string().uuid({ generate: true });
const formatTypo = { generate: true, genrate: true } as const;
// @ts-expect-error - unknown option beside a real one, held
s.string().uuid(formatTypo);
// @ts-expect-error - unknown option beside a real one, fresh
s.string().uuid({ generate: true, genrate: true });
const keyTypo = { generate: false, genrate: false } as const;
// @ts-expect-error - unknown key option beside a real one, held
s.string().id(keyTypo);
// @ts-expect-error - unknown key option beside a real one, fresh
s.string().id({ generate: false, genrate: false });

export const probeRefinedArithmetic = () => {
  const positive = {
    "~standard": {
      version: 1 as const,
      vendor: "v1",
      validate(value: unknown) {
        return typeof value === "number" && value > 0
          ? { value }
          : { issues: [{ message: "positive" }] };
      },
    },
  };
  const client = createClient({
    schema: {
      model: s.model({
        id: s.string().id(),
        amount: s.number().schema(positive),
      }),
    },
    driver: new SQLite3Driver(),
  });
  client.model.update({ where: { id: "key" }, data: { amount: { set: 2 } } });
  client.model.update({
    where: { id: "key" },
    // @ts-expect-error - arithmetic cannot prove the resulting custom refinement
    data: { amount: { increment: 2 } },
  });
};
