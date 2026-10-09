# Dependabot critical/high release triage

No confirmed critical/high risk shipped in the VibORM npm consumer runtime or its currently resolved optional-provider peer closure. 28 alerts reach repository dev/test/build tooling; one high reaches a docs dependency through the unselected Vercel adapter. Do not describe the whole workspace as vulnerability-free.

Revision: `9fd7b011b75743a3e3ea8de587354e0192e26d44`. Read-only triage; no dependency or source changes. The released source `3a94e1e8a87f1866449217f96b750ef92264b7ff` retains the same dependency declarations and lockfile.

| Package/version | Severity and advisory | Current scope |
|---|---|---|
| sharp@0.33.5 | high [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) | Repository dev/test/build only |
| source-map-js@1.2.1 | high [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | Repository dev/test/build only |
| tinypool@1.0.2 | critical [GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) | Repository dev/test/build only |
| tinypool@1.0.2 | critical [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) | Repository dev/test/build only |
| devalue@5.9.0 | high [GHSA-j22f-vq7h-c4qm](https://github.com/advisories/GHSA-j22f-vq7h-c4qm) | Repository dev/test/build only |
| @grpc/grpc-js@1.14.3 | high [GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j) | Repository dev/test/build only |
| sharp@0.33.5 | high [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) | Repository dev/test/build only |
| undici@7.14.0 | high [GHSA-4cwx-7wf7-3272](https://github.com/advisories/GHSA-4cwx-7wf7-3272) | Repository dev/test/build only |
| postcss@8.5.3 | high [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | Repository dev/test/build only |
| postcss@8.5.3 | high [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) | Repository dev/test/build only |
| sharp@0.33.5 | high [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) | Repository dev/test/build only |
| ws@8.18.0 | high [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) | Repository dev/test/build only |
| vitest@3.1.4 | critical [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) | Repository dev/test/build only |
| protobufjs@7.5.4, protobufjs@8.0.0 | high [GHSA-66ff-xgx4-vchm](https://github.com/advisories/GHSA-66ff-xgx4-vchm) | Repository dev/test/build only |
| protobufjs@7.5.4, protobufjs@8.0.0 | high [GHSA-75px-5xx7-5xc7](https://github.com/advisories/GHSA-75px-5xx7-5xc7) | Repository dev/test/build only |
| protobufjs@7.5.4, protobufjs@8.0.0 | high [GHSA-jvwf-75h9-cwgg](https://github.com/advisories/GHSA-jvwf-75h9-cwgg) | Repository dev/test/build only |
| protobufjs@7.5.4, protobufjs@8.0.0 | critical [GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg) | Repository dev/test/build only |
| defu@6.1.4 | high [GHSA-737v-mqg7-c878](https://github.com/advisories/GHSA-737v-mqg7-c878) | Repository dev/test/build only |
| flatted@3.3.3 | high [GHSA-rf6f-7fwh-wjgh](https://github.com/advisories/GHSA-rf6f-7fwh-wjgh) | Repository dev/test/build only |
| undici@7.14.0 | high [GHSA-f269-vfmq-vjvj](https://github.com/advisories/GHSA-f269-vfmq-vjvj) | Repository dev/test/build only |
| minimatch@10.1.1 | high [GHSA-7r86-cg39-jmmj](https://github.com/advisories/GHSA-7r86-cg39-jmmj) | Repository dev/test/build only |
| rollup@4.41.1 | high [GHSA-mw96-cpmx-2vgc](https://github.com/advisories/GHSA-mw96-cpmx-2vgc) | Repository dev/test/build only |
| wrangler@4.44.0 | high [GHSA-36p8-mvp6-cv38](https://github.com/advisories/GHSA-36p8-mvp6-cv38) | Repository dev/test/build only |
| path-to-regexp@6.1.0 | high [GHSA-9wv6-86v2-598j](https://github.com/advisories/GHSA-9wv6-86v2-598j) | Docs: Blume → Vercel adapter; current deployment is Cloudflare |

The five critical alert instances are two Tinypool advisories through Vitest, Vitest’s UI-server advisory, and two version-range instances of the protobufjs code-execution advisory through development OpenTelemetry exporters. They remain open; the npm consumer runtime does not depend on these packages.

codebase-health-12 verified-fixed concerns enabling security tooling, not resolving every alert; it does not adjudicate these 29 current alerts.

migrations.md dependency security checkpoint records earlier production audit: 0 critical/0 high, 2 moderate/1 low; existing machine output /tmp/viborm-v1-prod-audit-patched.json agrees with that historical audit. The security-tooling ledger row does not adjudicate these alerts; this report records their separate scope.

The docs high remains installed: `blume → @astrojs/vercel → @vercel/routing-utils → path-to-regexp@6.1.0`. The Vercel helper still invokes the old version even though it also loads 6.3.0 under an alias. The docs configuration selects Cloudflare. This evidence does not establish public Cloudflare-worker exposure, and it does not waive the installed docs/tooling advisory.

Exact package paths, ranges, patched versions and input hashes: `/tmp/viborm-v1-dependabot-traced-alerts.json`.
