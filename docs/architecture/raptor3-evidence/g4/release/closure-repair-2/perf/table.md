| cell | pass | baseline CPU µs/op | candidate | CPU ratio | wall ratio | valid | statements B/C |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| bulk-update-returning-100/full | 1 | 129.39 | 121.57 | **0.940** | 0.926 | true | 1/1 |
| bulk-update-returning-100/prepare | 1 | 21.25 | 32.60 | **1.534** | 1.188 | true | 1/1 |
| fixed-collection-rowref-1000/parse | 1 | 454.97 | 309.89 | **0.681** | 0.686 | true | 1/1 |
| key-transition-cascade/full | 1 | 106.87 | 96.81 | **0.906** | 1.027 | true | 3/3 |
| nested-conditional-found/full | 1 | 168.29 | 155.98 | **0.927** | 1.057 | true | 4/5 |
| nested-conditional-missing/full | 1 | 160.17 | 128.35 | **0.801** | 0.891 | true | 4/4 |
| bulk-update-returning-100/full | 2 | 132.43 | 123.12 | **0.930** | 0.924 | true | 1/1 |
| bulk-update-returning-100/prepare | 2 | 20.67 | 31.59 | **1.528** | 1.192 | true | 1/1 |
| fixed-collection-rowref-1000/parse | 2 | 451.60 | 307.67 | **0.681** | 0.686 | true | 1/1 |
| key-transition-cascade/full | 2 | 106.85 | 96.69 | **0.905** | 1.027 | true | 3/3 |
| nested-conditional-found/full | 2 | 171.20 | 166.92 | **0.975** | 1.145 | true | 4/5 |
| nested-conditional-missing/full | 2 | 157.44 | 122.75 | **0.780** | 0.898 | true | 4/4 |

Editorial correction (2026-09-22): `statements B/C` is read from each
checkout's sample witness. The common comparison witness is baseline-shaped and
does not establish the candidate count. For `nested-conditional-found/full`,
the baseline/candidate witnesses are 4/5 statements and 4/5 round trips in both
passes. The corresponding wall medians are 103.709775/109.6641084 µs/op in
pass 1 and 104.8694668/120.0902916 µs/op in pass 2. The measured CPU and wall
ratios above are unchanged.
