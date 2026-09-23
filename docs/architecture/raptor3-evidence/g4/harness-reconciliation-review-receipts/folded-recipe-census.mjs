const CONTRACTS = ["C08","C09","C10","C11"];
function picker(seed){
  let state = (seed ^ 0xa4093822) >>> 0;
  return (limit) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
}
function gen(seed){
  const pick = picker(seed);
  const contract = CONTRACTS[(seed-8000)%4];
  const actors = seed % 5 === 0 ? 2 : 1;
  const fault = seed % 5 === 1 ? "legal-provider-failure" : "none";
  const actorPeer = actors === 2 ? 1 : 0;
  const faultRecovery = fault === "none" ? 0 : 1;
  const minimum = contract === "C09" ? 1 + Math.max(actorPeer,1) + faultRecovery : 1 + actorPeer + faultRecovery;
  const operations = minimum + pick(33 - minimum);
  if (contract !== "C11") return { seed, contract, actors, fault, operations };
  const depth = pick(5), fanout = pick(4);
  const shape = ["ordinary","compound","variant","repeated"][pick(4)];
  return { seed, contract, actors, fault, operations, depth, fanout, shape };
}
function census(first, count, label){
  let c11=0, folded=0, foldedFault=0, foldedOverlap=0, foldedOrdinary=0, foldedRepeated=0;
  const examples=[];
  for(let s=first;s<first+count;s++){
    const r = gen(s);
    if(r.contract!=="C11") continue;
    c11++;
    const isFold = r.depth===0 && (r.shape==="ordinary"||r.shape==="repeated");
    if(!isFold) continue;
    folded++;
    if(r.shape==="ordinary") foldedOrdinary++; else foldedRepeated++;
    if(r.fault!=="none"){ foldedFault++; if(examples.length<6) examples.push(r); }
    if(r.actors===2) foldedOverlap++;
  }
  console.log(label, JSON.stringify({c11, folded, foldedOrdinary, foldedRepeated, foldedFault, foldedOverlap}));
  if(examples.length) console.log("  fault examples:", JSON.stringify(examples));
}
census(8000, 100, "g3-transport-seed-batch 8000 (100 seeds):");
census(100000, 100, "g4-write-transport-seed-batch 100000 (100 seeds):");
census(50000, 100, "g4-transport-seed-batch 50000 (100 seeds):");
census(8000, 10000, "G3 full transport campaign (8000-17999):");
census(100000, 25000, "G4 write-transport campaign (100000-124999):");
