import { defineConfig } from "@src/config";
import { createClient } from "@src/drivers/sqlite3";
import { s } from "@src/schema";

const user = s.model({ id: s.int().id(), name: s.string() });
const client = createClient({ schema: { user } });
const config = defineConfig({ client, migrations: { dir: "./migrations" } });
config.client.user.findMany({ where: { name: "Ada" } });

// A real key beside the typo pins the public factory, including held values.
// @ts-expect-error unknown configuration option
defineConfig({ client, clent: client });
const typo = { client, clent: client };
// @ts-expect-error unknown configuration option held in a variable
defineConfig(typo);
