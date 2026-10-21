// Test entry only. No production env flag, feed override, network or installer execution.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdir, writeFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const output = resolve(process.argv[2]), client = resolve(process.argv[3]);
app.setPath('userData', join(output, 'profile'));
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject}; };
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
let window, controller;
async function main() {
  await app.whenReady();nativeTheme.themeSource='dark';await mkdir(output,{recursive:true});
  const {StartupUpdateController,verifyUpdateArtifact}=await import(pathToFileURL(join(client,'dist/startup-update.js')).href);
  const check1=deferred(),check2=deferred(),download=deferred(),verification=deferred();
  const bytes=Buffer.alloc(4096,1), filename='Rufa-DSH-0.3.0-x64-Setup.exe', path=join(output,filename);
  await writeFile(path,Buffer.alloc(4096,2)); // Deliberate bad checksum; this is never an executable.
  const sha512=createHash('sha512').update(bytes).digest('base64');
  const meta={version:'0.3.0',files:[{url:'releases/0.3.0/'+filename,sha512,size:4096}]};
  let attempts=0, installs=0, booting=true, downloadProgress;
  controller=new StartupUpdateController({enabled:true,currentVersion:'0.2.0',canInstall:()=>booting,
    createUpdater:()=>{const check=++attempts===1?check1:check2;return{check:()=>check.promise,
      download:async(_signal,progress)=>{downloadProgress=progress;progress({transferred:1024,total:4096,bytesPerSecond:512});return download.promise;},
      install:()=>{installs++;},dispose(){}};},
    verify:async(...args)=>{await verification.promise;return verifyUpdateArtifact(...args);},
  });
  const state=()=>({user:null,harness:{status:'stopped'},version:'0.2.0',development:true,booting,update:controller.state});
  const ui=join(client,'dist/renderer/index.html');
  window=new BrowserWindow({width:1100,height:760,show:false,backgroundColor:'#111111',webPreferences:{preload:join(client,'dist/preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  window.removeMenu();
  ipcMain.handle('rufa:command',async(event,action,input)=>{
    if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==pathToFileURL(ui).href)throw new Error('Untrusted sender');
    if(action==='update.retry'||action==='update.continue'){
      if(input!=null||!booting||!controller.blocking)return{ok:false,error:{message:'Closed update gate'}};
      if(action==='update.retry')controller.retry();else controller.continueCurrent();
    }else if(action==='login.saved')return{ok:true,value:{remembered:false,username:''}};
    else assert.equal(action,'state');
    return{ok:true,value:state()};
  });
  const publish=()=>window.webContents.send('rufa:state',state());controller.on('change',publish);
  await window.loadFile(ui);window.showInactive();window.webContents.debugger.attach('1.3');
  async function capture(name){const image=await window.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});await writeFile(join(output,name+'.png'),Buffer.from(image.data,'base64'));}
  const gate=controller.start();
  async function until(predicate){for(let i=0;i<200;i++){if(await predicate())return;await pause(10);}throw new Error('UI phase timed out');}
  async function shot(name,phase){await until(()=>window.webContents.executeJavaScript(`document.querySelector('#loading-message').textContent.includes(${JSON.stringify(phase)})`));await pause(360);
    await capture(name);
    const layout=await window.webContents.executeJavaScript(`(()=>{const p=document.querySelector('#update-progress'),d=document.querySelector('#update-detail'),box=document.querySelector('.loading-content').getBoundingClientRect();return{detail:d.textContent,value:p.value,progressVisible:!p.hidden,retry:!document.querySelector('#update-retry').hidden,canContinue:!document.querySelector('#update-continue').hidden,inside:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,scroll:document.documentElement.scrollWidth>innerWidth};})()`);
    assert.equal(layout.inside,true);assert.equal(layout.scroll,false);return layout;
  }
  await shot('checking','正在检查');
  check1.reject(new Error('synthetic offline'));
  const offline=await shot('offline','更新暂未完成');assert.equal(offline.retry,true);assert.equal(offline.canContinue,true);
  await window.webContents.executeJavaScript("document.querySelector('#update-retry').click();document.querySelector('#update-retry').click()");
  await until(()=>attempts===2);assert.equal(booting,true);assert.equal(installs,0);
  check2.resolve(meta);await until(()=>!!downloadProgress);
  const downloading=await shot('downloading','正在下载');assert.equal(downloading.value,25);assert.match(downloading.detail,/1.0 KB \/ 4.0 KB/);
  download.resolve([path]);await shot('verifying','正在校验');assert.equal(booting,true);assert.equal(installs,0);
  verification.resolve();const bad=await shot('verification-error','更新暂未完成');assert.match(bad.detail,/校验未通过/);
  await window.webContents.executeJavaScript("document.querySelector('#update-continue').click()");assert.equal(await gate,true);booting=false;publish();
  await until(()=>window.webContents.executeJavaScript("!document.querySelector('#login-view').hidden"));await pause(360);
  await capture('continue-login');
  downloadProgress({transferred:4096,total:4096,bytesPerSecond:100});await pause(50);assert.equal(installs,0);assert.equal(controller.state.phase,'skipped');
  const late=await window.webContents.executeJavaScript("window.rufa.call('update.retry')");assert.equal(late.ok,false);
  await writeFile(join(output,'report.json'),JSON.stringify({passed:true,attempts,installs,networkRequests:0,realInstallerExecuted:false,downloading},null,2));
}
main().then(()=>{controller?.stop();window?.destroy();app.quit();}).catch(async error=>{
  await mkdir(output,{recursive:true});await writeFile(join(output,'report.json'),JSON.stringify({passed:false,error:String(error.stack||error)}));controller?.stop();window?.destroy();app.exit(1);
});
