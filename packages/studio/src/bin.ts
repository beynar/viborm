#!/usr/bin/env node
// The `viborm-studio` executable: `main` with the process's arguments.
import { main } from "./cli";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
);
