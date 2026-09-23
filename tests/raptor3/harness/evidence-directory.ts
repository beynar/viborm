import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Selects the destination used by evidence writers that always retain a copy. */
export async function selectRaptor3EvidenceDirectory(prefix: string) {
  const configured = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
  return (
    configured || (await mkdtemp(join(tmpdir(), prefix)))
  );
}
