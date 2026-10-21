const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdir, cp, writeFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
const output=resolve(process.argv[2]),client=resolve(process.argv[3]);
app.setPath('userData',join(output,'profile'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const users=[
 {id:'admin',username:'manager',displayName:'管理测试',jobTitle:'管理',role:'admin',status:'active'},
 {id:'alice',username:'alice',displayName:'张同事',jobTitle:'采购',role:'employee',status:'active'},
 {id:'disabled',username:'disabled',displayName:'停用同事',jobTitle:'',role:'employee',status:'disabled'},
 {id:'recycled',username:'recycled',displayName:'回收同事',role:'employee',status:'deleted',purgeAfter:new Date(Date.now()+86400000*3).toISOString(),purgedAt:null},
 {id:'expired',username:'expired',displayName:'到期同事',role:'employee',status:'deleted',purgeAfter:new Date(Date.now()-86400000).toISOString(),purgedAt:null},
 {id:'archived',username:'archived',displayName:'档案同事',role:'employee',status:'deleted',purgeAfter:new Date(Date.now()-86400000).toISOString(),purgedAt:new Date().toISOString()},
];
let state={user:users[0],booting:false,harness:{status:'running'},version:'test'},window;
const calls=[],errors=[],checks=[];
let holdAfter=null,held=null,gap=false,unsupported=false;
const rows=Array.from({length:405},(_,seq)=>({seq,event:{seq,time:Date.now()+seq,type:seq===0?'user/message':'assistant/message',data:seq===0?{source:{kind:'user'},content:[{type:'text',text:'员工消息'}]}:{message:{content:[{type:'text',text:'助手回复'+seq}]}}}}));
rows[1].event.data.message.content=[{type:'reasoning',text:'思考全文'},{type:'text',text:'# 标题\n\n| 项目 | 金额 |\n| --- | --- |\n| 报价 | 1200 |\n\n- 清单一\n- 清单二\n\n'+String.fromCharCode(96).repeat(3)+'js\nconst x = 1;\n'+String.fromCharCode(96).repeat(3)+'\n\n<script>window.injected=true</script>\n![远程](https://invalid.example/image.png)\n[本地](file:///C:/secret)\n\n'+'完整长回复'.repeat(12000)}];
rows[2].event={seq:2,time:Date.now(),type:'request/header',data:{header:{context:'技术命中词'},reason:'initial'}};
rows[3].event={seq:3,time:Date.now(),type:'user/message',data:{source:{kind:'user'},content:[{type:'file',attachment:{name:'报价.xlsx',path:'C:/employee/报价.xlsx',bytes:1234,mediaType:'application/test'}}]}};
const sessions=[{id:'A',ownerId:'alice',title:'采购记录 A',nextSeq:405,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()},{id:'B',ownerId:'archived',title:'归档记录 B',nextSeq:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),upstreamHeader:{origin:'subagent'}}];
const response=input=>({events:input.id==='B'?[{seq:0,event:{seq:0,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'B 独立记录'}]}}}]:rows.slice(input.afterSeq+1+(gap?1:0),input.afterSeq+201),nextSeq:input.id==='B'?1:405});
async function main(){
 await app.whenReady();nativeTheme.themeSource='dark';await mkdir(output,{recursive:true});
 await cp(join(client,'src/renderer'),join(output,'renderer'),{recursive:true});await cp(join(client,'src/preload.cjs'),join(output,'preload.cjs'));
 // Test-only copied logo, without reading any user's runtime/profile.
 await mkdir(join(output,'renderer/assets'),{recursive:true});await cp(join(client,'assets/rufajx-mark.png'),join(output,'renderer/assets/rufajx-mark.png'));
 const page=join(output,'renderer/index.html');
 window=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{preload:join(output,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message)});
 ipcMain.handle('rufa:command',async(event,action,input)=>{
  assert.equal(event.sender,window.webContents);assert.equal(event.senderFrame.url,pathToFileURL(page).href);
  calls.push({action,input:action.includes('Key')||action.includes('Password')?undefined:structuredClone(input)});
  let value={};
  if(action==='state')value=state;
  else if(action==='harness.open'||action==='harness.hide')value={status:'running'};
  else if(action==='admin.users')value={users:structuredClone(users)};
  else if(action==='admin.overview')value={accounts:{total:6,active:2,disabled:1,recycled:2,archived:1},sessions:{total:2,updatedInRange:2},usage:{requests:4,completed:2,failed:1,cancelled:1,inputTokens:40,outputTokens:50,totalTokens:90,missingUsageRequests:1},users:[]};
  else if(action==='admin.querySessions'){if(unsupported)return{ok:false,error:{code:'NOT_FOUND',message:'Not found'}};value={sessions:structuredClone(sessions),total:2};}
  else if(action==='admin.events'){if(input.id==='A'&&input.afterSeq===holdAfter){holdAfter=null;return await new Promise(resolve=>held={resolve,input})}value=response(input);}
  else if(action==='admin.restoreUser'){const user=users.find(user=>user.id===input.id);user.status='active';user.purgeAfter=null;user.purgedAt=null;value={user};}
  else if(action==='admin.updateUser'){Object.assign(users.find(user=>user.id===input.id),input);value={user:users.find(user=>user.id===input.id)};}
  else if(action==='admin.createUser'){assert.match(input.password,/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{10}$/);value={user:{...input,id:'new',status:'active'}};users.push(value.user);}
  else if(action==='admin.deepseekStatus')value={configured:true,updatedAt:null};
  else if(action==='login.saved')value={remembered:false,username:''};
  else throw new Error('Unexpected / possibly mutating operation '+action);
  return{ok:true,value};
 });
 await window.loadFile(page);
 const js=code=>window.webContents.executeJavaScript(code);
 async function until(code,label=code){for(let i=0;i<200;i++){if(await js(code))return;await pause(15)}throw new Error('DOM timeout: '+label)}
 const click=selector=>js('document.querySelector('+JSON.stringify(selector)+').click()');
 const text=selector=>js('document.querySelector('+JSON.stringify(selector)+').textContent');
 const fill=(selector,value)=>js('(()=>{const n=document.querySelector('+JSON.stringify(selector)+');n.value='+JSON.stringify(value)+';n.dispatchEvent(new Event("input",{bubbles:true}));})()');
 const count=()=>js('document.querySelectorAll("#events article[data-event-seq]").length');
 const release=()=>{const value=held;held=null;value.resolve({ok:true,value:response(value.input)})};
 await until('!document.querySelector("#app-header").hidden');await click('#open-admin');await until('document.querySelector("#overview-stats").children.length===4');
 await click('[data-section=chat]');await until('document.querySelectorAll("#sessions .session-row").length===2');
 await click('[data-session-id=A]');await until('document.querySelectorAll("#events article").length===200');
 assert.equal(await js('document.querySelector("[data-event-seq=\\"2\\"]").hidden'),true);
 assert.equal(await js('document.querySelectorAll("#events [data-raw-event] pre").length'),0);
 assert.equal(await js('document.querySelectorAll("#events table").length'),1);
 assert.equal(await js('document.querySelectorAll("#events .code-block code").length'),1);
 assert.equal(await js('document.querySelectorAll("#events img,#events a,#events script").length'),0);
 assert.equal(await js('Boolean(window.injected)'),false);
 assert.ok((await text('#events')).includes('完整长回复'.repeat(12000)));
 assert.match(await text('#events'),/1,234 字节/);assert.match(await text('#events'),/不提供附件文件/);
 checks.push('Native text/Markdown, long reply, inert HTML and file references');
 await fill('#event-find','技术命中词');await until('document.querySelector("#reader-mode").value==="all"');
 assert.equal(await js('document.querySelector("[data-event-seq=\\"2\\"]").hidden'),false);
 await until('document.querySelector("[data-event-seq=\\"2\\"] [data-raw-event] pre")');
 await fill('#event-find','');checks.push('Search opens hidden technical records and lazy full raw event');
 gap=true;await click('#more-events');await until('!document.querySelector("#events-error").hidden');assert.equal(await count(),200);
 gap=false;await click('#more-events');await until('document.querySelectorAll("#events article").length===400');checks.push('Gap keeps valid prefix and retry starts at same cursor');
 await click('[data-session-id=A]');await until('document.querySelectorAll("#events article").length===200');
 holdAfter=199;await click('#all-events');for(let i=0;!held&&i<100;i++)await pause(10);assert.ok(held);
 await click('#stop-events');release();await until('document.querySelector("#stop-events").hidden');assert.equal(await count(),400);
 await click('#more-events');await until('document.querySelectorAll("#events article").length===405');checks.push('Load-all stops after in-flight page and can continue');
 await click('[data-session-id=A]');await until('document.querySelectorAll("#events article").length===200');holdAfter=199;
 await click('#more-events');for(let i=0;!held&&i<100;i++)await pause(10);assert.ok(held);
 await click('#open-harness');await click('#open-admin');await until('!document.querySelector("#admin-view").hidden');
 assert.equal(await js('document.querySelector("#more-events").disabled'),false);release();await pause(40);assert.equal(await count(),200);
 await click('#more-events');await until('document.querySelectorAll("#events article").length===400');checks.push('Return from workbench restores buttons and ignores abandoned response');
 holdAfter=-1;await click('[data-session-id=A]');for(let i=0;!held&&i<100;i++)await pause(10);assert.ok(held);
 await click('[data-session-id=B]');await until('document.querySelector("#events").textContent.includes("B 独立记录")');release();await pause(40);
 assert.equal(await count(),1);assert.match(await text('#reader-title'),/子任务/);assert.doesNotMatch(await text('#events'),/完整长回复/);checks.push('Late response cannot cross session and subtask is labeled');
 await click('[data-section=accounts]');await until('document.querySelectorAll("#users .account-row").length===3');
 await fill('#user-search','采购');assert.equal(await js('document.querySelectorAll("#users .account-row").length'),1);await fill('#user-search','');
 await click('#show-recycled-users');await until('document.querySelectorAll("#users .account-row").length===2');
 const eligible=await js('Array.from(document.querySelectorAll("#users button")).filter(n=>n.textContent==="恢复账号").map(n=>n.disabled)');assert.deepEqual(eligible,[false,true]);
 await js('Array.from(document.querySelectorAll("#users button")).find(n=>n.textContent==="恢复账号"&&!n.disabled).click()');await until('document.querySelector("dialog[open]")');
 await js('document.querySelector("dialog form").requestSubmit()');await until('document.querySelectorAll("#users .account-row").length===1');
 assert.equal(calls.filter(row=>row.action==='admin.restoreUser').length,1);
 await click('#show-archived-users');await until('document.querySelectorAll("#users .account-row").length===1');assert.match(await text('#users'),/档案同事/);
 assert.equal(await js('document.querySelectorAll("#users button").length'),1);checks.push('Account search, recycling deadline, confirmed restore and archive read access');
 await click('#show-active-users');await until('document.querySelectorAll("#users .account-row").length===4');
 await js('Array.from(document.querySelectorAll("[data-user-id=alice] button")).find(n=>n.textContent==="编辑").click()');await until('document.querySelector("#account-dialog[open]")');
 await fill('#account-job-title','采购主管');await js('document.querySelector("#account-form").requestSubmit()');await until('!document.querySelector("#account-dialog")');
 assert.equal(users.find(user=>user.id==='alice').jobTitle,'采购主管');
 await click('#new-account');await until('document.querySelector("#account-dialog[open]")');
 await fill('#account-username','newemployee');await fill('#account-display-name','新同事');
 assert.equal(await js('document.querySelector("#account-role").value'),'employee');
 await js('document.querySelector("#account-form").requestSubmit()');await until('document.querySelector("dialog .credential")');
 assert.equal(calls.filter(row=>row.action==='admin.createUser').length,1);await js('document.querySelector("dialog form").requestSubmit()');checks.push('Account edit, default employee creation and one-time credential display');
 await click('[data-section=chat]');unsupported=true;await click('#chat-search-submit');await until('document.querySelector("#sessions").textContent.includes("尚不支持")');
 assert.equal(calls.filter(row=>row.action==='admin.sessions').length,0);checks.push('Old server is explicit; never substitutes first 100 sessions');
 unsupported=false;await click('#chat-search-submit');await until('document.querySelectorAll("#sessions .session-row").length===2');
 holdAfter=-1;await click('[data-session-id=A]');for(let i=0;!held&&i<100;i++)await pause(10);assert.ok(held);
 state={...state,user:{id:'employee-other',role:'employee',username:'other',displayName:'另一个账号'}};
 window.webContents.send('rufa:state',state);await until('document.querySelector("#open-admin").hidden');release();await pause(40);
 assert.equal(await count(),0);assert.equal(await text('#users'),'');assert.equal(await text('#sessions'),'');assert.equal(await js('document.querySelectorAll("dialog").length'),0);
 checks.push('Role/account change clears all management data and cancels pending display');
 assert.deepEqual(errors,[]);assert.equal(calls.some(row=>/lease|model|tools|prompt|execute/.test(row.action)),false);
 await writeFile(join(output,'report.json'),JSON.stringify({passed:true,checks,syntheticAccounts:true,modelCalls:0},null,2));
}
main().then(()=>{window?.destroy();app.quit()}).catch(async error=>{await mkdir(output,{recursive:true});await writeFile(join(output,'report.json'),JSON.stringify({passed:false,checks,error:String(error.stack||error),errors},null,2));window?.destroy();app.exit(1)});

