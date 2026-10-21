// Read-only inspection / graceful restart helper for this project's local development Electron.
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const action = process.argv[2] ?? 'inspect';
if (!['inspect', 'message-actions', 'layout', 'close', 'settings', 'preferences', 'sidebar-settings', 'sidebar-spacing', 'plus-menu', 'motion', 'office-plugins', 'project-dialog'].includes(action)) throw new Error('Unknown development check');
const pages = await (await fetch('http://127.0.0.1:9337/json/list')).json();
const sockets = [];
async function connect(target) {
  if (!target) throw new Error('Development page not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl); sockets.push(socket);
  await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  let serial=0; const pending=new Map();
  socket.addEventListener('message',event=>{const value=JSON.parse(event.data);const waiter=pending.get(value.id);if(waiter){pending.delete(value.id);clearTimeout(waiter.timer);value.error?waiter.reject(new Error(value.error.message)):waiter.resolve(value.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Development page timeout'));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const value=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error('Development page evaluation failed');return value.result.value;};
  return {call,evaluate};
}
try {
  const shell=await connect(pages.find(page=>page.type==='page'&&page.url.endsWith('/renderer/index.html')));
  const state=await shell.evaluate('window.rufa.call("state").then(r=>({development:r.value.development,signedIn:Boolean(r.value.user),harness:r.value.harness.status}))');
  if (!state.development) throw new Error('Refusing to control a non-development client');
  if (!pages.some(page=>page.type==='page'&&page.url.startsWith('http://127.0.0.1:'))) throw new Error('Harness view unavailable: '+JSON.stringify(state));
  const harness=await connect(pages.find(page=>page.type==='page'&&page.url.startsWith('http://127.0.0.1:')));
  const activity=await harness.evaluate('({running:[...document.querySelectorAll("button")].some(e=>/^(停止|停止生成|Stop|Stop generation)$/.test((e.getAttribute("aria-label")||e.textContent).trim())),draft:[...document.querySelectorAll("[contenteditable=true],textarea")].reduce((n,e)=>n+(e.value||e.textContent||"").trim().length,0)})');
  console.log(JSON.stringify({state,activity}));
  if (action === 'project-dialog') {
    if(activity.running||activity.draft) throw new Error('A task or draft is active; client was left unchanged');
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    await harness.call('Emulation.setFocusEmulationEnabled',{enabled:true});
    await harness.evaluate('document.querySelector("[data-rufa-create-project]").click()');
    try {
      await pause(300);
      const result=await harness.evaluate(`(()=>{
        const dialog=document.querySelector('[data-rufa-project-dialog]'), info=document.querySelector('[data-rufa-project-info]'), rect=info?.getBoundingClientRect();
        return {automatic:dialog?.querySelector('[data-rufa-project-auto]')?.checked,
          disabled:dialog?.querySelector('[data-rufa-project-folders]')?.getAttribute('aria-disabled'),
          pathInput:!!dialog?.querySelector('input[name=projectPath]'),
          nameFirst:dialog?.querySelector('input')?.name==='projectName',
          x:rect?.x+rect?.width/2,y:rect?.y+rect?.height/2};
      })()`);
      if(!result.automatic||result.disabled!=='true'||result.pathInput||!result.nameFirst) throw new Error('Project dialog defaults failed');
      await harness.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:result.x,y:result.y});
      await pause(900);
      const tooltip=await harness.evaluate('document.body.innerText.includes("智能体能够使用或参考的文件夹")');
      if(!tooltip) {
        console.log(JSON.stringify(await harness.evaluate(`({visible:document.visibilityState,focused:document.hasFocus(),tooltips:[...document.querySelectorAll('[role=tooltip]')].map(e=>({text:e.textContent,visibility:getComputedStyle(e).visibility,html:e.outerHTML})),hover:[...document.querySelectorAll(':hover')].map(e=>({tag:e.tagName,cls:e.className})),dialog:document.querySelector('[data-rufa-project-dialog]')?.getBoundingClientRect().toJSON()})`)));
        throw new Error('Project folder tooltip missing');
      }
      await harness.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:20,y:20});
      await pause(250);
      const screenshot=join(tmpdir(),'rufa-project-dialog-actual.png');
      const shot=await harness.call('Page.captureScreenshot',{format:'png'});
      await writeFile(screenshot,Buffer.from(shot.data,'base64'));
      await harness.evaluate('document.querySelector("input[data-rufa-project-auto]").click()');
      const manual=await harness.evaluate('document.querySelector("[data-rufa-project-folders]").getAttribute("aria-disabled")==="false"&&!document.querySelector("[data-rufa-project-browse]").disabled');
      if(!manual) throw new Error('Manual folder selection remains disabled');
      console.log(JSON.stringify({projectDialog:true,automaticDefault:true,tooltip,manual,screenshot}));
    } finally {
      await harness.evaluate('document.querySelector("[data-rufa-project-cancel]")?.click()');
      await harness.call('Emulation.setFocusEmulationEnabled',{enabled:false});
    }
  }
  if (action === 'message-actions') {
    const actions = await harness.evaluate(`(()=>{
      const bars=[...document.querySelectorAll('[data-clock="start"]')];
      return {startup:document.documentElement.dataset.rufaStartup,count:bars.length,
        native:bars.every(e=>!!e.querySelector('span')?.textContent?.trim()&&!!e.querySelector('button[aria-label="复制"] svg')&&e.querySelector('button')?.textContent===''),
        legacyCopyLabel:[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='复制 / Copy'),
        selected:JSON.parse(localStorage.getItem('dsh.sessions.current')||'{}').sessionId};
    })()`);
    console.log(JSON.stringify(actions));
    if(actions.startup!=='ready'||!actions.count||!actions.native||actions.legacyCopyLabel) throw new Error('Native message action inspection failed');
  }
  if (action === 'sidebar-spacing') console.log(JSON.stringify(await harness.evaluate(`(()=>{
    const guide=document.querySelector('[data-sidebar-right-guide]');
    if(!guide)return {visible:false};
    const box=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,class:e.className,top:r.top,bottom:r.bottom,height:r.height,display:s.display,gap:s.gap,marginTop:s.marginTop,marginBottom:s.marginBottom,text:e.innerText?.slice(0,100)};};
    return {visible:true,guide:box(guide),children:[...guide.children].map(e=>({...box(e),children:[...e.children].map(box)}))};
  })()`)));
  if(action==='layout') console.log(JSON.stringify(await harness.evaluate(`(()=>{
    const ancestors=[];let el=document.querySelector('[data-composer-card]');
    while(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);ancestors.push({tag:el.tagName,id:el.id,class:el.className,style:el.getAttribute('style'),x:r.x,y:r.y,w:r.width,h:r.height,display:s.display,flex:s.flex,minHeight:s.minHeight,overflow:s.overflow,paddingBottom:s.paddingBottom,grid:s.gridTemplateRows});el=el.parentElement;}
    return {viewport:{width:innerWidth,height:innerHeight,scrollHeight:document.documentElement.scrollHeight},ancestors,
      panels:[...document.querySelectorAll('[data-dsh-center-col],[data-dsh-workbench-mode]')].map(e=>({class:e.className,style:e.getAttribute('style'),data:{...e.dataset}}))};
  })()`)));
  if(action==='inspect') console.log(JSON.stringify(await harness.evaluate('({startup:document.documentElement.dataset.rufaStartup,status:document.getElementById("rufa-startup-status")?.textContent,rootVisibility:getComputedStyle(document.getElementById("root")).visibility,frameClass:document.querySelector("[class$=_sidebarCol]")?.parentElement.className,centerClass:document.querySelector("[class$=_centerCol]")?.className,composerInCenter:!!document.querySelector("[class$=_centerCol] [data-composer-card]")})')));
  if(action==='inspect') console.log(JSON.stringify(await harness.evaluate('({add:[...document.querySelectorAll("[data-composer-card] button[aria-haspopup=listbox]")].map(e=>({label:e.getAttribute("aria-label"),disabled:e.disabled,expanded:e.getAttribute("aria-expanded"),class:e.className})),menus:[...document.querySelectorAll("[data-trigger-menu]")].map(e=>e.innerText),options:[...document.querySelectorAll("[role=option]")].map(e=>({text:e.textContent,class:e.className})),alerts:[...document.querySelectorAll("[role=alert]")].map(e=>e.textContent)})')));
  if(action==='close') {
    if(activity.running||activity.draft) throw new Error('A task or draft is active; client was left open');
    await shell.evaluate('window.close()').catch(()=>{});
  } else if(action==='motion') {
    if(activity.running||activity.draft) throw new Error('A task or draft is active; client was left unchanged');
    const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    await harness.call('Page.enable');
    const registration=await harness.call('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.__rufaBootCheck=[];
      new MutationObserver(()=>{
        const state=document.documentElement.dataset.rufaStartup, root=document.getElementById('root');
        const last=window.__rufaBootCheck.at(-1);
        const value={state,rootVisible:!!root&&getComputedStyle(root).visibility!=='hidden',composer:!!root?.querySelector('[data-composer-card]'),workspace:!!root?.querySelector('[class$="_workspaceLabel"]')};
        if(!last||JSON.stringify(last)!==JSON.stringify(value))window.__rufaBootCheck.push(value);
      }).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['data-rufa-startup']});
    `});
    try {
      await harness.call('Emulation.setCPUThrottlingRate',{rate:4});
      await harness.call('Page.reload');
      let boot, captured=false;
      for(let attempt=0;attempt<200;++attempt){
        await pause(100);
        try {boot=await harness.evaluate('({state:document.documentElement.dataset.rufaStartup,history:window.__rufaBootCheck,cover:!!document.getElementById("rufa-startup"),reduced:matchMedia("(prefers-reduced-motion: reduce)").matches})');} catch {continue;}
        if(!captured&&boot.state==='pending'){
          const capture=await harness.call('Page.captureScreenshot',{format:'png'});
          await writeFile(join(tmpdir(),'rufa-startup-skeleton.png'),Buffer.from(capture.data,'base64')); captured=true;
        }
        if(boot.state==='ready'&&!boot.cover)break;
      }
      console.log(JSON.stringify({boot,captured}));
      if(boot?.state!=='ready'||boot.cover||!boot.history?.length||boot.history.some(row=>row.state==='pending'&&row.rootVisible))throw new Error('Startup readiness failed');
      await harness.call('Emulation.setCPUThrottlingRate',{rate:1});
      const sidebar=()=>harness.evaluate('(()=>{const col=document.querySelector("#root [class$=_sidebarCol]"),frame=col.parentElement;return {width:col.getBoundingClientRect().width,collapsed:frame.dataset.sidebarCollapsed=== "true",transition:getComputedStyle(frame).transitionDuration,reduced:matchMedia("(prefers-reduced-motion: reduce)").matches}})()');
      const toggle=()=>harness.evaluate('document.querySelector("#root [class$=_sidebarCol] button[class$=_toggle]").click()');
      const initial=await sidebar();
      await toggle();await pause(90);const middle=await sidebar();await pause(400);const settled=await sidebar();
      await toggle();await pause(90);const reopening=await sidebar();await pause(400);const restored=await sidebar();
      console.log(JSON.stringify({initial,middle,settled,reopening,restored}));
      if(initial.collapsed===settled.collapsed||initial.collapsed!==restored.collapsed||Math.abs(initial.width-restored.width)>2)throw new Error('Sidebar toggle failed');
      if(!initial.reduced&&!(middle.width>Math.min(initial.width,settled.width)&&middle.width<Math.max(initial.width,settled.width)))throw new Error('Sidebar did not interpolate');
      await harness.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await toggle();await pause(50);const reduced=await sidebar();await toggle();await pause(50);
      if(reduced.transition!=='0s')throw new Error('Reduced-motion sidebar transition active');
      console.log(JSON.stringify({reducedMotion:reduced}));
    } finally {
      await harness.call('Emulation.setCPUThrottlingRate',{rate:1});
      await harness.call('Emulation.setEmulatedMedia',{features:[]});
      await harness.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:registration.identifier});
    }
  } else if(action==='plus-menu') {
    if(activity.running||activity.draft) throw new Error('A task or draft is active; client was left unchanged');
    await harness.evaluate('document.querySelector("[data-composer-card] button[aria-haspopup=listbox][class$=_add]").click()');
    let detail;
    for(let attempt=0;attempt<30;++attempt){
      detail=await harness.evaluate('({names:[...document.querySelectorAll("[data-trigger-menu] [role=option] [class$=_itemAlias]")].map(e=>e.textContent),headings:[...document.querySelectorAll("[data-trigger-menu] [role=presentation]")].map(e=>e.textContent)})');
      if(detail.names.length)break;await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(detail.names.join()!=='file,goal,plan'||detail.headings.some(text=>/^(指令|Commands)$/.test(text)))throw new Error('Plus menu verification failed: '+JSON.stringify(detail));
    const selected=[];
    for(let attempt=0;attempt<7;++attempt){
      await harness.call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
      await harness.call('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
      selected.push(await harness.evaluate('document.querySelector("[data-trigger-menu] [role=option][aria-selected=true] [class$=_itemAlias]")?.textContent'));
    }
    if(selected.some(name=>!detail.names.includes(name))||new Set(selected).size!==3)throw new Error('Plus menu keyboard navigation failed');
    const capture=await harness.call('Page.captureScreenshot',{format:'png'});
    const screenshot=join(tmpdir(),'rufa-current-plus-menu.png');await writeFile(screenshot,Buffer.from(capture.data,'base64'));
    console.log(JSON.stringify({...detail,keyboardSelection:selected,screenshot}));
    await harness.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await harness.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  } else if(action==='office-plugins') {
    if(activity.running||activity.draft) throw new Error('A task or draft is active; client was left unchanged');
    const file=process.argv[3];
    if(!file)throw new Error('A synthetic Office fixture path is required');
    const ready=await harness.evaluate(`({startup:document.documentElement.dataset.rufaStartup,picker:!!document.querySelector('input[type=file][accept^=".pdf"]'),duplicate:!!document.querySelector('button[aria-label="添加文件 / Add file"]')})`);
    if(ready.startup!=='ready'||!ready.picker||ready.duplicate)throw new Error('OCR composer plugin unavailable: '+JSON.stringify(ready));
    await harness.call('DOM.enable');
    const {root}=await harness.call('DOM.getDocument');
    const {nodeId}=await harness.call('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file][accept^=".pdf"]'});
    if(!nodeId)throw new Error('OCR file picker unavailable');
    await harness.call('DOM.setFileInputFiles',{nodeId,files:[file,join(file,'..','sample.txt')]});
    let result;
    for(let attempt=0;attempt<150;++attempt){
      result=await harness.evaluate(`({cards:document.querySelectorAll('[aria-label="已添加的文件 / Added files"] button[aria-label^="移除 / Remove"]').length,error:document.querySelector('[class$=_error]')?.textContent})`);
      if(result.cards===2||result.error)break;await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(result.cards!==2||result.error)throw new Error('OCR attachment failed: '+JSON.stringify(result));
    const capture=await harness.call('Page.captureScreenshot',{format:'png'});
    const screenshot=join(tmpdir(),'rufa-office-attachment.png');await writeFile(screenshot,Buffer.from(capture.data,'base64'));
    await harness.evaluate(`document.querySelector('[aria-label="已添加的文件 / Added files"] button[aria-label^="移除 / Remove"]').click()`);
    await new Promise(resolve=>setTimeout(resolve,100));
    const remaining=await harness.evaluate(`({cards:document.querySelectorAll('[aria-label="已添加的文件 / Added files"] button').length,chips:document.querySelectorAll('[data-composer-chip="file-attachment"]').length})`);
    if(remaining.cards!==1||remaining.chips!==1)throw new Error('Removing one attachment affected another: '+JSON.stringify(remaining));
    await harness.evaluate(`document.querySelector('[aria-label="已添加的文件 / Added files"] button[aria-label^="移除 / Remove"]').click()`);
    const exits = [
      ['empty drop','document.dispatchEvent(new DragEvent("drop",{bubbles:true,dataTransfer:new DataTransfer()}))'],
      ['Escape','document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'],
      ['window blur','window.dispatchEvent(new Event("blur"))'],
      ['click','document.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))'],
      ['drag end','window.dispatchEvent(new Event("dragend"))'],
    ];
    try {
      for(const [name, reset] of exits) {
        await harness.evaluate('(()=>{const data=new DataTransfer();data.items.add(new File(["fixture"],"fixture.txt",{type:"text/plain"}));document.dispatchEvent(new DragEvent("dragenter",{bubbles:true,dataTransfer:data}));})()');
        await new Promise(resolve=>setTimeout(resolve,100));
        const shown=await harness.evaluate('[...document.querySelectorAll("[role=status]")].some(e=>e.textContent.includes("拖放文件以上传"))');
        await harness.evaluate(reset);await new Promise(resolve=>setTimeout(resolve,100));
        const hidden=await harness.evaluate('![...document.querySelectorAll("[role=status]")].some(e=>e.textContent.includes("拖放文件以上传"))');
        if(!shown||!hidden)throw new Error('OCR drag cancellation failed: '+name);
      }
    } finally { await harness.evaluate('window.dispatchEvent(new Event("dragend"))'); }
    const clean=await harness.evaluate(`({cards:document.querySelectorAll('[aria-label="已添加的文件 / Added files"] button').length,draft:[...document.querySelectorAll('[contenteditable=true],textarea')].reduce((n,e)=>n+(e.value||e.textContent||'').trim().length,0),overlay:[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('拖放文件以上传'))})`);
    if(clean.cards||clean.draft||clean.overlay)throw new Error('OCR drag/remove check failed: '+JSON.stringify(clean));
    console.log(JSON.stringify({attachments:2,independentRemoval:true,dragExits:exits.map(([name])=>name),clean,screenshot}));
  } else if(action==='preferences') {
    if(activity.running||activity.draft) throw new Error('A task or draft is active; client was left unchanged');
    const until=async fn=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Preferences did not become ready');};
    await harness.evaluate('document.querySelector(".rufa-more-trigger").click()');
    await until(()=>harness.evaluate('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("设置"))'));
    await harness.evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("设置")).click()');
    await until(()=>harness.evaluate('[...document.querySelectorAll("button")].some(e=>e.textContent.trim()==="工作偏好")'));
    await harness.evaluate('[...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="工作偏好").click()');
    await until(()=>harness.evaluate('Boolean(document.querySelector("[data-rufa-preferences] input[type=checkbox]:not(:disabled)"))'));
    const result=await until(()=>harness.evaluate('window.rufaAccount.preferences("snapshot").then(r=>r.ok&&r.value.status==="synced"&&({enabled:r.value.settings.enabled,count:r.value.entries.filter(e=>!e.deletedAt).length,pending:r.value.pendingCount,status:r.value.status}))'));
    const screenshot=join(tmpdir(),'rufa-work-preferences-actual.png');
    const capture=await harness.call('Page.captureScreenshot',{format:'png'});await writeFile(screenshot,Buffer.from(capture.data,'base64'));
    console.log(JSON.stringify({preferences:true,...result,screenshot}));
    await harness.evaluate('document.querySelector("[data-shortcut-modal=settings] button[class$=_close]").click()');
  } else if(action==='settings'||action==='sidebar-settings') {
    await harness.evaluate('document.querySelector(".rufa-more-trigger").click()');
    await harness.evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("设置")).click()');
    let detail;
    for(let attempt=0;attempt<30;++attempt){
      detail=await harness.evaluate('({ready:Boolean(document.querySelector("#rufa-job-title")),configButton:[...document.querySelectorAll("button")].some(e=>e.textContent.includes("打开配置文件")),permissionButton:[...document.querySelectorAll("button")].some(e=>["仅可查看","工作区内修改","完全权限","自动审查"].includes(e.textContent.trim())),close:Boolean(document.querySelector("[data-shortcut-modal=settings] button[class$=_close]"))})');
      if(detail.ready)break;await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!detail.ready||detail.configButton||detail.permissionButton||!detail.close)throw new Error('Settings verification failed: '+JSON.stringify(detail));
    if(action==='sidebar-settings') {
      const buttons=await harness.evaluate('[...document.querySelectorAll("[data-shortcut-modal=settings] button")].map(e=>e.textContent.trim())');
      detail.sidebarEntryRemoved=!buttons.some(label=>/SideBar|Better Sidebar|侧边卡片/i.test(label));
      detail.otherSettingsPreserved=['账号信息','工作偏好','通用设置'].every(label=>buttons.includes(label));
      if(!detail.sidebarEntryRemoved||!detail.otherSettingsPreserved)throw new Error('Settings navigation verification failed: '+JSON.stringify(detail));
    }
    const capture=await harness.call('Page.captureScreenshot',{format:'png'});
    const screenshot=join(tmpdir(),action==='sidebar-settings'?'rufa-settings-no-sidebar.png':'rufa-current-settings.png');await writeFile(screenshot,Buffer.from(capture.data,'base64'));
    console.log(JSON.stringify({...detail,screenshot}));
    await harness.evaluate('document.querySelector("[data-shortcut-modal=settings] button[class$=_close]").click()');
  }
} finally {
  await Promise.all(sockets.map(socket => new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(resolve, 1000);
    socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.close();
  })));
  // Let Windows finish native WebSocket handle teardown before module failure
  // propagates, including the intentional busy-client refusal.
  await new Promise(resolve => setTimeout(resolve, 100));
}
