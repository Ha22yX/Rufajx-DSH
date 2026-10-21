import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerHooks } from 'node:module';
import { createSolidworksProcessManager, runSolidworksProcess } from '../src/runtime/solidworks-process.mjs';

// Load actual pure policy exports without loading a live Harness/runtime.
const upstream = 'data:text/javascript,' + encodeURIComponent('export async function importUpstream(){return {defineTool:value=>value}};export async function companyRequest(){return {user:{id:"synthetic-policy-account"}}}');
// Tool authorization tests exercise the real registration/guard/execute paths,
// with only company transport and the process adapter replaced by local fakes.
const policyProcess = 'data:text/javascript,' + encodeURIComponent(`
export const calls=[];
export function createSolidworksProcessManager(){return {
 run:async args=>{calls.push('run');return args.code==='unknown'?{status:'failed',outcomeUnknown:true}:{status:'completed'}},
 release:async()=>{calls.push('finish');return {status:'released'}},
 closeSession:async()=>{calls.push('close');return {status:'closed'}},
 close:async()=>[],releaseSession:async()=>{},status:async()=>({status:'ready'})
}}
export function runSolidworksProcess(){throw new Error('Not used by policy fixture')}
`);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './import-upstream.mjs' && context.parentURL?.includes('/solidworks-tools.mjs')) return { url: upstream, shortCircuit: true };
  if (specifier === './solidworks-process.mjs' && context.parentURL?.includes('/solidworks-tools.mjs')) return { url: policyProcess, shortCircuit: true };
  return next(specifier, context);
} });
const { solidworksCloseIntent, solidworksFinishIntent, createSolidworksTurnGuard, apply: applyTools } = await import('../src/runtime/solidworks-tools.mjs');
const { calls: policyCalls } = await import(policyProcess);
hooks.deregister();

const workerSource = [
  "import {createInterface} from 'node:readline';",
  "import {appendFile,access} from 'node:fs/promises';",
  "import {setTimeout as delay} from 'node:timers/promises';",
  "let count=0,dirty=false;",
  "for await(const line of createInterface({input:process.stdin})){",
  "const r=JSON.parse(line);await appendFile(process.argv[2],JSON.stringify(r)+'\\n');",
  "if(r.operation==='detect'){console.log(JSON.stringify({installed:true,mockCOM:true}));break;}",
  "const base={requestId:r.requestId,stepComplete:true,instanceAlive:true,retained:true,cleanup:false,ownedPid:process.pid,counter:count};",
  "if(r.operation==='release'){console.log(JSON.stringify({...base,status:'released',released:true}));break;}",
  "if(r.operation==='close'){if(dirty){console.log(JSON.stringify({...base,status:'failed',needsSave:['draft.SLDPRT']}));continue;}console.log(JSON.stringify({...base,status:'closed',closed:true,cleanup:true,instanceAlive:false,retained:false}));break;}",
  "if(r.operation==='status'){console.log(JSON.stringify({...base,status:'ready',dirty}));continue;}",
  "if(r.code==='crash'){process.exit(7);}",
  "if(r.code==='partial'){process.stdout.write('{');process.exit(0);}",
  "if(r.code==='wrong-id'){console.log(JSON.stringify({...base,requestId:'wrong',status:'completed'}));continue;}",
  "if(r.code==='overflow'){console.log('x'.repeat(2000001));continue;}",
  "if(r.code==='compile-failure'){console.log(JSON.stringify({...base,status:'failed',launched:false,instanceAlive:false,retained:false}));continue;}",
  "if(r.code==='wait'){while(true){try{await access(r.cancel);break;}catch{}await delay(5);}console.log(JSON.stringify({...base,status:'stopped'}));continue;}",
  "if(r.code==='dirty')dirty=true;if(r.code==='save')dirty=false;",
  "count++;console.log(JSON.stringify({...base,status:r.code==='fail'?'failed':'completed',counter:count,stepTitle:r.stepTitle}));",
  "}",
].join('\n');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rufa-sw-manager-')), cwd = join(root, 'work'), stateRoot = join(root, 'account'), trace = join(root, 'requests.jsonl'), helper = join(root, 'worker.mjs');
  await mkdir(cwd); await writeFile(helper, workerSource);
  const spawned = [], activities = [];
  const spawnProcess = (_python, _args, options) => { const child = spawn(process.execPath, [helper, trace], options); spawned.push({ child, options }); return child; };
  const config = { pythonPath: 'synthetic-python', helperPath: helper, stateRoot, spawnProcess };
  const manager = createSolidworksProcessManager({ ...config, onActivity: value => activities.push(value) });
  t.after(() => manager.close());
  const requests = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  async function waitRequest(predicate) {
    for (let i=0;i<400;i++) { const rows=await requests();if(rows.some(predicate))return rows;await delay(5); }
    assert.fail('worker did not receive request');
  }
  return {root,cwd,stateRoot,trace,helper,config,manager,spawned,activities,requests,waitRequest,binding:{sessionKey:'real-session-A',cwd}};
}

test('status without a host and pre-aborted run do not spawn; detect is one-shot', async t => {
  const f=await fixture(t);
  assert.equal((await f.manager.status(f.binding)).status,'not-started');
  assert.equal((await f.manager.closeSession(f.binding)).status,'not-started');
  assert.throws(()=>f.manager.run({...f.binding,code:'step',signal:AbortSignal.abort()}));
  assert.equal(f.spawned.length,0);
  const result=await runSolidworksProcess({...f.config,cwd:f.cwd,operation:'detect'});
  assert.equal(result.installed,true);assert.equal(f.spawned.length,1);
  assert.equal(f.spawned[0].child.exitCode,0);
  assert.equal((await f.requests())[0].persistent,undefined);
});

test('three steps and an ordinary failure keep one worker, scope and unique batch identities', async t => {
  const f=await fixture(t);
  const first=await f.manager.run({...f.binding,code:'first',stepTitle:'建立草图'});
  const second=await f.manager.run({...f.binding,cwd:join(f.cwd,'.'),code:'second'});
  const failed=await f.manager.run({...f.binding,code:'fail'});
  const third=await f.manager.run({...f.binding,code:'corrected'});
  assert.equal(f.spawned.length,1);assert.equal(first.ownedPid,third.ownedPid);
  assert.deepEqual([first.counter,second.counter,failed.counter,third.counter],[1,2,3,4]);
  assert.equal(failed.status,'failed');assert.equal(failed.retained,true);assert.equal(third.cleanup,false);
  const status=await f.manager.status(f.binding);assert.equal(status.counter,4);assert.equal(status.ownedPid,first.ownedPid);
  const rows=await f.requests();assert.equal(new Set(rows.map(r=>r.requestId)).size,5);
  assert.equal(new Set(rows.map(r=>r.state)).size,5);assert.equal(new Set(rows.map(r=>r.cancel)).size,5);
  assert.equal(new Set(rows.map(r=>r.ownerKey)).size,1);assert.equal(rows[0].stepTitle,'建立草图');
  assert.equal(rows.every(r=>r.sessionKey==='real-session-A'&&r.persistent===true),true);
  assert.equal((await f.manager.release(f.binding)).status,'released');
  assert.equal(f.spawned[0].child.exitCode,0);assert.equal((await f.manager.status(f.binding)).status,'not-started');
});

test('different sessions and account roots never reuse a worker; cwd changes cannot silently reopen', async t => {
  const f=await fixture(t), first=await f.manager.run({...f.binding,code:'a'});
  const second=await f.manager.run({...f.binding,sessionKey:'real-session-B',code:'b'});
  assert.notEqual(first.ownedPid,second.ownedPid);
  const other=createSolidworksProcessManager({...f.config,stateRoot:join(f.root,'other-account')});t.after(()=>other.close());
  const third=await other.run({...f.binding,code:'c'});assert.notEqual(first.ownedPid,third.ownedPid);
  const rows=await f.requests();assert.notEqual(rows[0].ownerKey,rows[2].ownerKey);
  const changed=join(f.root,'changed');await mkdir(changed);
  await assert.rejects(f.manager.run({...f.binding,cwd:changed,code:'d'}),/工作文件夹已改变/);
  assert.equal(f.spawned.length,3);
});

test('concurrent requests reject before sending; cooperative abort retains the worker', async t => {
  const f=await fixture(t), controller=new AbortController();
  const waiting=f.manager.run({...f.binding,code:'wait',signal:controller.signal});
  assert.throws(()=>f.manager.run({...f.binding,code:'must-not-run'}),/不会排队/);
  assert.throws(()=>f.manager.status(f.binding),/不会排队/);
  await f.waitRequest(r=>r.code==='wait');controller.abort();
  const stopped=await waiting;assert.equal(stopped.status,'stopped');assert.equal(stopped.stopRequested,true);
  const next=await f.manager.run({...f.binding,code:'after-new-human-message'});
  assert.equal(next.ownedPid,stopped.ownedPid);assert.equal(f.spawned.length,1);
  assert.equal((await f.requests()).some(r=>r.code==='must-not-run'),false);
});

test('timeout requests cancellation rather than replaying or opening another worker', async t => {
  const f=await fixture(t);
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=f.manager.run({...f.binding,code:'wait',timeoutSeconds:30});
  await f.waitRequest(r=>r.code==='wait');
  t.mock.timers.tick(32000);
  const result=await pending;t.mock.timers.reset();
  assert.equal(result.status,'stopped');assert.equal(result.timedOut,true);assert.equal(result.retained,true);
  assert.equal(f.spawned.length,1);assert.equal((await f.requests()).filter(r=>r.operation==='run').length,1);
});

test('dirty close refuses without losing scope, explicit save then clean close is terminal', async t => {
  const f=await fixture(t), first=await f.manager.run({...f.binding,code:'dirty'});
  const denied=await f.manager.closeSession(f.binding);assert.equal(denied.status,'failed');assert.equal(denied.instanceAlive,true);
  const saved=await f.manager.run({...f.binding,code:'save'});assert.equal(saved.ownedPid,first.ownedPid);
  const result=await f.manager.closeSession(f.binding);assert.equal(result.status,'closed');assert.equal(result.instanceAlive,false);
  assert.equal(result.stepComplete,true);assert.equal((await f.manager.status(f.binding)).status,'not-started');
});

test('explicit prelaunch failure remains known and allows reviewed correction in the same helper', async t => {
  const f=await fixture(t);
  const failure=await f.manager.run({...f.binding,code:'compile-failure'});
  assert.equal(failure.status,'failed');assert.equal(failure.launched,false);assert.equal(failure.outcomeUnknown,undefined);
  const corrected=await f.manager.run({...f.binding,code:'corrected'});
  assert.equal(f.spawned.length,1);assert.equal(corrected.status,'completed');
});

test('unknown host requires explicit finish and verified exit before a new host is possible', async t => {
  const f=await fixture(t);
  await assert.rejects(f.manager.run({...f.binding,code:'crash'}),error=>error.outcomeUnknown===true);
  await assert.rejects(f.manager.run({...f.binding,code:'no-replay'}),error=>error.outcomeUnknown===true);
  const released=await f.manager.release(f.binding);
  assert.equal(released.released,true);assert.equal(released.workerExited,true);assert.equal(released.previousOutcomeUnknown,true);
  assert.equal(released.handoffConfirmed,false);assert.equal(released.instanceAlive,null);
  await f.manager.run({...f.binding,code:'new-explicit-user-task'});assert.equal(f.spawned.length,2);
});

test('runtime close cancels active batch, then hands off without sending close; close is idempotent', async t => {
  const f=await fixture(t);
  const run=f.manager.run({...f.binding,code:'wait'});await f.waitRequest(r=>r.code==='wait');
  const closing=f.manager.close();assert.equal(f.manager.close(),closing);
  const result=await run;assert.equal(result.status,'stopped');
  await closing;assert.equal(f.spawned[0].child.exitCode,0);
  assert.deepEqual((await f.requests()).map(r=>r.operation),['run','release']);
  assert.equal(f.activities.at(-1),false);
  assert.throws(()=>f.manager.run({...f.binding,code:'after-close'}),/交还窗口/);
});

test('corrupt, truncated, excessive and crashed responses block reuse without automatic replay', async t => {
  for(const code of ['wrong-id','partial','overflow','crash']) await t.test(code,async t=>{
    const f=await fixture(t);
    await assert.rejects(f.manager.run({...f.binding,code}),error=>error.outcomeUnknown===true);
    const status=await f.manager.status(f.binding);assert.equal(status.outcomeUnknown,true);
    await assert.rejects(f.manager.run({...f.binding,code:'must-not-restart'}),error=>error.outcomeUnknown===true);
    assert.equal(f.spawned.length,1);
    assert.equal((await f.requests()).filter(r=>r.operation==='run').length,1);
  });
});

test('worker environment does not inherit arbitrary credential variables', async t => {
  const f=await fixture(t);process.env.RUFA_SYNTHETIC_SECRET='synthetic-only';
  t.after(()=>delete process.env.RUFA_SYNTHETIC_SECRET);
  await f.manager.run({...f.binding,code:'step'});
  assert.equal('RUFA_SYNTHETIC_SECRET' in f.spawned[0].options.env,false);
  assert.equal(f.spawned[0].options.shell,false);assert.equal(f.spawned[0].options.windowsHide,true);
});

const human=(seq,text,source={kind:'user',rpcId:String(seq)})=>({type:'user/message',seq,data:{source,content:[{type:'text',text}]}});
test('stop guard requires a later committed human event and does not confuse child ownership',()=>{
  const events=[human(1,'用SW建模')],session={id:'real',header:{},snapshotEvents:()=>events,isOwnSeq:()=>true},agent={session};
  const guard=createSolidworksTurnGuard();guard.check(agent);guard.block(agent);
  assert.throws(()=>guard.check(agent),/新的明确消息/);
  events.push(human(2,'继续',{kind:'user',rpcId:'2',principal:'agent'}),human(3,'<attachment>继续</attachment>'));
  assert.throws(()=>guard.check(agent),/新的明确消息/);
  events.push(human(4,'继续'));guard.check(agent);
  const child={session:{id:'child',header:{origin:'subagent',parentSession:'real'}}};
  const childGuard=createSolidworksTurnGuard({get:id=>id==='real'?agent:undefined});
  childGuard.block(child);assert.throws(()=>childGuard.check(child));
  events.push(human(5,'继续修正当前孔'));childGuard.check(child);
});
test('close intent requires an explicit non-negated SW/task-window request',()=>{
  for(const text of ['请关闭本任务SW窗口','把SolidWorks窗口关掉','把SW窗口关掉','保存后关闭SW','关闭当前任务窗口','Close the SW window'])assert.equal(solidworksCloseIntent(text),true,text);
  for(const text of ['完成建模','保存模型','不要关闭SW窗口','Do not close SolidWorks','关闭浏览器','告诉我怎么关闭SolidWorks','How to close SW'])assert.equal(solidworksCloseIntent(text),false,text);
});
test('close intent rejects preserving a visible SW window and stronger negations',()=>{
  for(const text of [
    'SW建模完成了没必要直接关闭窗口',
    '建模完成后没必要直接关闭SW窗口，但是保留关闭窗口能力',
    '不需要关闭SolidWorks，模型留着给我看',
    '没有必要在检查完所有尺寸之后关闭本任务窗口',
    '不应自动关闭SW窗口', '不应该关闭SW窗口', '不准关闭SW',
    '不能关闭SW窗口', '不可退出SolidWorks', '暂不关闭本任务窗口', '勿关闭SW',
    '关闭SW窗口是不需要的', 'There is no need to close SolidWorks',
  ])assert.equal(solidworksCloseIntent(text),false,text);
});
test('close intent rejects developing or retaining a closing capability',()=>{
  for(const text of [
    '增加关闭SW窗口的功能', '给客户端新增关闭SolidWorks窗口的按钮',
    'SW建模完成保留关闭窗口能力', '支持关闭本任务窗口的功能',
    '实现关闭SolidWorks的接口', '设计一个退出SW的选项',
    '关闭SW的功能需要保留', 'Add a feature to close the SW window',
    'Retain the ability to close SolidWorks', 'Implement a close SW button',
  ])assert.equal(solidworksCloseIntent(text),false,text);
});
test('finish intent needs an actual handoff request, not completion, negation or capability',()=>{
  for(const text of ['结束本任务SW控制','请交还窗口','交还本任务窗口','请释放当前SW窗口','Release the SW window'])assert.equal(solidworksFinishIntent(text),true,text);
  for(const text of [
    'SW建模完成了', '继续SW建模', '无需交还SW窗口', '不需要结束本任务SW控制',
    '不要释放当前SW窗口', 'SW完成后没必要直接交还窗口',
    '增加交还SW窗口的功能', '保留结束本任务SW控制的能力',
    'SW建模要支持释放窗口的按钮', '解释如何结束本任务SW控制',
    'Do not release the SW window', 'Add the ability to release SW',
  ])assert.equal(solidworksFinishIntent(text),false,text);
});

test('tool guard and execute both prevent ordinary modeling authority from authorizing finish',async t=>{
  const effects=[],registered=new Map();let guard;
  const events=[human(1,'用SW建模')];
  const agent={session:{id:'policy-session',header:{},snapshotEvents:()=>events,isOwnSeq:()=>true}};
  const ctx={
    agents:{get:id=>id==='policy-session'?agent:undefined},workingDirectory:{get:()=>tmpdir()},
    tools:{guard:fn=>{guard=fn},register:tool=>registered.set(tool.name,tool)},
    on(){},effect:fn=>effects.push(fn()),get:()=>({active:true}),logger:{warn(){}},
  };
  applyTools(ctx,{companyHome:join(tmpdir(),'synthetic-policy-account'),toolkitRoot:tmpdir(),pythonPath:'unused-fake'});
  t.after(async()=>{for(const cleanup of effects)await cleanup()});
  const execution={agent,signal:new AbortController().signal};
  const tool=registered.get('company_solidworks_run');
  const guarded=(operation,otherAgent=agent)=>guard({...execution,agent:otherAgent,name:tool.name,arguments:{operation}});
  const say=text=>events.push(human(events.length+1,text));
  const before=policyCalls.length;
  await tool.execute({code:'unknown'},execution).then(()=>assert.fail('unknown result must reject'),error=>assert.equal(error.outcomeUnknown,true));
  assert.deepEqual(policyCalls.slice(before),['run'],'Unknown result must not automatically release or replay');
  for(const text of [
    '继续SW建模','SW建模完成了','SW建模完成后没必要交还窗口',
    'SW建模后保留交还窗口的能力','不需要结束本任务SW控制',
  ]){
    say(text);assert.throws(()=>guarded('finish'),/明确要求/);
    await assert.rejects(tool.execute({operation:'finish'},execution),/没有用户授权/);
  }
  assert.deepEqual(policyCalls.slice(before),['run'],'Denied calls must not reach the process adapter');
  say('结束本任务SW控制');
  const otherAgent={session:{...agent.session,id:'different-session'}};
  assert.throws(()=>guarded('finish',otherAgent),/明确要求/);
  await assert.rejects(tool.execute({operation:'finish'},{...execution,agent:otherAgent}),/没有用户授权/);
  assert.doesNotThrow(()=>guarded('finish'));
  assert.equal(JSON.parse(await tool.execute({operation:'finish'},execution)).status,'released');
  assert.deepEqual(policyCalls.slice(before),['run','finish']);
  assert.throws(()=>guarded('finish'),/明确要求/,'Handed-off session no longer owns the window');
});
