import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { createDirectVideoController, createMediaPreviewReact, loadRufaAVPlayer, observeMediaVisibility, patchMediaPreviewClient, restoreMediaPreviewClient } from '../scripts/media-preview-client.mjs';

const legacy = JSON.parse(gunzipSync(await fs.readFile(new URL('./fixtures/media-preview-v3.json.gz', import.meta.url))));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Test timed out'); }
function fixture(options = {}) {
  const instances = [], requests = [], states = [];
  class Player {
    constructor(config) { this.config = config; this.events = new Map(); this.currentTime = 0n; this.calls = []; this.destroyed = false; this.suspended = !!options.suspended; this.selectedAudioId = -1; instances.push(this); }
    on(event, handler) { this.events.set(event, handler); }
    fire(event, value) { this.events.get(event)?.(value); }
    async load(url, config) { new URL(url); this.calls.push(['load', url, config]); if (options.load) await options.load(this); }
    getStreams() { return options.streams ?? (options.noVideo ? [{ mediaType: 'Audio' }] : [{ mediaType: 'Video', codecpar: 1234, codecparProxy: { codecType: 0 } }]); }
    getDuration() { return 75667n; }
    getSelectedAudioStreamId() { return this.selectedAudioId; }
    isSuspended() { return this.suspended; }
    async resume() { this.calls.push(['resume']); if (options.resume) await options.resume(this); else this.suspended = false; }
    async play() { this.calls.push(['play']); if (options.play) await options.play(this); this.selectedAudioId = options.noSelectedAudio ? -1 : (this.getStreams().find(stream => stream.mediaType === 'Audio' || stream.codecparProxy?.codecType === 1)?.id ?? -1); this.fire('playing'); }
    async pause() { this.calls.push(['pause']); this.fire('paused'); }
    async seek(ms) { this.calls.push(['seek', ms]); this.currentTime = ms; this.fire('time', ms); }
    setVolume(value) { this.calls.push(['volume', value]); }
    setPlaybackRate(value) { this.calls.push(['rate', value]); }
    resize(w, h) { this.calls.push(['resize', w, h]); }
    async destroy() { this.destroyed = true; this.calls.push(['destroy']); if (options.destroy) await options.destroy(this); }
  }
  const native = { pauses: 0, loads: 0, pause() { this.pauses++; }, load() { this.loads++; }, async play() {} };
  const controller = createDirectVideoController({
    sourceUrl: options.sourceUrl ?? '/video?sessionId=one&path=clip.mp4', sourcePath: 'clip.mp4', origin: options.origin ?? 'http://localhost',
    container: { getBoundingClientRect: () => ({ width: 640, height: 360 }) }, nativeElement: native,
    onChange: state => states.push({ ...state }),
    loadPlayer: options.loadPlayer ?? (async () => Player),
    fetchImpl: async (url, config) => { requests.push([url, config]); return options.fetch ? await options.fetch(url, config) : new Response(null, { status: 200 }); },
  });
  return { controller, Player, instances, requests, states, native };
}
test('native-supported video stays native without loading player, fetching, or rewriting the source', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  f.controller.nativeMetadata({ readyState: 0, videoWidth: 0 });
  f.controller.nativeMetadata({ readyState: 4, videoWidth: 1920 });
  assert.equal(f.controller.getState().mode, 'native'); assert.equal(f.requests.length, 0); assert.equal(f.instances.length, 0);
});
test('MPEG4 with only a decoded audio track selects direct player, loads original URL, and keeps seconds/bigint-ms correct', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  f.controller.nativeMetadata({ readyState: 4, videoWidth: 0 });
  await until(() => f.controller.getState().phase === 'ready');
  const player = f.instances[0]; assert.equal(player.calls[0][0], 'load');
  assert.equal(player.calls[0][1], 'http://localhost/video?sessionId=one&path=clip.mp4');
  assert.equal(player.calls[0][2].ext, 'mp4'); assert.equal(player.calls[0][2].http.credentials, 'same-origin');
  assert.equal(player.config.wasmBaseUrl, 'http://localhost/rufa-media-player/wasm'); assert.equal(player.config.checkUseMSE(), false);
  assert.equal(f.controller.getState().duration, 75.667);
  await f.controller.seek(12.5); assert(!player.calls.some(call => call[0] === 'seek'));
  await f.controller.play(); assert.deepEqual(player.calls.find(call => call[0] === 'seek'), ['seek', 12500n]);
  await f.controller.seek(31.25); assert.equal(f.controller.getState().time, 31.25);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0][1].method, 'HEAD');
});
test('NotSupportedError code9 selects direct decoding; autoplay rejection does not', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.nativeError(new DOMException('gesture', 'NotAllowedError'));
  assert.equal(f.requests.length, 0); assert.match(f.controller.getState().message, /点击播放/);
  await f.controller.nativeError(new DOMException('codec', 'NotSupportedError'));
  assert.equal(f.instances.length, 1); assert.equal(f.controller.getState().phase, 'ready');
});
test('401/403/404 and network failure remain errors and never instantiate a decoder', async t => {
  for (const status of [401, 403, 404]) {
    const f = fixture({ fetch: async () => new Response(null, { status }) }); t.after(() => f.controller.dispose());
    await f.controller.nativeError({ code: 4 }); assert.equal(f.controller.getState().phase, 'failed'); assert.equal(f.instances.length, 0);
  }
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.nativeError({ code: 2 }); assert.equal(f.instances.length, 0); assert.match(f.controller.getState().message, /加载中断/);
  await f.controller.retry(); assert.equal(f.native.loads, 1); assert.equal(f.controller.getState().phase, 'idle');
});
test('pause, volume, mute, speed, resize controls reach one player', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.nativeError({ code: 4 }); await f.controller.play(); await f.controller.pause();
  assert.equal(f.controller.getState().playing, false);
  f.controller.volume(0.4); f.controller.mute(); f.controller.mute(); f.controller.rate(1.5); f.controller.rate(4); f.controller.resize();
  assert.equal(f.controller.getState().volume, 0.4); assert.equal(f.controller.getState().muted, false); assert.equal(f.controller.getState().rate, 1.5);
  assert(f.instances[0].calls.some(call => call[0] === 'resize' && call[1] === 640 && call[2] === 360));
});
test('hiding a paused preview keeps its rendered surface and returns without playback or an unchanged resize', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.nativeError({ code: 4 }); await f.controller.play(); await f.controller.seek(19);
  await f.controller.pause();
  const player = f.instances[0], calls = player.calls.filter(c => c[0] === 'play' || c[0] === 'resize').length;
  f.controller.setVisible(false); await tick(); assert.equal(player.destroyed, false);
  assert.equal(f.controller.getState().phase, 'suspended'); assert.equal(f.controller.getState().time, 19);
  f.controller.setVisible(true); await tick(); assert.equal(f.instances.length, 1);
  assert.equal(f.controller.getState().phase, 'ready'); assert.equal(f.controller.getState().playing, false);
  assert.equal(player.calls.filter(c => c[0] === 'play' || c[0] === 'resize').length, calls);
  await f.controller.play(); assert.equal(f.instances.length, 1); assert.equal(f.controller.getState().time, 19);
  await f.controller.dispose(); assert.equal(player.calls.filter(c => c[0] === 'destroy').length, 1);
});
test('late script resolution after disposal never allocates a player or changes UI', async () => {
  let resolve;
  const f = fixture({ loadPlayer: () => new Promise(done => { resolve = done; }) });
  const pending = f.controller.nativeError({ code: 4 }); await until(() => resolve);
  const disposed = f.controller.dispose(); const length = f.states.length; resolve(f.Player);
  await Promise.all([pending, disposed]); assert.equal(f.instances.length, 0); assert.equal(f.states.length, length);
});
test('late media load after disposal destroys the allocated player once and cannot publish ready', async () => {
  let release; const f = fixture({ load: () => new Promise(done => { release = done; }), destroy: () => { release?.(); } });
  const pending = f.controller.nativeError({ code: 4 }); await until(() => release);
  await f.controller.dispose(); await pending;
  assert.equal(f.instances[0].calls.filter(call => call[0] === 'destroy').length, 1);
  assert(!f.states.some(state => state.phase === 'ready'));
});
test('corrupt/no-video media fails explicitly, has no auto-retry loop, and allows an explicit retry', async t => {
  const f = fixture({ noVideo: true }); t.after(() => f.controller.dispose());
  await f.controller.nativeError({ code: 4 }); assert.equal(f.controller.getState().phase, 'failed'); await tick();
  assert.equal(f.instances.length, 1); assert(f.instances[0].destroyed);
  await f.controller.nativeError({ code: 4 }); assert.equal(f.instances.length, 1);
  await f.controller.retry(); assert.equal(f.instances.length, 2); assert.equal(f.controller.getState().phase, 'failed');
});
test('simultaneous play clicks cannot call AVPlayer.play twice', async t => {
  let release; const f = fixture({ play: () => new Promise(done => { release = done; }) }); t.after(() => f.controller.dispose());
  await f.controller.nativeError({ code: 4 });
  const first = f.controller.play(); await until(() => release); await f.controller.play();
  assert.equal(f.instances[0].calls.filter(call => call[0] === 'play').length, 1);
  release(); await first; assert.equal(f.controller.getState().phase, 'ready');
});
test('an unselected audio track is warned only after play and the warning persists through controls', async t => {
  const streams = [{ id: 1, mediaType: 'Video' }, { id: 0, mediaType: 'Audio', codecparProxy: { codecType: 1, codecId: 86016 } }];
  const f = fixture({ streams, noSelectedAudio: true }); t.after(() => f.controller.dispose());
  await f.controller.nativeError({ code: 4 });
  assert.equal(f.controller.getState().audioWarning, '');
  await f.controller.play(); assert.match(f.controller.getState().audioWarning, /音轨暂不支持.*仅播放画面/);
  await f.controller.seek(5); await f.controller.pause(); await f.controller.play(); f.instances[0].fire('played');
  assert.match(f.controller.getState().audioWarning, /音轨暂不支持/);
  const supported = fixture({ streams }); t.after(() => supported.controller.dispose());
  await supported.controller.nativeError({ code: 4 }); await supported.controller.play();
  assert.equal(supported.instances[0].getSelectedAudioStreamId(), 0); assert.equal(supported.controller.getState().audioWarning, '');
});
test('play resumes suspended audio synchronously in the click and preserves a blocked-resume prompt', async t => {
  const streams = [{ id: 1, mediaType: 'Video' }, { id: 0, mediaType: 'Audio' }];
  const f = fixture({ streams }); t.after(() => f.controller.dispose());
  await f.controller.nativeError({ code: 4 }); await f.controller.play();
  const player = f.instances[0]; player.suspended = true; player.fire('resume');
  assert.equal(f.controller.getState().audioResumeNeeded, true);
  const pending = f.controller.play();
  assert.equal(player.calls.at(-1)[0], 'resume'); assert.equal(player.suspended, false);
  await pending; assert.equal(f.controller.getState().audioResumeNeeded, false);
  const blocked = fixture({ streams, suspended: true, resume() {} }); t.after(() => blocked.controller.dispose());
  await blocked.controller.nativeError({ code: 4 }); await blocked.controller.play(); blocked.instances[0].fire('played');
  assert.equal(blocked.controller.getState().audioResumeNeeded, true); assert.equal(blocked.controller.getState().audioWarning, '');
  globals(t, { videoUrl: () => '/video?sessionId=one', downloadUrl: () => '/video?sessionId=one&download=1' });
  const actions = [];
  function renderButtons(playing, audioResumeNeeded) {
    let ref = 0;
    const React = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useRef: () => ({ current: ++ref === 4 ? { play: () => actions.push('play'), pause: () => actions.push('pause') } : null }),
      useEffect() {},
      useState: initial => [typeof initial === 'object' ? { ...blocked.controller.getState(), playing, audioResumeNeeded } : initial, () => {}],
    };
    const tree = createMediaPreviewReact(React).VideoView({ scope: {}, path: 'clip.mp4', title: 'clip.mp4' });
    const buttons = [];
    function visit(node) { if (!node || typeof node !== 'object') return; if (node.type === 'button') buttons.push(node); for (const child of node.children ?? []) visit(child); }
    visit(tree); return buttons;
  }
  const playingButtons = renderButtons(true, true);
  const pauseButton = playingButtons.find(button => button.props['aria-label'] === '暂停');
  const resumeButton = playingButtons.find(button => button.children[0] === '恢复声音');
  assert(pauseButton && resumeButton); assert.equal(pauseButton.props.disabled, false);
  pauseButton.props.onClick(); resumeButton.props.onClick(); assert.deepEqual(actions, ['pause', 'play']);
  const pausedButtons = renderButtons(false, true);
  assert(pausedButtons.some(button => button.props['aria-label'] === '播放')); assert(pausedButtons.some(button => button.children[0] === '恢复声音'));
  assert(!renderButtons(true, false).some(button => button.children[0] === '恢复声音'));
});
test('audio resume completion after hiding cannot start the retired player', async t => {
  let release;
  const f = fixture({ suspended: true, resume: () => new Promise(resolve => { release = resolve; }) }); t.after(() => f.controller.dispose());
  await f.controller.nativeError({ code: 4 }); const pending = f.controller.play(); assert.equal(typeof release, 'function');
  f.controller.setVisible(false); release(); await pending; await until(() => f.instances[0].destroyed);
  assert(!f.instances[0].calls.some(call => call[0] === 'play')); assert.equal(f.controller.getState().phase, 'suspended');
});
test('direct controller rejects foreign URLs and arbitrary same-origin endpoints', () => {
  for (const sourceUrl of ['https://evil.example/video', '//evil.example/video', 'http://localhost:9000/video', 'https://localhost/video', '/sidebar/file?path=secret', 'file:///C:/secret']) {
    assert.throws(() => createDirectVideoController({ sourceUrl, origin: 'http://localhost', onChange() {} }), /无效/);
  }
});
test('blob workers receive absolute same-origin media and wasm URLs with preserved query and port', async t => {
  for (const origin of ['http://127.0.0.1:49152', 'https://localhost:9443']) {
    const sourceUrl = '/video?sessionId=one&path=%E8%A7%86%E9%A2%91%20clip.mp4';
    const f = fixture({ origin, sourceUrl, streams: [{ mediaType: 'Video' }] });
    t.after(() => f.controller.dispose());
    await f.controller.nativeError({ code: 4 });
    assert.equal(f.controller.getState().phase, 'ready');
    const player = f.instances[0], media = new URL(player.calls[0][1]), wasm = new URL(player.config.wasmBaseUrl);
    assert.equal(media.href, origin + sourceUrl); assert.equal(media.origin, origin);
    assert.equal(wasm.href, origin + '/rufa-media-player/wasm');
    assert.equal(f.requests[0][0], sourceUrl);
  }
});
function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
}
test('script loading is shared, same-origin only, and retries a failed asset request', async t => {
  const scripts = []; const win = {};
  globals(t, { window: win, document: { createElement: () => ({ remove() {} }), head: { appendChild: script => scripts.push(script) } } });
  const first = loadRufaAVPlayer(); const second = loadRufaAVPlayer(); assert.equal(first, second);
  assert.equal(scripts[0].src, '/rufa-media-player/avplayer.js');
  const failure = assert.rejects(first, /本机播放器/); scripts[0].onerror(); await failure;
  const third = loadRufaAVPlayer(); assert.equal(scripts.length, 2);
  win.AVPlayer = class Player {}; scripts[1].onload(); assert.equal(await third, win.AVPlayer);
});
test('visibility observer follows hidden sidebar ancestors and document hiding and removes listeners', t => {
  const callbacks = {}, observers = [];
  class Observer { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const doc = { visibilityState: 'visible', addEventListener: (k, fn) => { callbacks[k] = fn; }, removeEventListener: k => { delete callbacks[k]; } };
  globals(t, { document: doc, window: { addEventListener: (k, fn) => { callbacks[k] = fn; }, removeEventListener: k => { delete callbacks[k]; } }, ResizeObserver: Observer, MutationObserver: Observer, getComputedStyle: node => node.style });
  const parent = { style: { display: 'block', visibility: 'visible' }, parentElement: null };
  const element = { isConnected: true, style: parent.style, parentElement: parent, getBoundingClientRect: () => ({ width: 10, height: 10 }) };
  const seen = []; const stop = observeMediaVisibility(element, value => seen.push(value));
  parent.style = { display: 'none', visibility: 'visible' }; observers[1].callback();
  parent.style.display = 'block'; observers[1].callback();
  doc.visibilityState = 'hidden'; callbacks.visibilitychange(); stop();
  assert.deepEqual(seen, [true, false, true, false]); assert(observers.every(observer => observer.disconnected)); assert.equal(Object.keys(callbacks).length, 0);
});
function hookHarness(fn) {
  const slots = []; let index = 0; const pending = [];
  const React = {
    createElement: () => {},
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = index++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) {
      const i = index++; const prior = slots[i];
      if (!prior || deps.some((value, j) => value !== prior.deps[j])) pending.push(() => { prior?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
    },
    useCallback(callback) { return callback; },
  };
  const hook = fn(React);
  return { render(...args) { index = 0; const result = hook(...args); for (const effect of pending.splice(0)) effect(); return result; }, dispose() { for (const slot of slots) slot?.cleanup?.(); } };
}
test('unsupported native audio remains an explicit retryable error without requesting decoder assets or conversions', async t => {
  const requests = []; globals(t, { fetch: async (url, options) => { requests.push([url, options]); return new Response(null, { status: 200 }); } });
  const harness = hookHarness(React => createMediaPreviewReact(React).useNativeAudio); t.after(() => harness.dispose());
  let preview = harness.render('/audio-preview/media?sessionId=a&path=sound.wma');
  await preview.onError(new DOMException('unsupported', 'NotSupportedError'));
  preview = harness.render('/audio-preview/media?sessionId=a&path=sound.wma');
  assert.equal(preview.phase, 'failed'); assert.match(preview.message, /编码暂不支持/); assert.equal(requests.length, 1); assert.equal(requests[0][1].method, 'HEAD');
  preview.retry(); preview = harness.render('/audio-preview/media?sessionId=a&path=sound.wma');
  assert.equal(preview.phase, 'idle'); assert.equal(preview.retryKey, 1);
});
test('late audio failure from previous retry or previous file cannot overwrite current state', async t => {
  const resolvers = []; globals(t, { fetch: () => new Promise(resolve => resolvers.push(resolve)) });
  const harness = hookHarness(React => createMediaPreviewReact(React).useNativeAudio); t.after(() => harness.dispose());
  let preview = harness.render('/audio-preview/media?path=one.wma'); const pending = preview.onError({ code: 4 });
  preview.retry(); resolvers[0](new Response(null, { status: 403 })); await pending;
  assert.equal(harness.render('/audio-preview/media?path=one.wma').phase, 'idle');
  preview = harness.render('/audio-preview/media?path=one.wma'); const older = preview.onError({ code: 4 });
  harness.render('/audio-preview/media?path=two.mp3'); resolvers[1](new Response(null, { status: 404 })); await older;
  assert.equal(harness.render('/audio-preview/media?path=two.mp3').phase, 'idle');
});
test('native audio reports authorization failures clearly and ignores autoplay rejection', async t => {
  globals(t, { fetch: async () => new Response(null, { status: 401 }) });
  const harness = hookHarness(React => createMediaPreviewReact(React).useNativeAudio); t.after(() => harness.dispose());
  let preview = harness.render('/audio-preview/media?path=one.mp3');
  await preview.onError(new DOMException('gesture', 'NotAllowedError'));
  preview = harness.render('/audio-preview/media?path=one.mp3'); assert.equal(preview.phase, 'idle'); assert.match(preview.message, /点击播放/);
  await preview.onError({ code: 4 }); preview = harness.render('/audio-preview/media?path=one.mp3'); assert.match(preview.message, /登录已失效/);
});
test('exact shipped v3 bundles migrate, roundtrip original bytes, and direct patch replay is stable', () => {
  for (const kind of ['video', 'audio']) {
    const original = restoreMediaPreviewClient(legacy[kind], kind); const output = patchMediaPreviewClient(legacy[kind], kind);
    new Script(output); assert.equal(restoreMediaPreviewClient(output, kind), original); assert.equal(patchMediaPreviewClient(output, kind), output);
    assert(!output.includes('/preview/prepare')); assert(!output.includes('/preview/status')); assert(!output.includes('/preview/release')); assert(!output.includes('cdn.jsdelivr.net'));
    assert(output.includes('RUFA_MEDIA_DIRECT_CLIENT_V1'));
    if (kind === 'audio') for (const marker of ['createPlayer(sourceUrl)', 'computeSpectrogramWindow', 'abRange(selection)', 'preview.retryKey', 'observeMediaVisibility(containerRef.current']) assert(output.includes(marker));
    else for (const marker of ['播放进度', '播放速度', '全屏', '下载', 'data-rufa-video-mode']) assert(output.includes(marker));
    const sha = text => createHash('sha256').update(text).digest('hex');
    assert.equal(sha(restoreMediaPreviewClient(output, kind)), sha(original));
  }
});
test('migration rejects altered old body, altered new body, changed original and marker corruption', () => {
  for (const kind of ['video', 'audio']) {
    const output = patchMediaPreviewClient(legacy[kind], kind);
    assert.throws(() => restoreMediaPreviewClient(legacy[kind].replace('window.', 'globalThis.'), kind), /patched body checksum/);
    assert.throws(() => restoreMediaPreviewClient(output.replace('window.', 'globalThis.'), kind), /patched body checksum/);
    assert.throws(() => patchMediaPreviewClient(restoreMediaPreviewClient(output, kind) + '\n// drift', kind), /upstream checksum/);
    assert.throws(() => restoreMediaPreviewClient(output + 'bad', kind), /Invalid/);
    assert.throws(() => restoreMediaPreviewClient(output, kind === 'audio' ? 'video' : 'audio'), /original checksum/);
  }
});
