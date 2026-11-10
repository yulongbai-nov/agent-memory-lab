'use strict';
// Synthetic-only wire check. Records shape and counts, never request content or keys.
const http=require('node:http');
const token=process.env.MEMLAB_PROXY_TOKEN;
if(!token || !/^[A-Za-z0-9_-]{24,128}$/.test(token)) {console.error('synthetic gate required');process.exit(1);}
let requests=0,rejected=0;
const send=(res,code,obj)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(obj));};
const server=http.createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer '+token){rejected++;return send(res,401,{error:'denied'});}
 if(req.method==='GET'&&req.url==='/stats')return send(res,200,{requestedModel:'gpt-6-luna',requestedEffort:'low',limits:{requests:8},requests,rejected});
 if(req.method!=='POST'||req.url!=='/v1/responses'){rejected++;return send(res,404,{error:'route'});}
 try {
  let size=0,parts=[];for await(const part of req){size+=part.length;if(size>65536)throw Error('limit');parts.push(part);}
  const b=JSON.parse(Buffer.concat(parts).toString('utf8'));
  const valid=b.model==='gpt-6-luna'&&b.reasoning?.effort==='low'&&Array.isArray(b.input)&&b.stream===true&&(!b.tools||Array.isArray(b.tools)&&b.tools.length===0);
  console.log(JSON.stringify({event:'shape',modelOk:b.model==='gpt-6-luna',effortOk:b.reasoning?.effort==='low',effort:['low','medium','high','none','minimal'].includes(b.reasoning?.effort)?b.reasoning.effort:(b.reasoning?.effort===undefined?'absent':'other'),inputArray:Array.isArray(b.input),stream:b.stream===true,toolCount:Array.isArray(b.tools)?b.tools.length:0,bytes:size,accepted:valid}));
  if(!valid){rejected++;return send(res,400,{error:'shape'});}
  requests++;const msg={id:'synthetic-message-'+requests,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic provider acknowledgment.',annotations:[]}]};
  const response={id:'synthetic-response-'+requests,object:'response',created_at:1767225600,status:'completed',model:'gpt-6-luna',output:[msg],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...msg,status:'in_progress',content:[]}},{type:'response.content_part.added',item_id:msg.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:msg.id,output_index:0,content_index:0,delta:'Synthetic provider acknowledgment.'},{type:'response.output_text.done',item_id:msg.id,output_index:0,content_index:0,text:'Synthetic provider acknowledgment.'},{type:'response.content_part.done',item_id:msg.id,output_index:0,content_index:0,part:msg.content[0]},{type:'response.output_item.done',output_index:0,item:msg},{type:'response.completed',response}];
  res.writeHead(200,{'content-type':'text/event-stream'});for(const e of events)res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end();
 }catch{rejected++;send(res,400,{error:'invalid'});}
});
server.listen(8080,'172.28.88.2',()=>console.log(JSON.stringify({event:'ready',synthetic:true})));
