# Bun / Vitest historical evidence

This bundle preserves the actual macOS experiment at revision `3a94e1e8a87f1866449217f96b750ef92264b7ff`. No experiment was rerun to create this archive.

- [Original per-child receipts](receipts.json.txt): all 17 exits, counts, elapsed/RSS measurements, runtime witnesses and teardown outcomes.
- [Original environment/input summary](summary.json.txt).
- [Path and hash index](index.json): every historical path resolves to a durable file; tracked configuration, resource owners and test inputs resolve to the exact Git revision, with SHA256 hashes.
- [Checksums](SHA256SUMS): run `shasum -a 256 -c SHA256SUMS` from this directory.
- [Supervisor](inputs/run.mjs.txt), [runtime witness](inputs/runtime.cjs.txt), [native/inspector probes](inputs/bun-compatibility-probe.mjs.txt), and [worker/failure probe](inputs/bun-runtime-refusal-experiment.core.test.ts.txt).

The `.txt` files preserve original bytes and names without making historical scratch source part of the current lint or test selection. JSON receipts can be parsed directly despite the suffix. Raw stdout/stderr is encoded losslessly in [logs.json](logs.json), keyed by each original log basename. JSON escapes preserve trailing whitespace and every newline without violating the repository whitespace gate. The index retains each decoded log’s original byte length/SHA256 and pairs it with its child receipt. `SHA256SUMS` hashes the actual container and directly archived files; decoded log hashes are verified separately below. Expected negative controls and unsupported-runtime failures retain their nonzero exits. The supervisor collecting a receipt does not convert its child into a passing test.

For reproduction, check out the indexed revision into a separate physical workspace and restore the frozen lockfile dependencies. Restore the two scratch probes at their recorded checkout-relative paths and the supervisor/runtime witness at their recorded paths, or adapt only those machine-specific paths to the new workspace. Use the receipt's recorded arguments and the report's coverage environment variables; do not replace Vitest with `bun test`. The Node supervisor imports the revision's unchanged resource/lock owners. Its final retained form includes direct-probe support added during the experiment; earlier invocations are represented by `vitestArguments`, later ones by `forwardedArguments`/`actualCommandArguments`. No earlier supervisor byte snapshot is asserted. The enriched receipt fields and summary are retained as historical results, not newly generated output from the archived supervisor.

The installed dependency tree, native binaries and coverage build outputs are intentionally not copied. Their locked versions and original inputs remain indexed. Reproduction on another runtime or host is a new measurement, not validation of the historical timing. Supplying Node's heap flag to Bun does not establish a JavaScriptCore heap limit; the recorded external wall/RSS/teardown limits still apply.

## Verify or recover the original logs

From this directory, the standard-library-only snippet verifies all historical byte hashes and recovers logs to a new private directory:

```python
import hashlib
import json
import pathlib
import tempfile

root = pathlib.Path.cwd()
index = json.loads((root / "index.json").read_bytes())
containers = {}
recovered = pathlib.Path(tempfile.mkdtemp(prefix="bun-vitest-logs-"))
for item in index["archivedFiles"]:
    if "container" in item:
        name = item["container"]
        if name not in containers:
            containers[name] = json.loads((root / name).read_bytes())
        data = containers[name][item["jsonKey"]].encode("utf-8")
        (recovered / item["jsonKey"]).write_bytes(data)
    else:
        data = (root / item["path"]).read_bytes()
    assert len(data) == item["bytes"]
    assert hashlib.sha256(data).hexdigest() == item["sha256"]
print("Verified 23 originals; recovered logs:", recovered)
```
