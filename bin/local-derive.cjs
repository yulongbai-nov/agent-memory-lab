#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { runLocalDerive } = require('../lib/local-derive.cjs');

async function main() {
  const {values} = parseArgs({options:{
    dir:{type:'string'}, project:{type:'string'}, owner:{type:'string'},
    synthetic:{type:'boolean'}, help:{type:'boolean',short:'h'}
  }});
  if (values.help) {
    console.log('Usage: node bin/local-derive.cjs --dir PRIVATE_DIRECTORY --project PROJECT [--owner OWNER] [--synthetic]');
    return;
  }
  const controller=new AbortController();let exitSignal=0;
  const interrupt=()=>{exitSignal ||= 130;controller.abort();},terminate=()=>{exitSignal ||= 143;controller.abort();};
  process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
  try {
    const result = await runLocalDerive({...values,owner:values.owner || 'local',signal:controller.signal});
    console.log(JSON.stringify(result));
    if (result.status !== 'validated') process.exitCode = exitSignal || 1;
  } finally {process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
}
main().catch(error => {
  const reason = error.code === 'SQLITE_REQUIRED' ? error.code : 'LOCAL_INPUT_OR_STORAGE_FAILED';
  console.error(JSON.stringify({status:'retryable',reason,modelCalls:0}));
  process.exitCode = 1;
});
