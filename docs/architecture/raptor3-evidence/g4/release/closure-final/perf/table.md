| cell | pass | baseline CPU µs/op | candidate | CPU ratio | wall ratio | valid | statements B/C |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| bulk-update-returning-100/full | 1 | 130.04 | 121.53 | **0.935** | 0.920 | true | 1/1 |
| bulk-update-returning-100/prepare | 1 | 20.78 | 32.38 | **1.558** | 1.212 | true | 1/1 |
| fixed-collection-rowref-1000/parse | 1 | 447.12 | 317.03 | **0.709** | 0.717 | true | 1/1 |
| key-transition-cascade/full | 1 | 107.65 | 97.62 | **0.907** | 1.027 | true | 3/3 |
| nested-conditional-found/full | 1 | 165.34 | 131.51 | **0.795** | 0.895 | true | 4/4 |
| nested-conditional-missing/full | 1 | 160.21 | 127.88 | **0.798** | 0.915 | true | 4/4 |
| bulk-update-returning-100/full | 2 | 130.25 | 122.64 | **0.942** | 0.925 | true | 1/1 |
| bulk-update-returning-100/prepare | 2 | 20.71 | 33.33 | **1.610** | 1.265 | true | 1/1 |
| fixed-collection-rowref-1000/parse | 2 | 456.03 | 323.44 | **0.709** | 0.726 | true | 1/1 |
| key-transition-cascade/full | 2 | 105.93 | 96.14 | **0.908** | 1.029 | true | 3/3 |
| nested-conditional-found/full | 2 | 160.51 | 131.34 | **0.818** | 0.925 | true | 4/4 |
| nested-conditional-missing/full | 2 | 161.32 | 126.40 | **0.784** | 0.892 | true | 4/4 |
