// Real Electron playback of original files; all model calls are refused locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startWorkbenchFixture, until } from './fixtures/desktop-workbench.mjs';
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

test('native and WASM players decode original video/audio, seek, retain paused frames and never request conversion',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 240000 }, async t => {
    const fixture = await startWorkbenchFixture(t, { prefix: 'rufa-media-direct-', visibleWindow: process.env.RUFA_MEDIA_VISIBLE === '1' });
    const ui = fixture.harness, evaluate = expression => ui.evaluate(expression);
    async function capture(name) {
      const result = await ui.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(fixture.temporary, name + '.png'), Buffer.from(result.data, 'base64'));
    }
    const session = await until(() => fixture.cache().at(-1), 'local session'), workspace = session.header.cwd;
    const run = args => execFileSync(process.env.RUFA_MEDIA_TEST_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, timeout: 30000, stdio: 'pipe' });
    const videoInputs = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4'];
    run([...videoInputs, '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', join(workspace, 'mpeg4-aac.mp4')]);
    run([...videoInputs, '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'libmp3lame', join(workspace, 'mpeg4-mp3.avi')]);
    run([...videoInputs, '-c:v', 'mpeg2video', '-c:a', 'aac', join(workspace, 'mpeg2.mkv')]);
    run([...videoInputs, '-c:v', 'mpeg2video', '-c:a', 'mp2', join(workspace, 'mpeg2-mp2.mkv')]);
    run([...videoInputs, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(workspace, 'h264-aac.mp4')]);
    for (const [name, codec] of [['sound.mp3','libmp3lame'],['sound.wav','pcm_s16le'],['sound.flac','flac'],['sound.m4a','aac'],['sound.ogg','libvorbis'],['sound.opus','libopus'],['sound.wma','wmav2']])
      run(['-f','lavfi','-i','sine=frequency=660:sample_rate=48000','-t','4','-c:a',codec,join(workspace,name)]);
    if (process.env.RUFA_ACTUAL_MEDIA_SAMPLE) await copyFile(process.env.RUFA_ACTUAL_MEDIA_SAMPLE, join(workspace, 'actual-original.mp4'));
    await writeFile(join(workspace,'broken.mp4'),'This is not a movie.');
    await writeFile(join(workspace,'broken.mp3'),'This is not audio.');
    const cases = [['h264-aac.mp4','native'],['mpeg4-aac.mp4','direct'],['mpeg4-mp3.avi','direct'],['mpeg2.mkv','direct'],
      ...['mp3','wav','flac','m4a','ogg','opus'].map(ext=>['sound.'+ext,'audio']),
      ...(process.env.RUFA_ACTUAL_MEDIA_SAMPLE ? [['actual-original.mp4','direct']] : [])];
    const originals = new Map(await Promise.all(cases.map(async([name])=>[name,await hash(join(workspace,name))])));
    // Observe real constructors/fetches without replacing the decoder or media data.
    await evaluate(`(()=>{
      window.__mediaEngines=[];let Player;Object.defineProperty(window,'AVPlayer',{configurable:true,get:()=>Player,set:value=>{Player=new Proxy(value,{construct(target,args){const result=Reflect.construct(target,args);const record={engine:result,container:args[0].container};const originalLoad=result.load;result.load=async function(...a){try{const value=await originalLoad.apply(this,a);record.streams=this.getStreams().map(s=>({mediaType:s.mediaType,keys:Object.keys(s),codecType:s.codecparProxy?.codecType}));return value;}catch(e){record.error=String(e.stack||e);throw e;}};window.__mediaEngines.push(record);return result;}});}});
      window.__OriginalAudio=window.Audio;window.Audio=new Proxy(window.Audio,{construct(target,args){const value=Reflect.construct(target,args);window.__mediaAudio=value;return value;}});
      window.__mediaRequests=[];const original=window.fetch;window.fetch=function(input,...args){window.__mediaRequests.push(String(input?.url||input));return original.call(this,input,...args);};
      window.__mediaRoot=()=>[...document.querySelectorAll('[data-rufa-video-mode]')].find(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);
      window.__mediaEngine=()=>window.__mediaEngines.findLast(e=>e.container===window.__mediaRoot()?.querySelector('[data-rufa-avplayer=container]'))?.engine;
      [...document.querySelectorAll('button')].find(e=>/打开右侧|展开右侧|Expand right/i.test(e.getAttribute('aria-label')||''))?.click();
    })()`);
    await until(()=>evaluate('Boolean(document.querySelector("[data-sidebar-right-guide]"))'),'sidebar guide');
    async function open(name){
      await until(()=>evaluate(`(()=>{if([...document.querySelectorAll('[role=button][title]')].some(e=>e.title.endsWith(${JSON.stringify(name)})&&e.getBoundingClientRect().height>0))return true;const e=document.querySelector('[data-sidebar-right-guide-entry=editor]')||[...document.querySelectorAll('button,[role=tab]')].find(e=>e.textContent.trim()==='文件');if(e){e.click();return true;}return false;})()`),'files tab');
      await until(()=>evaluate(`(()=>{const e=[...document.querySelectorAll('[role=button][title]')].find(e=>e.title.endsWith(${JSON.stringify(name)}));if(e){e.click();return true;}return false;})()`),'open '+name);
    }
    const userEval = async expression => { const result=await ui.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails));return result.result?.value; };
    const results=[];
    for(const [name,mode] of cases){
      await open(name);
      if(mode==='direct'){
        await until(()=>evaluate(`window.__mediaRoot()?.dataset.rufaVideoMode==='direct'&&['ready','failed'].includes(window.__mediaRoot()?.dataset.rufaVideoState)&&window.__mediaRoot()?.dataset.rufaVideoState`),'direct ready '+name,30000)
          .then(phase=>assert.equal(phase,'ready'))
          .catch(async error=>{error.message+=' '+JSON.stringify(await evaluate(`({text:document.body.innerText.slice(-1500),requests:window.__mediaRequests.filter(n=>/player|video/.test(n)),engines:window.__mediaEngines.map(e=>({error:e.error,streams:e.streams}))})`))+' CONSOLE '+JSON.stringify(ui.errors.slice(-12));await writeFile(join(fixture.temporary,'failure.txt'),error.message);throw error;});
        await userEval(`window.__mediaRoot().querySelector('button[aria-label="播放"]').click()`);
        await until(()=>evaluate(`Number(window.__mediaEngine()?.currentTime)>200&&Number(window.__mediaEngine()?.getStats().videoFrameRenderCount)>0`),'direct playing '+name);
        if(name!=='actual-original.mp4') await until(()=>evaluate(`Number(window.__mediaEngine()?.getStats().audioFrameRenderCount)>0`),'audio rendered '+name,10000)
          .catch(async error=>{error.message+=' '+await evaluate(`JSON.stringify(window.__mediaEngine().getStats(),(_,v)=>typeof v==='bigint'?String(v):v)`);throw error;});
        const seek=name==='actual-original.mp4'?40000:1500;
        await evaluate(`window.__mediaEngine().seek(BigInt(${seek}))`);
        await until(()=>evaluate(`Number(window.__mediaEngine().currentTime)>${seek+150}&&Number(window.__mediaEngine().currentTime)<${seek+1200}`),'direct seek rendered '+name);
        await evaluate('window.__mediaEngine().pause()');
        const result=await evaluate(`JSON.parse(JSON.stringify({name:${JSON.stringify(name)},mode:'direct',time:window.__mediaEngine().currentTime,duration:window.__mediaEngine().getDuration(),stats:window.__mediaEngine().getStats()},(_,v)=>typeof v==='bigint'?String(v):v))`);
        assert.ok(Number(result.stats.videoFrameRenderCount)>0);assert.ok(result.stats.width>0&&result.stats.height>0);
        assert.equal(result.stats.videoDecodeErrorPacketCount,0);assert.equal(result.stats.audioDecodeErrorPacketCount,0);
        if(name!=='actual-original.mp4')assert.ok(Number(result.stats.audioFrameRenderCount)>0,'audio rendered '+name);
        results.push(result);
        if(name==='actual-original.mp4'){
          await new Promise(resolve=>setTimeout(resolve,250));
          await capture('working-video');
          const geometry=await evaluate(`(()=>{const r=window.__mediaRoot(),surface=r.querySelector('.rufa-media-surface').getBoundingClientRect(),bar=r.querySelector('[data-rufa-avplayer=controls]').getBoundingClientRect(),buttons=[...r.querySelectorAll('.rufa-media-row button')];return{inside:bar.top>=surface.top&&bar.bottom<=surface.bottom+1,labels:buttons.map(e=>e.getAttribute('aria-label')),texts:buttons.map(e=>e.textContent),hasSelect:!!r.querySelector('select')}})()`);
          assert.equal(geometry.inside,true);assert(geometry.labels.includes('播放'));assert(geometry.texts.every(t=>t===''));assert.equal(geometry.hasSelect,false);
          // Sample the actual decoder canvas, not a synthetic poster or placeholder.
          await evaluate(`window.__frameSignature=()=>{const source=window.__mediaRoot().querySelector('[data-rufa-avplayer=container] canvas');const c=document.createElement('canvas');c.width=64;c.height=36;const ctx=c.getContext('2d');ctx.drawImage(source,0,0,64,36);const bytes=ctx.getImageData(0,0,64,36).data;let lit=0,hash=2166136261;for(let i=0;i<bytes.length;i++){hash=Math.imul(hash^bytes[i],16777619);if(i%4!==3&&bytes[i]>15)lit++}return{hash:hash>>>0,lit};}`);
          const before=await evaluate('window.__frameSignature()');assert(before.lit>100,'paused original contains visible image pixels');
          const count=await evaluate('window.__mediaEngines.length');
          await evaluate(`Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));`);
          await until(()=>evaluate(`window.__mediaRoot()?.dataset.rufaVideoState==='suspended'`),'window hidden');
          await evaluate(`delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'));`);
          await until(()=>evaluate(`window.__mediaRoot()?.dataset.rufaVideoState==='ready'`),'window visible');
          await new Promise(resolve=>setTimeout(resolve,150));
          assert.deepEqual(await evaluate('window.__frameSignature()'),before,'switching windows preserves exact paused pixels');
          assert.equal(await evaluate('window.__mediaEngines.length'),count,'no decoder restart');
          assert.equal(await evaluate(`!!window.__mediaRoot().querySelector('button[aria-label="播放"]')`),true,'remains paused');
          await capture('paused-after-window-switch');
          await userEval(`window.__mediaRoot().querySelector('button[aria-label="更多选项"]').click()`);
          await until(()=>evaluate(`!!window.__mediaRoot().querySelector('[role=menu]')`),'overflow menu');
          await userEval(`[...window.__mediaRoot().querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='播放速度').click()`);
          await userEval(`[...window.__mediaRoot().querySelectorAll('[role=menuitemradio]')].find(e=>e.textContent==='1.5').click()`);
          await userEval(`window.__mediaRoot().querySelector('button[aria-label="全屏"]').click()`);
          await until(()=>evaluate('!!document.fullscreenElement'),'fullscreen').catch(async error=>{error.message+=' '+await evaluate('window.__mediaRoot()?.innerText');throw error;});
          await userEval(`window.__mediaRoot().querySelector('button[aria-label="退出全屏"]').click()`);
          await until(()=>evaluate('!document.fullscreenElement'),'exit fullscreen');
          await open('sound.mp3');await open(name);
          await until(()=>evaluate(`window.__mediaRoot()?.dataset.rufaVideoState==='ready'`),'paused tab returns');
          assert.equal(await evaluate(`!!window.__mediaRoot().querySelector('button[aria-label="播放"]')`),true);
          assert((await evaluate('window.__frameSignature()')).lit>100,'paused image survives sidebar tab and fullscreen resize');
        }
      }else{
        const element=mode==='audio'?'window.__mediaAudio':'window.__mediaRoot()?.querySelector("video")';
        await until(()=>evaluate(`(()=>{const e=${element};return e&&!e.error&&e.readyState>=1&&Number.isFinite(e.duration)&&e.duration>1&&new URL(e.src).searchParams.get('path')?.endsWith(${JSON.stringify(name)});})()`),'native ready '+name);
        await userEval(`(async()=>{const e=${element};e.muted=true;await e.play();})()`);
        await until(()=>evaluate(`${element}.currentTime>0.2`),'native play '+name);
        await evaluate(`(()=>{const e=${element};e.pause();e.currentTime=1.5;})()`);
        await until(()=>evaluate(`!${element}.seeking&&Math.abs(${element}.currentTime-1.5)<0.2`),'native seek '+name);
        const result=await evaluate(`(()=>{const e=${element};return {name:${JSON.stringify(name)},mode:${JSON.stringify(mode)},duration:e.duration,width:e.videoWidth,height:e.videoHeight,audioBytes:e.webkitAudioDecodedByteCount,frames:e.getVideoPlaybackQuality?.().totalVideoFrames};})()`);
        if(mode==='native')assert.ok(result.frames>0&&result.width>0&&result.audioBytes>0);
        if(mode==='audio'){assert.ok(await evaluate('document.querySelectorAll("canvas").length>0'));assert.ok(result.audioBytes>0);}
        results.push(result);if(name==='sound.flac')await capture('working-audio');if(mode==='native')await capture('native-controls-reference');
      }
    }
    // A mounted paused preview retains its canvas across hidden tabs/windows.
    await open('mpeg4-aac.mp4');
    await until(()=>evaluate(`window.__mediaRoot()?.dataset.rufaVideoMode==='direct'`),'return direct');
    await userEval(`window.__mediaRoot().querySelector('button[aria-label="播放"]').click()`);
    await until(()=>evaluate(`Number(window.__mediaEngine()?.currentTime)>100`),'resume direct');
    await open('sound.mp3');
    await until(()=>evaluate(`[...document.querySelectorAll('[data-rufa-video-mode=direct]')].every(e=>e.getBoundingClientRect().width>0||e.dataset.rufaVideoState==='suspended')`),'hidden video suspended');
    // A video with an unsupported audio codec must not silently masquerade as a silent original.
    await open('mpeg2-mp2.mkv');
    await until(()=>evaluate(`window.__mediaRoot()?.dataset.rufaVideoState==='ready'`),'MP2 video ready');
    await userEval(`window.__mediaRoot().querySelector('button[aria-label="播放"]').click()`);
    await until(()=>evaluate(`window.__mediaRoot()?.innerText.includes('音轨暂不支持')&&Number(window.__mediaEngine()?.getStats().videoFrameRenderCount)>0`),'unsupported audio warning with working video');
    for(const name of ['broken.mp4','broken.mp3','sound.wma']){
      await open(name);
      await until(()=>evaluate('document.body.innerText.includes("重试播放")&&/无法|不支持|损坏/.test(document.body.innerText)'),'explicit unsupported/error '+name,30000);
    }
    assert.equal(await evaluate(`window.__mediaRequests.some(u=>u.includes('/preview/'))`),false);
    const assets=await evaluate(`performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/rufa-media-player/.test(n))`);
    assert.ok(assets.some(n=>n.includes('avplayer.js')));assert.ok(assets.every(n=>/^http:\/\/127\.0\.0\.1:/.test(n)));
    assert.equal((await readdir(fixture.account.companyHome)).includes('company-media-preview'),false);
    for(const[name,expected]of originals)assert.equal(await hash(join(workspace,name)),expected,'original unchanged '+name);
    assert.equal(fixture.gatewayCalls,0);assert.equal((await fixture.api.json('GET','/sessions')).sessions.length,0);
    await writeFile(join(fixture.temporary,'results.json'),JSON.stringify({results,assets},null,2));
    t.diagnostic('Real original-file playback results: '+JSON.stringify(results.map(({stats,...rest})=>({...rest,videoFrames:stats?.videoFrameRenderCount,audioFrames:stats?.audioFrameRenderCount})))+'; artifacts '+fixture.temporary+'; model requests 0.');
  });
