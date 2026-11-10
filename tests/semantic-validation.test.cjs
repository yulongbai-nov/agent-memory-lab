'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {OUTPUT_SCHEMA,validateCandidates}=require('../lib/semantic-validation.cjs');
const records=[{source:'synthetic',item:'m1',version:'v1',text:'We may choose option A, pending review.'}];
const ref={source:'synthetic',item:'m1',version:'v1',quote:'option A'};
const candidate={kind:'decision',claim:'Option A is proposed',evidence:[ref]};
test('valid candidates get a fixed review status without mutating input',()=>{
 const result=validateCandidates({candidates:[candidate]},records); assert.equal(result[0].status,'待核实'); assert.equal(candidate.status,undefined); assert.deepEqual(validateCandidates({candidates:[]},records),[]); assert.equal(OUTPUT_SCHEMA.properties.candidates.maxItems,4);
});
test('rejects incorrect or missing exact evidence and duplicate references',()=>{
 for (const change of [{quote:'Option A'},{quote:''},{version:'v2'},{source:'other'},{item:'m2'}]) assert.throws(()=>validateCandidates({candidates:[{...candidate,evidence:[{...ref,...change}]}]},records));
 assert.throws(()=>validateCandidates({candidates:[{...candidate,evidence:[ref,ref]}]},records));
 assert.throws(()=>validateCandidates({candidates:[candidate]},[...records,...records]));
});
test('rejects malformed shape, spoofed status, excess candidates and duplicates',()=>{
 for (const output of [null,{}, {candidates:[],extra:true},{candidates:[{...candidate,status:'已确定'}]},{candidates:[{...candidate,evidence:[]}]},{candidates:[{...candidate,evidence:[ref,ref,ref,ref]}]},{candidates:Array(5).fill(candidate)},{candidates:[candidate,candidate]},{candidates:[{...candidate,claim:'   '}]},{candidates:[{...candidate,kind:'source'}]}]) assert.throws(()=>validateCandidates(output,records));
});
