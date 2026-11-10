'use strict';
const readline=require('readline');
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);console.log(JSON.stringify({service:x.Name.match(/-(a|b|couch)-1$/)?.[1]||'unknown',memory:x.MemUsage,cpu:x.CPUPerc}));});
