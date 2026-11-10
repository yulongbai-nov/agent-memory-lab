'use strict';

const TEXT_MAX = 4096;
const ID_MAX = 512;
const evidenceProperties = {
  source: {type:'string',minLength:1,maxLength:ID_MAX},
  item: {type:'string',minLength:1,maxLength:ID_MAX},
  version: {type:'string',minLength:1,maxLength:ID_MAX},
  quote: {type:'string',minLength:1,maxLength:TEXT_MAX}
};
const OUTPUT_SCHEMA = {
  type:'object',additionalProperties:false,required:['candidates'],properties:{
    candidates:{type:'array',maxItems:4,items:{
      type:'object',additionalProperties:false,required:['kind','claim','evidence'],properties:{
        kind:{type:'string',enum:['decision','change','correction','todo']},
        claim:{type:'string',minLength:1,maxLength:TEXT_MAX},
        evidence:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,required:['source','item','version','quote'],properties:evidenceProperties}}
      }
    }}
  }
};
function objectShape(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));
}
function bounded(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim().length > 0; }
function validateCandidates(output, records) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const sources = new Map();
  for (const record of records) {
    if (!objectShape(record,['source','item','version','text']) || !bounded(record.source,ID_MAX) || !bounded(record.item,ID_MAX) || !bounded(record.version,ID_MAX) || typeof record.text !== 'string') throw new Error('invalid source record');
    const key = JSON.stringify([record.source,record.item,record.version]);
    if (sources.has(key)) throw new Error('duplicate source record');
    sources.set(key,record.text);
  }
  if (!objectShape(output,['candidates']) || !Array.isArray(output.candidates) || output.candidates.length > 4) throw new Error('invalid candidates output');
  const seen = new Set();
  return output.candidates.map(candidate => {
    if (!objectShape(candidate,['kind','claim','evidence']) || !['decision','change','correction','todo'].includes(candidate.kind) || !bounded(candidate.claim,TEXT_MAX) || !Array.isArray(candidate.evidence) || candidate.evidence.length < 1 || candidate.evidence.length > 3) throw new Error('invalid candidate');
    const candidateKey = JSON.stringify([candidate.kind,candidate.claim]);
    if (seen.has(candidateKey)) throw new Error('duplicate candidate');
    seen.add(candidateKey);
    const refs = new Set();
    const evidence = candidate.evidence.map(ref => {
      if (!objectShape(ref,['source','item','version','quote']) || !bounded(ref.source,ID_MAX) || !bounded(ref.item,ID_MAX) || !bounded(ref.version,ID_MAX) || !bounded(ref.quote,TEXT_MAX)) throw new Error('invalid evidence');
      const key = JSON.stringify([ref.source,ref.item,ref.version]);
      if (!sources.has(key) || !sources.get(key).includes(ref.quote)) throw new Error('evidence quote or source not found');
      const refKey = JSON.stringify([ref.source,ref.item,ref.version,ref.quote]);
      if (refs.has(refKey)) throw new Error('duplicate evidence');
      refs.add(refKey);
      return {source:ref.source,item:ref.item,version:ref.version,quote:ref.quote};
    });
    return {kind:candidate.kind,claim:candidate.claim,evidence,status:'待核实'};
  });
}
module.exports = {OUTPUT_SCHEMA,validateCandidates};
