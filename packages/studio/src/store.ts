/**
 * What the page remembers of a project — its saved views, the diagram's layout — kept in one file per project
 * under the user's home (`~/.viborm/studio`), named after the config's path: the same whatever port the studio
 * takes, in whichever browser. The file says which config it is for.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StoredName, StudioStore } from "./api";

export const defaultStoreDir = () => join(homedir(), ".viborm", "studio");

/** The project's file, and what a write tells (the other pages, so they read it again). */
export function projectStore(
  dir: string,
  project: string,
  written: (name: StoredName) => void
): StudioStore {
  const file = join(
    dir,
    `${createHash("sha256").update(project).digest("hex").slice(0, 16)}.json`
  );
  const read = async (): Promise<Record<string, unknown>> => {
    try {
      const kept: unknown = JSON.parse(await readFile(file, "utf8"));
      return typeof kept === "object" && kept !== null ? { ...kept } : {};
    } catch {
      // Not yet written, or not JSON: nothing kept.
      return {};
    }
  };
  // One write at a time: each reads the file the previous one left, so the views kept while the layout is
  // (two requests at once) both stay.
  let writing: Promise<void> = Promise.resolve();
  const write = async (name: StoredName, value: unknown) => {
    const kept = { ...(await read()), project, [name]: value };
    await mkdir(dir, { recursive: true });
    // Written whole, then moved in place: a reader never sees half of it.
    const draft = `${file}.${randomUUID()}.tmp`;
    await writeFile(draft, `${JSON.stringify(kept, null, 2)}\n`);
    await rename(draft, file);
    written(name);
  };
  return {
    async read(name) {
      return (await read())[name];
    },
    write(name, value) {
      const next = writing.then(() => write(name, value));
      // A failed write fails its own request only: the next one still runs.
      writing = next.catch(() => undefined);
      return next;
    },
  };
}
