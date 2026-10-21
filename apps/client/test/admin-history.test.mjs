import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { projectEvent } from '../src/renderer/admin-events.mjs';
import { appendEventPage, dateRange } from '../src/renderer/admin-history.mjs';
const client = process.env.RUFA_TEST_CLIENT_ROOT || fileURLToPath(new URL('../', import.meta.url));
const { adminReadQuery } = await import(pathToFileURL(join(client,'dist/admin-query.js')).href);
const record = (seq,type='user/message',data={source:{kind:'user'},content:[{type:'text',text:'消息'+seq}]}) => ({seq,event:{seq,type,time:1000+seq,data}});

test('admin query keeps a fixed endpoint, encodes literal search and validates dates and pagination',()=>{
  const path=adminReadQuery('sessions',{ownerId:'员工&1',q:'50%_报价&x=1',limit:50,cursor:'opaque+/='});
  assert.match(path,/^\/admin\/sessions\?/); const q=new URL(path,'https://company.example').searchParams;
  assert.equal(q.get('ownerId'),'员工&1');assert.equal(q.get('q'),'50%_报价&x=1');assert.equal(q.get('cursor'),'opaque+/=');
  assert.equal(adminReadQuery('overview',{}),'/admin/overview');
  for(const value of [{q:'x'.repeat(201)},{limit:0},{limit:1001},{cursor:{}},{url:'file:///secret'},{from:'yesterday'},{from:'2026-10-22T00:00:00Z',to:'2026-10-21T00:00:00Z'}])assert.throws(()=>adminReadQuery('sessions',value));
  assert.throws(()=>adminReadQuery('overview',{ownerId:'x'}));
});
test('date filters include whole selected local ending day and reject reversed or impossible days',()=>{
  const range=dateRange('2026-10-20','2026-10-21');
  assert.equal(new Date(range.from).getDate(),20);assert.equal(new Date(range.to).getDate(),22);
  assert.throws(()=>dateRange('2026-10-22','2026-10-20'));assert.throws(()=>dateRange('2026-02-31',''));assert.deepEqual(dateRange('',''),{});
});
test('all native content is projected without truncating and injected/surface-replaced content is not employee speech',()=>{
  const text='完整正文'.repeat(45000);
  const human=projectEvent(record(0).event);assert.equal(human.role,'员工');
  const native=projectEvent(record(1,'assistant/message',{message:{content:[{type:'reasoning',text:'真实思考'},{type:'text',text}]},interrupted:true}).event);
  assert.equal(native.parts[1].text,text);assert.match(native.notes.join(' '),/中断/);assert.equal(native.parts[0].kind,'reasoning');
  const injected=projectEvent(record(2,'user/message',{source:{kind:'file-context'},content:[{type:'text',text:'文件说明'}]}).event);
  assert.equal(injected.kind,'context');assert.notEqual(injected.role,'员工');
  const replaced=record(3).event;replaced.surfaceOp={op:'replace',startSeq:1,endSeq:2};replaced.sourceEventSeqs=[1,2];
  assert.equal(projectEvent(replaced).kind,'context');assert.match(projectEvent(replaced).notes.join(' '),/1–2/);
});
test('tool results pair through native toolCallId/source.callId and retain failure meta and structured content',()=>{
  const tools=new Map();
  projectEvent(record(0,'assistant/message',{message:{content:[{type:'tool-call',id:'call-A',name:'读取文件',arguments:'{"path":"报价.xlsx"}'}]}}).event,tools);
  const result=projectEvent(record(1,'tool/result',{message:{source:{kind:'tool',callId:'call-A'},isError:true,content:[{type:'text',text:'原始结果'}]},error:{code:'FAILED',reason:'权限拒绝'},meta:{diff:'全部差异'}}).event,tools);
  assert.equal(result.role,'工具执行失败 · 读取文件');assert.match(result.text,/原始结果/);assert.match(result.text,/权限拒绝/);assert.match(result.text,/全部差异/);
});
test('attachment reference metadata, attempts and unknown events remain losslessly inspectable',()=>{
  const attachment={type:'file',attachment:{name:'报价.xlsx',path:'C:/员工/报价.xlsx',bytes:1234,mediaType:'application/example'}};
  const p=projectEvent(record(0,'user/message',{source:{kind:'user'},content:[attachment]}).event);
  assert.equal(p.parts[0].size,1234);assert.equal(p.parts[0].title,'报价.xlsx');assert.equal(JSON.parse(p.parts[0].text).attachment.path,'C:/员工/报价.xlsx');
  const attempt=projectEvent(record(1,'assistant/attempt',{stream:[{type:'text-chunks',texts:['部分','回答']},{type:'reasoning-chunks',texts:['思','考']},{type:'chunk',chunk:{type:'finish',reason:{kind:'error',failure:{message:'失去连接'}}}}]}).event);
  assert.match(attempt.text,/部分回答/);assert.match(attempt.text,/思考/);assert.match(attempt.text,/失去连接/);
  const unknown=record(2,'future/plugin-event',{deep:{payload:'不丢弃'}}).event;
  assert.deepEqual(JSON.parse(projectEvent(unknown).raw),unknown);
  assert.equal(projectEvent(record(3,'turn/end',{reason:{kind:'aborted',reason:{kind:'user'}}}).event).role,'任务已停止');
});
test('event pagination reads beyond 400 events, uses actual page tail and accepts only identical overlaps',()=>{
  const rows=Array.from({length:405},(_,seq)=>record(seq));let value=appendEventPage([],{events:rows.slice(0,200),nextSeq:405});
  assert.equal(value.next,200);assert.equal(value.complete,false);
  value=appendEventPage(value.records,{events:rows.slice(199,400),nextSeq:405});
  assert.equal(value.next,400);assert.equal(value.records.length,400);
  value=appendEventPage(value.records,{events:rows.slice(400),nextSeq:405});assert.equal(value.complete,true);assert.equal(value.records.length,405);
});
test('malformed, missing, conflicting, regressed and empty nonterminal event pages cannot advance the reader',()=>{
  const before=[record(0),record(1)];
  for(const page of [
    {events:[],nextSeq:9},{events:[record(3)],nextSeq:4},{events:[record(1,'future',{different:true})],nextSeq:3},
    {events:[{seq:2,event:{seq:4}}],nextSeq:5},{events:[record(2)],nextSeq:2},{events:[],nextSeq:1},{events:'bad',nextSeq:3},
  ])assert.throws(()=>appendEventPage(before,page));
  assert.equal(before.length,2);assert.equal(appendEventPage(before,{events:[],nextSeq:2}).complete,true);
});

