import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const client=process.env.RUFA_TEST_CLIENT_ROOT||fileURLToPath(new URL('../',import.meta.url));
const { CompanyError }=await import(pathToFileURL(join(client,'dist/types.js')).href);
const { adminReadQuery }=await import(pathToFileURL(join(client,'dist/admin-query.js')).href);
const compiled=await readFile(join(client,'dist/main.js'),'utf8');
const handlers=compiled.slice(compiled.indexOf('function id('),compiled.indexOf('async function main('));
function fixture(){
 const trace=[];let principal={id:'admin-A',role:'admin'},resolveDialog;
 const context=vm.createContext({booting:false,CompanyError,adminReadQuery,win:{},api:{
  get state(){return {user:principal}},
  async verify(){trace.push('verify');return structuredClone({user:principal})},
  async json(method,path,body){trace.push({method,path,body});return{events:[],nextSeq:0,sessions:[],users:[],total:0}},
 },dialog:{showMessageBox:()=>new Promise(resolve=>{resolveDialog=resolve})}});
 vm.runInContext(handlers,context);
 return{context,trace,setPrincipal:value=>{principal=value},answer:value=>resolveDialog({response:value}),waiting:()=>!!resolveDialog};
}
test('actual main IPC admin readers reverify each call and only perform fixed GETs',async()=>{
 const f=fixture();
 await f.context.command('admin.querySessions',{ownerId:'alice',q:'报价',cursor:'opaque',limit:50});
 await f.context.command('admin.overview',{});
 await f.context.command('admin.events',{id:'session-A',afterSeq:199});
 assert.equal(f.trace.filter(x=>x==='verify').length,3);
 const requests=f.trace.filter(x=>typeof x==='object');assert.equal(requests.length,3);
 assert.ok(requests.every(x=>x.method==='GET'&&x.body===undefined));
 assert.match(requests[0].path,/^\/admin\/sessions\?/);
 assert.equal(requests[1].path,'/admin/overview');
 assert.equal(requests[2].path,'/admin/sessions/session-A/events?afterSeq=199&limit=200');
});
test('employee claims and a role revoked between reads cannot authorize the next admin request',async()=>{
 const f=fixture();await f.context.command('admin.users');
 f.setPrincipal({id:'admin-A',role:'employee'});
 for(const action of ['admin.querySessions','admin.overview','admin.events','admin.users']){
  await assert.rejects(f.context.command(action,{role:'admin',id:'session-A'}),error=>error.code==='FORBIDDEN');
 }
 assert.equal(f.trace.filter(x=>typeof x==='object').length,1);
});
test('query validation rejects renderer-controlled URLs before making any HTTP request',async()=>{
 const f=fixture();
 await assert.rejects(f.context.command('admin.querySessions',{url:'file:///C:/private'}),error=>error.code==='INVALID_QUERY');
 assert.equal(f.trace.filter(x=>typeof x==='object').length,0);
});
test('native deletion confirmation cannot cross an admin identity change',async()=>{
 const f=fixture(),pending=f.context.command('admin.deleteUser',{id:'employee'});
 while(!f.waiting())await new Promise(resolve=>setImmediate(resolve));
 f.setPrincipal({id:'admin-B',role:'admin'});f.answer(1);
 await assert.rejects(pending,error=>error.code==='AUTH_CHANGED');
 assert.equal(f.trace.filter(x=>typeof x==='object').length,0);
});
test('cancelled deletion makes no mutation; confirmed same admin deletion is rechecked',async()=>{
 const f=fixture(),cancelled=f.context.command('admin.deleteUser',{id:'employee'});
 while(!f.waiting())await new Promise(resolve=>setImmediate(resolve));f.answer(0);
 assert.equal((await cancelled).cancelled,true);assert.equal(f.trace.filter(x=>typeof x==='object').length,0);
 const g=fixture(),confirmed=g.context.command('admin.deleteUser',{id:'employee'});
 while(!g.waiting())await new Promise(resolve=>setImmediate(resolve));g.answer(1);
 assert.equal((await confirmed).ok,true);assert.equal(g.trace.filter(x=>x==='verify').length,2);
 assert.deepEqual(g.trace.filter(x=>typeof x==='object'),[{method:'DELETE',path:'/admin/users/employee',body:undefined}]);
});
