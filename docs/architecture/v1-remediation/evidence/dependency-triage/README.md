# Dependency triage evidence

These are the existing 2026-10-09 triage inputs/results, not a new security scan.
The [manifest](manifest.json) records original names, byte lengths, SHA256 hashes,
capture-file timestamps and exact committed input identities. `.txt` suffixes
preserve original receipt and source bytes through repository formatters.

- [Original filtered advisory API input](critical-high-alerts.jsonl.txt): 29 open
  critical/high alert instances; separate version-range and manifest instances
  remain distinct.
- [Original traced result](traced-alerts.json.txt): advisory ranges/fixes and
  observed locked paths, 24 unique advisories, five critical/24 high instances,
  28 repository-tooling instances and one docs Vercel-adapter instance.
- [Locked closure evidence](closure-evidence.json.txt): seven published-runtime
  packages, 90 resolved optional-provider peer packages and the exact selected
  snapshot records supporting those closures and advisory paths. None of the
  29 traced alert instances intersects these consumer/peer closures. This is
  static scope evidence, not an exploit test or a claim about every possible
  version satisfying the public peer ranges.
- [Earlier production audit output](prod-audit-patched.json.txt): zero critical,
  zero high, two moderate and one low advisory. Its original source revision was
  not recorded; the later triage revision must not be assigned to this run.

Small tracked producer inputs are preserved verbatim in `inputs/`. The full
lockfile is not duplicated: its exact committed revision, Git blob, byte length,
SHA256 and permanent source URL are in the manifest. All five input hashes match
both triage revision `9fd7b011b75743a3e3ea8de587354e0192e26d44` and released
revision `3a94e1e8a87f1866449217f96b750ef92264b7ff`. The generated lock index's
original hash is retained; the compact closure receipt keeps its relevant records.

To verify archived bytes with Python's standard library, run from this directory:

```sh
python3 - <<'PY'
import hashlib, json, pathlib
manifest = json.loads(pathlib.Path("manifest.json").read_text())
for item in manifest["files"]:
    data = pathlib.Path(item["path"]).read_bytes()
    assert len(data) == item["bytes"]
    assert hashlib.sha256(data).hexdigest() == item["sha256"]
print("All archived receipt and input bytes match.")
PY
```

No dependencies were installed, executed or changed to create this archive. Alert
API data contains public advisory information and repository alert numbers; no
credentials or private account data are included.
