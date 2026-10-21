import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Called only by the isolated Electron fixture, never against employee files.
export async function checkMediaPreviewUi({ harness, workspace, artifacts, until, pause }) {
  const wav = Buffer.alloc(44 + 48000 * 3 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 144000; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 2000), 44 + i * 2);
  await writeFile(join(workspace, 'media-fixture.wav'), wav);
  // Use the already bundled OpenCV codec, so a hidden window's paint throttling
  // cannot turn a canvas recording into an empty WebM header.
  execFileSync(join(process.env.RUFA_RUNTIME_ROOT, 'company-python/python.exe'), ['-I', '-c',
    "import cv2,numpy as np,sys\nv=cv2.VideoWriter(sys.argv[1],cv2.VideoWriter_fourcc(*'VP80'),12,(320,180))\nassert v.isOpened()\nfor i in range(36):\n f=np.full((180,320,3),32,dtype=np.uint8);cv2.rectangle(f,((i*5)%260,60),((i*5)%260+60,120),(255,170,128),-1);v.write(f)\nv.release()",
    join(workspace, 'media-fixture.webm')], { windowsHide: true, timeout: 20000, stdio: 'pipe' });

  await harness.evaluate(`(()=>{const toggle=[...document.querySelectorAll('button')].find(e=>/打开右侧|展开右侧|Expand right/i.test(e.getAttribute('aria-label')||''));if(toggle)toggle.click();})()`);
  await until(() => harness.evaluate('Boolean(document.querySelector("[data-sidebar-right-guide]"))'), 'sidebar start page');
  assert.equal(await harness.evaluate('Boolean(document.querySelector("[data-sidebar-right-guide-entry=terminal]"))||[...document.querySelectorAll("[data-sidebar-right-guide] button")].some(e=>e.textContent.includes("新建终端"))'), false, 'Terminal start card is removed');
  const cardSpacing = await harness.evaluate(`(()=>{
    const guide=document.querySelector('[data-sidebar-right-guide]');
    const cards=[...guide.querySelectorAll('button')]
      .filter(e=>e.getBoundingClientRect().height>40).map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,text:e.textContent};});
    return {count:cards.length,labels:cards.map(r=>r.text),gaps:cards.slice(1).map((r,i)=>r.top-cards[i].bottom)};
  })()`);
  for (const label of ['文件', '任务管理', '侧边对话']) assert.ok(cardSpacing.labels.some(text=>text.includes(label)), `Start page retains ${label}`);
  assert.ok(cardSpacing.gaps.every(gap => Math.abs(gap - 14) < 1), `Guide cards must keep the native 14px gap: ${JSON.stringify(cardSpacing)}`);
  async function showFiles() {
    await until(() => harness.evaluate(`(()=>{const item=document.querySelector('[data-sidebar-right-guide-entry="editor"]')||[...document.querySelectorAll('button,[role=tab]')].find(e=>e.textContent.trim()==='文件');if(item){item.click();return true;}return false;})()`), 'sidebar files entry');
  }
  async function open(name) {
    await showFiles();
    await until(() => harness.evaluate(`(()=>{const row=[...document.querySelectorAll('[role=button][title]')].find(e=>e.getAttribute('title').endsWith(${JSON.stringify(name)}));if(row){row.click();return true;}return false;})()`), `file tree ${name}`);
  }
  async function checkPlayer(tag, seek) {
    const element = tag === 'audio' ? 'window.__rufaMediaAudio' : "document.querySelector('video')";
    await until(() => harness.evaluate(`(()=>{const e=${element};return e&&e.readyState>=1&&!e.error;})()`), `${tag} metadata`).catch(async error => {
      error.message += ' ' + JSON.stringify(await harness.evaluate(`(()=>{const e=${element};return e?{src:e.src,state:e.readyState,error:e.error?.message,network:e.networkState}:null;})()`)); throw error;
    });
    const source = await harness.evaluate(`${element}.src`);
    assert.match(source, tag === 'video' ? /\/video\?/ : /\/audio-preview\/media\?/);
    const ranges = await harness.evaluate(`(async()=>{const url=${JSON.stringify(source)};const a=await fetch(url,{headers:{Range:'bytes=0-31'}});const b=await fetch(url,{headers:{Range:'bytes=-16'}});return {status:a.status,length:(await a.arrayBuffer()).byteLength,range:a.headers.get('content-range'),suffixStatus:b.status,suffixLength:(await b.arrayBuffer()).byteLength};})()`);
    assert.equal(ranges.status, 206); assert.equal(ranges.length, 32); assert.match(ranges.range, /^bytes 0-31\//);
    assert.equal(ranges.suffixStatus, 206); assert.equal(ranges.suffixLength, 16);
    const playback = await harness.call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, userGesture: true,
      expression: `(async()=>{const e=${element};e.muted=true;${tag === 'audio' ? "document.querySelector('button[aria-label=播放]').click();" : 'await e.play();'}})()` });
    assert.equal(playback.exceptionDetails, undefined, `${tag} playback action failed`);
    await until(() => harness.evaluate(`${element}.currentTime>0.1`), `${tag} playing`);
    await harness.evaluate(`(()=>{const e=${element};e.pause();e.currentTime=${seek};})()`);
    await until(() => harness.evaluate(`(()=>{const e=${element};return !e.seeking&&Math.abs(e.currentTime-${seek})<0.2;})()`), `${tag} seek`);
    const screenshot = await harness.call('Page.captureScreenshot', { format: 'png', fromSurface: false }).catch(() => null);
    if (screenshot) await writeFile(join(artifacts, `media-${tag}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await open('media-fixture.webm'); await checkPlayer('video', 1);
  // The audio plugin intentionally keeps its real HTMLAudioElement detached.
  // Observe construction without replacing playback or network implementations.
  await harness.evaluate('window.__rufaOriginalAudio=window.Audio;window.Audio=new Proxy(window.Audio,{construct(target,args){const value=Reflect.construct(target,args);window.__rufaMediaAudio=value;return value;}})');
  await open('media-fixture.wav'); await checkPlayer('audio', 1.5);
  assert.ok(await harness.evaluate('document.querySelectorAll("canvas").length>0'), 'Audio waveform or spectrum is rendered');
  await harness.evaluate('window.Audio=window.__rufaOriginalAudio;delete window.__rufaOriginalAudio;delete window.__rufaMediaAudio');
  await harness.evaluate(`(()=>{const toggle=[...document.querySelectorAll('button')].find(e=>/收起右侧|折叠右侧|Collapse right/i.test(e.getAttribute('aria-label')||''));if(toggle)toggle.click();})()`);
  await pause(200);
}
