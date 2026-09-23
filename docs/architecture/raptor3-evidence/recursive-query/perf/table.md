| cell | pass | baseline CPU µs/op | candidate | CPU ratio | wall ratio | valid | statements B/C |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| bulk-update-returning-100/full | 1 | 131.17 | 126.31 | **0.963** | 0.981 | true | 1/1 |
| bulk-update-returning-100/prepare | 1 | 21.58 | 33.59 | **1.557** | 1.201 | true | 1/1 |
| fixed-collection-rowref-1000/parse | 1 | 459.10 | 303.98 | **0.662** | 0.667 | true | 1/1 |
| fixed-collection-rowref-20/full | 1 | 74.58 | 68.93 | **0.924** | 0.970 | true | 1/1 |
| key-transition-cascade/full | 1 | 110.62 | 100.98 | **0.913** | 1.017 | true | 3/3 |
| nested-conditional-found/full | 1 | 165.44 | 135.94 | **0.822** | 0.919 | true | 4/4 |
| scalar-find-unique/full | 1 | 29.20 | 25.94 | **0.888** | 0.940 | true | 1/1 |
| bulk-update-returning-100/full | 2 | 132.30 | 124.72 | **0.943** | 0.924 | true | 1/1 |
| bulk-update-returning-100/prepare | 2 | 21.27 | 35.05 | **1.647** | 1.276 | true | 1/1 |
| fixed-collection-rowref-1000/parse | 2 | 457.66 | 305.33 | **0.667** | 0.671 | true | 1/1 |
| fixed-collection-rowref-20/full | 2 | 75.72 | 73.03 | **0.965** | 1.047 | true | 1/1 |
| key-transition-cascade/full | 2 | 110.62 | 100.68 | **0.910** | 1.035 | true | 3/3 |
| nested-conditional-found/full | 2 | 170.91 | 134.02 | **0.784** | 0.845 | true | 4/4 |
| scalar-find-unique/full | 2 | 32.12 | 25.65 | **0.799** | 0.846 | true | 1/1 |
