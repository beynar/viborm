#!/bin/zsh
# §0 profile: CPU profile, allocation sampling (128 B), --trace-gc, both engines.
# usage: profile-all.sh <arm> <tag>
SP2=/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/perf2
ARM=$1; TAG=$2
TREE=$SP2/ab/$ARM
mkdir -p $SP2/prof/$TAG
CELLS=(
  "scalar-find-unique prepare 20000 2000"
  "fixed-collection-rowref-1000 prepare 3000 600"
  "bulk-update-returning-100 prepare 5000 1000"
)
cd $TREE
for cell in $CELLS; do
  set -- ${=cell}
  W=$1; ST=$2; IT=$3; WU=$4
  for engine in shipped candidate; do
    P=$SP2/prof/$TAG/$W-$ST-$engine
    echo "== cpu $W/$ST $engine"
    TMPDIR=/private/tmp/viborm-g4-perf2-tmp VIBORM_BENCH_ENGINE=$engine \
      node --expose-gc $SP2/prof-stage.mjs $TREE $W $ST $IT $WU $P.cpuprofile > $P.cpu.json
    echo "== alloc $W/$ST $engine"
    TMPDIR=/private/tmp/viborm-g4-perf2-tmp VIBORM_BENCH_ENGINE=$engine ALLOC=1 \
      node --expose-gc $SP2/prof-stage.mjs $TREE $W $ST $IT $WU $P.heapprofile > $P.alloc.json
    echo "== gc $W/$ST $engine"
    TMPDIR=/private/tmp/viborm-g4-perf2-tmp VIBORM_BENCH_ENGINE=$engine \
      node --expose-gc --trace-gc $SP2/gc-stage.mjs $TREE $W $ST $IT $WU > $P.gc.json 2> $P.trace-gc.log
  done
done
echo DONE
