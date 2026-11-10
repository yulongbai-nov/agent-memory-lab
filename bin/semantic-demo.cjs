#!/usr/bin/env node
'use strict';

if (process.argv.length !== 2) {
  console.error('The semantic demo accepts no arguments. It uses the fixed public synthetic fixture.');
  process.exitCode = 2;
} else {
  require('../lib/semantic-demo.cjs').runSynthetic().then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    const safe = /^(Synthetic (Codex|fixture|prompt|semantic)|Invalid (synthetic|Codex|candidates|candidate|evidence)|evidence quote or source|duplicate (candidate|evidence))/i;
    if (safe.test(error.message)) console.error(error.message);
    console.error(JSON.stringify({ status: 'failed', usage: error.usage || 'unknown' }));
    console.error('Synthetic semantic run failed. Retry is available.');
    process.exitCode = 1;
  });
}
