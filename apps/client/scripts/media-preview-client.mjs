import { createHash } from 'node:crypto';

// Self-contained browser helpers, embedded in the pinned plugin bundles.
export function loadRufaAVPlayer() {
  if (window.__rufaAVPlayer131) return window.__rufaAVPlayer131;
  const pending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/rufa-media-player/avplayer.js'; script.async = true;
    const timeout = setTimeout(() => finish(new Error('播放器组件加载超时，请重试。')), 20_000);
    function finish(error) {
      clearTimeout(timeout); script.onload = null; script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else {
        const Player = window.AVPlayer?.default ?? window.AVPlayer;
        if (typeof Player === 'function') resolve(Player);
        else reject(new Error('播放器组件不可用，请修复客户端。'));
      }
    }
    script.onload = () => finish();
    script.onerror = () => finish(new Error('无法加载本机播放器组件，请重试。'));
    document.head.appendChild(script);
  });
  window.__rufaAVPlayer131 = pending;
  void pending.catch(() => { if (window.__rufaAVPlayer131 === pending) delete window.__rufaAVPlayer131; });
  return pending;
}

export function observeMediaVisibility(element, onChange) {
  let last;
  const check = () => {
    let visible = document.visibilityState !== 'hidden' && !!element?.isConnected;
    if (visible) {
      const rect = element.getBoundingClientRect();
      visible = rect.width > 0 && rect.height > 0;
      for (let node = element; visible && node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') visible = false;
      }
    }
    if (last !== visible) { last = visible; onChange(visible); }
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(check) : null;
  for (let node = element; node; node = node.parentElement) mutations?.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
  if (element) resize?.observe(element);
  document.addEventListener('visibilitychange', check); window.addEventListener('resize', check);
  check();
  return () => { resize?.disconnect(); mutations?.disconnect(); document.removeEventListener('visibilitychange', check); window.removeEventListener('resize', check); };
}

export function createDirectVideoController({ sourceUrl, sourcePath, container, nativeElement, onChange,
  loadPlayer = loadRufaAVPlayer, fetchImpl = fetch, origin = location.origin }) {
  let disposed = false, visible = true, generation = 0, engine = null, head = null;
  let retiring = Promise.resolve(), starting = null, attempted = false, pendingSeek = null, seeking = false, playbackStarted = false, audioStreams = [], lastSize = '';
  let state = { mode: 'native', phase: 'idle', message: '', audioWarning: '', audioResumeNeeded: false, playing: false, time: 0, duration: 0, volume: 1, muted: false, rate: 1 };
  const url = new URL(sourceUrl, origin);
  if (url.origin !== origin || url.pathname !== '/video') throw new Error('无效的媒体地址。');
  const extension = String(sourcePath ?? '').match(/\.([a-z0-9]{1,10})$/i)?.[1].toLowerCase();
  function emit(value) { if (!disposed) { state = { ...state, ...value }; onChange(state); } }
  function time(value) { const number = Number(value) / 1000; return Number.isFinite(number) && number >= 0 ? number : 0; }
  function selectedAudio(player) { return audioStreams.some(stream => stream.id === player.getSelectedAudioStreamId()); }
  function needsAudioResume(player) { return selectedAudio(player) && player.isSuspended(); }
  function retire() {
    const previous = engine; engine = null; pendingSeek = null;
    if (previous) retiring = retiring.catch(() => {}).then(() => previous.destroy()).catch(() => {});
    return retiring;
  }
  function invalidate() { generation++; head?.abort(); head = null; return retire(); }
  function fail(message) { invalidate(); emit({ phase: 'failed', playing: false, audioResumeNeeded: false, message }); }
  function readError(status) {
    return status === 401 ? '登录已失效，请重新登录后打开文件。' : status === 403 ? '没有读取此文件的权限。'
      : status === 404 ? '文件已不存在，请重新选择文件。' : '无法读取文件，请检查连接后重试。';
  }
  async function readable(run) {
    const signal = (head = new AbortController()).signal;
    const response = await fetchImpl(sourceUrl, { method: 'HEAD', credentials: 'same-origin', signal });
    if (disposed || run !== generation) return false;
    if (!response.ok) throw new Error(readError(response.status));
    return true;
  }
  async function startDirect() {
    if (disposed) return false;
    if (starting) return starting;
    attempted = true;
    const task = (async () => {
      const cleanup = invalidate(); const run = generation;
      nativeElement?.pause();
      audioStreams = [];
      emit({ mode: 'direct', phase: visible ? 'loading' : 'suspended', playing: false, audioWarning: '', audioResumeNeeded: false,
        message: visible ? '正在打开视频…' : '已暂停，点击播放继续。' });
      if (!visible) return false;
      const resumeTime = state.time;
      try {
        await cleanup;
        if (disposed || run !== generation || !await readable(run)) return false;
        const Player = await loadPlayer();
        if (disposed || run !== generation || !visible) return false;
        const player = engine = new Player({ container, wasmBaseUrl: new URL('/rufa-media-player/wasm', origin).href,
          enableWorker: true, enableWebCodecs: true, enableHardware: true, enableWebGPU: false,
          checkUseMSE: () => false, preLoadTime: 4 });
        playbackStarted = false; lastSize = '';
        const current = () => !disposed && run === generation && engine === player;
        player.on('error', () => { if (current()) fail('无法播放此视频，文件可能损坏或编码暂不支持。'); });
        player.on('time', pts => { if (current()) emit({ time: time(pts) }); });
        player.on('playing', () => { if (current() && visible) emit({ playing: true, audioResumeNeeded: needsAudioResume(player), message: '' }); });
        player.on('played', () => { if (current() && visible) emit({ playing: true, audioResumeNeeded: needsAudioResume(player), message: '' }); });
        player.on('paused', () => { if (current()) emit({ playing: false }); });
        player.on('ended', () => { if (current()) emit({ playing: false, time: state.duration }); });
        player.on('resume', () => { if (current()) emit({ audioResumeNeeded: needsAudioResume(player) }); });
        await player.load(url.href, { ext: extension, http: { credentials: 'same-origin' }, isLive: false });
        if (!current()) return false;
        const streams = player.getStreams();
        if (!streams.some(stream => stream.mediaType === 'Video' || stream.codecparProxy?.codecType === 0)) throw new Error('NO_VIDEO');
        audioStreams = streams.filter(stream => stream.mediaType === 'Audio' || stream.codecparProxy?.codecType === 1);
        player.setVolume(state.muted ? 0 : state.volume); player.setPlaybackRate(state.rate);
        const duration = time(player.getDuration());
        pendingSeek = resumeTime > 0 ? Math.min(resumeTime, duration || resumeTime) : null;
        emit({ phase: 'ready', duration, hasAudio: audioStreams.length > 0, message: '' }); resize();
        return true;
      } catch (error) {
        if (!disposed && run === generation && error?.name !== 'AbortError') fail(/^(登录|没有读取|文件已不存在|无法读取)/.test(error?.message ?? '')
          ? error.message : '无法打开此视频，文件可能损坏或播放器暂不支持。');
        return false;
      }
    })();
    starting = task;
    try { return await task; } finally { if (starting === task) starting = null; }
  }
  async function nativeError(error) {
    if (disposed || error?.name === 'AbortError' || error?.code === 1) return;
    if (error?.name === 'NotAllowedError') { emit({ message: '请点击播放按钮开始播放。' }); return; }
    if (state.mode !== 'native' || attempted) return;
    const code = error?.name === 'NotSupportedError' ? 4 : Number(error?.currentTarget?.error?.code ?? error?.target?.error?.code ?? error?.code ?? 2);
    if (code === 3 || code === 4) { await startDirect(); return; }
    attempted = true; const run = generation;
    try { if (await readable(run)) fail('媒体加载中断，请重试播放。'); }
    catch (error) { if (!disposed && run === generation && error?.name !== 'AbortError') fail(error.message); }
  }
  function nativeMetadata(element) {
    if (state.mode === 'native' && element?.readyState >= 1 && element.videoWidth === 0) void nativeError({ code: 4 });
  }
  async function play() {
    if (disposed || !visible || state.phase === 'starting') return;
    if (state.mode === 'native') { try { await nativeElement?.play(); } catch (error) { await nativeError(error); } return; }
    if (!engine || state.phase !== 'ready') { if (!await startDirect()) return; }
    const player = engine; const run = generation;
    try {
      emit({ phase: 'starting' });
      // For an already loaded player, invoke resume in the click before awaiting playback.
      if (player.isSuspended()) await player.resume();
      if (disposed || run !== generation || engine !== player || !visible) return;
      await player.play();
      if (disposed || run !== generation || engine !== player) return;
      playbackStarted = true;
      if (!visible) { await player.pause(); return; }
      const audioWarning = audioStreams.length && !selectedAudio(player) ? '此视频的音轨暂不支持，当前仅播放画面。' : '';
      if (pendingSeek !== null) { const target = pendingSeek; pendingSeek = null; await player.seek(BigInt(Math.round(target * 1000))); }
      if (disposed || run !== generation || engine !== player) return;
      emit({ phase: 'ready', playing: true, audioWarning, audioResumeNeeded: needsAudioResume(player), message: '' });
    } catch (error) {
      if (!disposed && run === generation) {
        if (error?.name === 'NotAllowedError') emit({ phase: 'ready', playing: false, message: '请点击播放按钮开始播放。' });
        else fail('视频播放失败，请重试。');
      }
    }
  }
  async function pause() { try { nativeElement?.pause(); await engine?.pause(); } catch {} emit({ playing: false }); }
  async function seek(seconds) {
    if (!engine || !Number.isFinite(seconds) || disposed) return;
    pendingSeek = Math.max(0, Math.min(state.duration || seconds, seconds)); emit({ time: pendingSeek });
    if (!playbackStarted) return;
    if (seeking) return;
    seeking = true; const player = engine; const run = generation;
    try {
      while (pendingSeek !== null && engine === player && run === generation) {
        const target = pendingSeek; pendingSeek = null;
        await player.seek(BigInt(Math.round(target * 1000)));
      }
    } catch { if (!disposed && run === generation) emit({ message: '无法跳转到此位置，请重试。' }); }
    finally { seeking = false; }
  }
  function volume(value) {
    if (!Number.isFinite(value)) return;
    value = Math.max(0, Math.min(1, value)); emit({ volume: value, muted: value === 0 }); engine?.setVolume(value);
  }
  function mute() { const muted = !state.muted; const volume = state.volume || 1; emit({ muted, volume }); engine?.setVolume(muted ? 0 : volume); }
  function rate(value) { if (![0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(value)) return; emit({ rate: value }); engine?.setPlaybackRate(value); }
  function resize() {
    if (!engine || !visible) return;
    const rect = container.getBoundingClientRect();
    const width = Math.round(rect.width), height = Math.round(rect.height), size = width + 'x' + height;
    // Resetting an unchanged canvas on focus/visibility clears its paused frame.
    if (width > 0 && height > 0 && lastSize !== size) { lastSize = size; engine.resize(width, height); }
  }
  function setVisible(value) {
    if (disposed || visible === value) return;
    visible = value;
    if (!value) {
      nativeElement?.pause();
      if (state.mode === 'direct') {
        const current = engine && playbackStarted ? time(engine.currentTime) : state.time;
        // Keep the paused render surface while this preview is mounted. Merely
        // changing windows must not destroy the last frame or restart playback.
        if (engine && playbackStarted) void engine.pause().catch(() => {});
        else invalidate();
        emit({ phase: 'suspended', playing: false, audioResumeNeeded: false, time: current, message: '' });
      }
    } else {
      if (state.mode === 'direct' && engine && playbackStarted) emit({ phase: 'ready', playing: false, message: '' });
      resize();
    }
  }
  async function retry() {
    if (disposed) return;
    if (state.mode === 'direct') { await startDirect(); return; }
    await invalidate(); attempted = false; emit({ phase: 'idle', message: '' }); nativeElement?.load();
  }
  async function dispose() {
    if (disposed) return; disposed = true; nativeElement?.pause();
    await invalidate(); await starting?.catch(() => {}); await retire();
  }
  return { nativeError, nativeMetadata, play, pause, seek, volume, mute, rate, resize, setVisible, retry, dispose, getState: () => state };
}

export function createMediaPreviewReact(React) {
  const h = React.createElement;
  function VideoView(props) {
    const sourceUrl = videoUrl(props.scope, props.path);
    const nativeRef = React.useRef(null), canvasRef = React.useRef(null), rootRef = React.useRef(null), control = React.useRef(null);
    const [state, setState] = React.useState({ mode: 'native', phase: 'idle', message: '', playing: false, time: 0, duration: 0, volume: 1, muted: false, rate: 1 });
    const surfaceRef = React.useRef(null), hideTimer = React.useRef(null), menuButton = React.useRef(null);
    const [awake, setAwake] = React.useState(true), [menu, setMenu] = React.useState(''), [full, setFull] = React.useState(false);
    const reveal = () => {
      setAwake(true); clearTimeout(hideTimer.current);
      if (state.playing) hideTimer.current = setTimeout(() => setAwake(false), 2500);
    };
    React.useEffect(() => { reveal(); return () => clearTimeout(hideTimer.current); }, [state.playing]);
    React.useEffect(() => {
      const changed = () => setFull(document.fullscreenElement === surfaceRef.current);
      document.addEventListener('fullscreenchange', changed);
      return () => document.removeEventListener('fullscreenchange', changed);
    }, []);
    React.useEffect(() => {
      if (!menu) return;
      const outside = event => { if (!surfaceRef.current?.contains(event.target)) setMenu(''); };
      const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(''); menuButton.current?.focus(); } };
      document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
      return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
    }, [menu]);
    React.useEffect(() => {
      const value = createDirectVideoController({ sourceUrl, sourcePath: props.path, container: canvasRef.current, nativeElement: nativeRef.current, onChange: setState });
      control.current = value; setState(value.getState());
      const unobserve = observeMediaVisibility(rootRef.current, visible => value.setVisible(visible));
      const resize = new ResizeObserver(() => value.resize()); resize.observe(canvasRef.current);
      return () => { unobserve(); resize.disconnect(); void value.dispose(); if (control.current === value) control.current = null; };
    }, [sourceUrl, props.path]);
    const formatTime = value => { const s = Math.floor(Math.max(0, Number(value) || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const direct = state.mode === 'direct';
    const statusMessage = [state.message, state.audioWarning].filter(Boolean).join(' ');
    const paths = {
      play: 'M8 5v14l11-7z', pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
      volume: 'M3 9v6h4l5 4V5L7 9H3zm11-1.5v9a5 5 0 0 0 0-9zm0-4v2.1a7 7 0 0 1 0 12.8v2.1a9 9 0 0 0 0-17z',
      mute: 'M3 9v6h4l5 4V5L7 9H3zm12-1 3 3 3-3 1.4 1.4-3 3 3 3L21 16.8l-3-3-3 3-1.4-1.4 3-3-3-3z',
      full: 'M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z',
      exit: 'M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-14h-2v5h5V8h-3z',
      more: 'M12 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
      download: 'M11 3h2v9l3-3 1.4 1.4L12 16l-5.4-5.6L8 9l3 3zM5 17h14v4H5z',
      speed: 'M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7zm5 0 4 4-9 6-1-1z',
      back: 'm14 6-6 6 6 6 1.4-1.4-4.6-4.6 4.6-4.6z', check: 'm9 16-4-4-1.4 1.4L9 19 21 7l-1.4-1.4z',
    };
    const icon = name => h('svg', { viewBox: '0 0 24 24', width: 24, height: 24, 'aria-hidden': true, focusable: false }, h('path', { d: paths[name], fill: 'currentColor' }));
    const button = (label, name, action, extra = {}) => h('button', { type: 'button', className: 'rufa-media-icon', 'aria-label': label, title: label, onClick: action, ...extra }, icon(name));
    const toggle = () => { reveal(); void (state.playing ? control.current?.pause() : control.current?.play()); };
    const fullscreen = async () => {
      try { if (document.fullscreenElement === surfaceRef.current) await document.exitFullscreen(); else await surfaceRef.current.requestFullscreen(); }
      catch { setState(previous => ({ ...previous, message: '当前无法进入全屏。' })); }
    };
    const keyboard = event => {
      if (!direct || event.target.closest('button,input,a,[role=menu]')) return;
      const actions = { ' ': toggle, k: toggle, ArrowLeft: () => control.current?.seek(state.time - 5), ArrowRight: () => control.current?.seek(state.time + 5),
        ArrowUp: () => control.current?.volume(state.volume + 0.05), ArrowDown: () => control.current?.volume(state.volume - 0.05), m: () => control.current?.mute(), f: fullscreen };
      if (actions[event.key]) { event.preventDefault(); reveal(); void actions[event.key](); }
    };
    const hidden = state.playing && !awake && !menu;
    const progress = Math.max(0, Math.min(100, state.duration ? state.time / state.duration * 100 : 0));
    const busy = state.phase === 'loading' || state.phase === 'starting';
    return h('div', { ref: rootRef, 'data-rufa-video-mode': state.mode, 'data-rufa-video-state': state.phase,
      style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', minWidth: 0, minHeight: 0, height: '100%', boxSizing: 'border-box' } },
    h('style', null, `
      .rufa-media-surface{flex:1 1 auto;min-height:0;position:relative;background:#000;border-radius:6px;overflow:hidden;outline:none;container-type:inline-size}
      .rufa-media-surface:fullscreen{width:100%;height:100%;border-radius:0}
      .rufa-media-surface[data-controls-hidden=true]{cursor:none}
      .rufa-media-controls{position:absolute;inset:auto 0 0;height:112px;display:flex;flex-direction:column;justify-content:flex-end;color:#fff;background:linear-gradient(0deg,#000,rgba(0,0,0,.75) 30%,transparent);font:14px Arial,sans-serif;opacity:1;transition:opacity .25s;z-index:2;pointer-events:none}
      .rufa-media-surface[data-controls-hidden=true] .rufa-media-controls:not(:has(:focus-visible)){opacity:0;pointer-events:none}
      .rufa-media-surface[data-controls-hidden=true] .rufa-media-controls:not(:has(:focus-visible)) *{pointer-events:none}
      .rufa-media-row{display:flex;align-items:center;height:48px;min-height:48px;padding:0;pointer-events:auto}
      .rufa-media-controls .rufa-media-icon{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;min-width:48px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:#fff;cursor:pointer;box-shadow:none;opacity:.9}
      .rufa-media-icon svg{width:20px;height:20px;pointer-events:none}
      .rufa-media-controls .rufa-media-icon:hover{background:radial-gradient(circle,rgba(50,50,50,.7) 0 52%,transparent 54%)}
      .rufa-media-icon:focus-visible,.rufa-media-menu :focus-visible{outline:2px solid #fff;outline-offset:-5px}
      .rufa-media-icon:disabled{opacity:.35;cursor:default}
      .rufa-media-time{white-space:nowrap;line-height:48px;font:14px Arial,sans-serif;font-variant-numeric:tabular-nums}
      .rufa-media-volume{display:flex;align-items:center;flex-direction:row-reverse}
      .rufa-media-volume-slider{width:0;overflow:hidden;opacity:0;transition:width .2s,opacity .2s}
      .rufa-media-volume:has(button:enabled):hover .rufa-media-volume-slider,.rufa-media-volume:focus-within .rufa-media-volume-slider{width:60px;opacity:1}
      .rufa-media-controls input[type=range]{appearance:none;display:block;margin:0;padding:0;border:0;border-radius:0;box-shadow:none;outline:none;height:24px;min-height:0;background:transparent;cursor:pointer;pointer-events:auto;accent-color:white}
      .rufa-media-controls input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(to right,#fff var(--fill),rgba(255,255,255,.3) var(--fill))}
      .rufa-media-controls input[type=range]::-webkit-slider-thumb{appearance:none;width:12px;height:12px;margin-top:-4px;border:0;border-radius:50%;background:white;opacity:0;transition:opacity .2s}
      .rufa-media-controls input[type=range]:hover::-webkit-slider-thumb,.rufa-media-controls input[type=range]:focus::-webkit-slider-thumb{opacity:1}
      .rufa-media-timeline{padding:0 16px}
      .rufa-media-timeline input{width:100%}
      .rufa-media-timeline input::-webkit-slider-runnable-track{transform:translateY(-10px)}
      .rufa-media-menu{position:absolute;right:10px;bottom:72px;min-width:236px;max-height:calc(100% - 80px);overflow:auto;background:#fff;color:#202124;border-radius:2px;box-shadow:0 8px 16px #0005;padding:8px 0;z-index:4;font:14px Arial,sans-serif;color-scheme:light}
      .rufa-media-menu button,.rufa-media-menu a{appearance:none;width:100%;display:flex;align-items:center;gap:16px;min-height:48px;margin:0;padding:0 24px;border:0;border-radius:0;background:none;color:inherit;text-decoration:none;font:inherit;text-align:left;cursor:pointer;box-sizing:border-box}
      .rufa-media-menu button:hover,.rufa-media-menu a:hover{background:#eee}
      .rufa-media-menu .rufa-media-selected{background:#f1f3f4}
      .rufa-media-notice{position:absolute;left:16px;right:16px;bottom:90px;color:#fff;background:#202124e8;padding:10px 12px;border-radius:4px;font:13px/1.5 Arial,sans-serif;z-index:3}
      .rufa-media-notice button{border:0;background:transparent;color:#a8c7fa;padding:0 8px;cursor:pointer;font:inherit}
      @container(min-width:1441px){.rufa-media-controls{height:222px}.rufa-media-row{height:64px;min-height:64px;padding:0 16px}.rufa-media-controls .rufa-media-icon{width:64px;height:64px;min-width:64px}.rufa-media-icon svg{width:32px;height:32px}.rufa-media-timeline{padding:0 32px}.rufa-media-time{line-height:64px}.rufa-media-menu{bottom:88px;right:18px}.rufa-media-notice{bottom:106px}}
      @container(max-width:300px){.rufa-media-time{font-size:12px}.rufa-media-controls .rufa-media-icon{width:36px;min-width:36px}.rufa-media-volume-slider{display:none}.rufa-media-menu{min-width:200px}}
      @media(prefers-reduced-motion:reduce){.rufa-media-controls,.rufa-media-volume-slider{transition:none}}
    `),
    h('div', { ref: surfaceRef, className: 'rufa-media-surface', 'data-controls-hidden': direct && hidden, tabIndex: direct ? 0 : undefined,
      'aria-label': '视频播放器', onPointerMove: reveal, onPointerDown: reveal, onFocus: reveal, onKeyDown: keyboard,
      onClick: event => { if (direct && !event.target.closest('button,input,a,[role=menu],[data-rufa-avplayer=controls]')) { setMenu(''); toggle(); } },
      onDoubleClick: event => { if (direct && !event.target.closest('button,input,a')) void fullscreen(); } },
      h('video', { ref: nativeRef, src: direct ? undefined : sourceUrl, controls: true, preload: 'metadata', playsInline: true,
        onError: event => { void control.current?.nativeError(event); }, onLoadedMetadata: event => control.current?.nativeMetadata(event.currentTarget),
        style: { display: direct ? 'none' : 'block', width: '100%', height: '100%', objectFit: 'contain' } }),
      h('div', { ref: canvasRef, 'data-rufa-avplayer': 'container', style: { display: direct ? 'block' : 'none', position: 'absolute', inset: 0, width: '100%', height: '100%' } }),
    direct ? h('div', { className: 'rufa-media-controls', 'data-rufa-avplayer': 'controls' },
      h('div', { className: 'rufa-media-row' },
        button(state.playing ? '暂停' : '播放', state.playing ? 'pause' : 'play', toggle, { disabled: busy }),
        h('span', { className: 'rufa-media-time' }, formatTime(state.time) + (state.duration ? ' / ' + formatTime(state.duration) : '')),
        h('span', { style: { flex: 1 } }),
        h('div', { className: 'rufa-media-volume' },
          button(state.muted ? '取消静音' : '静音', state.muted ? 'mute' : 'volume', () => control.current?.mute(), { disabled: !state.hasAudio }),
          h('div', { className: 'rufa-media-volume-slider' }, h('input', { type: 'range', 'aria-label': '音量', disabled: !state.hasAudio, min: 0, max: 1, step: 0.01, value: state.muted ? 0 : state.volume,
            onChange: event => control.current?.volume(Number(event.target.value)), style: { width: '60px', '--fill': (state.muted ? 0 : state.volume * 100) + '%' } }))),
        button(full ? '退出全屏' : '全屏', full ? 'exit' : 'full', fullscreen),
        button('更多选项', 'more', () => setMenu(menu ? '' : 'main'), { ref: menuButton, 'aria-haspopup': 'menu', 'aria-expanded': !!menu })),
      h('div', { className: 'rufa-media-timeline' },
        h('input', { type: 'range', 'aria-label': '播放进度', min: 0, max: state.duration || 1, step: 0.01, value: Math.min(state.time, state.duration || state.time),
          disabled: state.phase !== 'ready' || !state.duration, onChange: event => { void control.current?.seek(Number(event.target.value)); }, style: { '--fill': progress + '%' } }))) : null,
    direct && menu ? h('div', { className: 'rufa-media-menu', role: 'menu', 'aria-label': menu === 'speed' ? '播放速度' : '更多选项' },
      ...(menu === 'speed' ? [h('button', { key: 'back', type: 'button', role: 'menuitem', onClick: () => setMenu('main') }, icon('back'), '播放速度'),
        ...[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(rate => h('button', { key: rate, type: 'button', role: 'menuitemradio', 'aria-checked': state.rate === rate,
          className: state.rate === rate ? 'rufa-media-selected' : '', onClick: () => { control.current?.rate(rate); setMenu(''); menuButton.current?.focus(); } },
          h('span', { style: { width: 24, height: 24 } }, state.rate === rate ? icon('check') : null), rate === 1 ? '正常' : rate + ''))]
        : [h('a', { key: 'download', role: 'menuitem', href: downloadUrl(props.scope, props.path), download: true, onClick: () => setMenu('') }, icon('download'), '下载'),
          h('button', { key: 'speed', type: 'button', role: 'menuitem', onClick: () => setMenu('speed') }, icon('speed'), '播放速度')])) : null,
    statusMessage || state.phase === 'failed' || state.audioResumeNeeded ? h('div', { className: 'rufa-media-notice', role: 'status', 'aria-live': 'polite' },
      statusMessage ? h('span', null, statusMessage) : null,
      state.audioResumeNeeded ? h('button', { type: 'button', onClick: () => { void control.current?.play(); }, disabled: busy }, '恢复声音') : null,
      state.phase === 'failed' ? h('button', { type: 'button', onClick: () => { void control.current?.retry(); } }, '重试播放') : null) : null),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #8b90a0)', flex: 'none', minWidth: 0 } },
      h('span', { title: props.path, style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.title),
      h('a', { href: downloadUrl(props.scope, props.path), download: true, style: { color: 'var(--dsw-alias-link-normal, #4c8dff)', textDecoration: 'none' } }, '下载')));
  }
  function useNativeAudio(sourceUrl) {
    const [state, setState] = React.useState({ phase: 'idle', message: '', retryKey: 0 });
    const active = React.useRef(null);
    React.useEffect(() => {
      const current = { sourceUrl, abort: new AbortController(), failed: false, revision: 0 };
      active.current = current; setState(previous => ({ ...previous, phase: 'idle', message: '' }));
      return () => { current.abort.abort(); if (active.current === current) active.current = null; };
    }, [sourceUrl]);
    const onError = React.useCallback(async error => {
      const current = active.current;
      if (!current || current.failed || !current.sourceUrl || error?.name === 'AbortError' || error?.code === 1) return;
      if (error?.name === 'NotAllowedError') { setState(previous => ({ ...previous, message: '请点击播放按钮开始播放。' })); return; }
      current.failed = true; const revision = current.revision; const signal = current.abort.signal;
      let message = '无法播放此音频，文件可能损坏或编码暂不支持。';
      try {
        const response = await fetch(current.sourceUrl, { method: 'HEAD', credentials: 'same-origin', signal });
        if (response.status === 401) message = '登录已失效，请重新登录后打开文件。';
        else if (response.status === 403) message = '没有读取此文件的权限。';
        else if (response.status === 404) message = '文件已不存在，请重新选择文件。';
        else if (!response.ok) message = '无法读取音频文件，请检查连接后重试。';
      } catch { if (signal.aborted) return; message = '无法读取音频文件，请检查连接后重试。'; }
      if (active.current === current && revision === current.revision && !signal.aborted) setState(previous => ({ ...previous, phase: 'failed', message }));
    }, []);
    const clear = React.useCallback(() => {
      if (active.current) { active.current.failed = false; active.current.revision++; active.current.abort.abort(); active.current.abort = new AbortController(); }
      setState(previous => ({ ...previous, phase: 'idle', message: '' }));
    }, []);
    const retry = React.useCallback(() => {
      if (active.current) { active.current.revision++; active.current.abort.abort(); active.current.abort = new AbortController(); active.current.failed = false; }
      setState(previous => ({ phase: 'idle', message: '', retryKey: previous.retryKey + 1 }));
    }, []);
    return { ...state, onError, clear, retry };
  }
  function AudioStatus({ preview }) {
    if (!preview.message) return null;
    return h('div', { className: 'dsh-audio__notice', role: 'status', 'aria-live': 'polite' }, h('span', null, preview.message),
      preview.phase === 'failed' ? h('button', { type: 'button', onClick: preview.retry }, '重试播放') : null);
  }
  return { VideoView, useNativeAudio, AudioStatus };
}

const OLD_MARKER = 'RUFA_MEDIA_PREVIEW_CLIENT_V1';
const MARKER = 'RUFA_MEDIA_DIRECT_CLIENT_V1';
const ORIGINAL_HASH = { video: '52d80a7df54138dd1ce7641bc28c06acf46b21339864e2c912e79ad57da5de35', audio: '54dedae6d28992c7dbed798ef972bbe3ab69b5b84a6dfe2311aaadcf883cf8af' };
const V3_HASH = { video: '061f0b48542a4a66d2459a479d31a5690a85ae0bf004a4fb1a6811c4b2798fca', audio: 'c06cd4ec34b5ff554a274b10cc4cf2706b211c2f8e5e353b7ed316694f55e8bc' };
function sha(source) { return createHash('sha256').update(source).digest('hex'); }
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Media preview client anchor drift: ' + before.slice(0, 75));
  return source.replace(before, after);
}
export function restoreMediaPreviewClient(source, kind) {
  if (!ORIGINAL_HASH[kind]) throw new Error('Unknown media preview kind');
  const direct = source.match(/\n\/\* RUFA_MEDIA_DIRECT_CLIENT_V1 (video|audio) ([a-f0-9]{64}) ([a-f0-9]{64}) ([A-Za-z0-9+/=]+) \*\/\n?$/);
  const legacy = source.match(/\n\/\* RUFA_MEDIA_PREVIEW_CLIENT_V1 (video|audio) ([a-f0-9]{64}) ([A-Za-z0-9+/=]+) \*\/\n?$/);
  if (!direct && !legacy) {
    if (source.includes(MARKER) || source.includes(OLD_MARKER)) throw new Error('Invalid media preview client marker');
    return source;
  }
  const match = direct ?? legacy;
  if (match[1] !== kind || match[2] !== ORIGINAL_HASH[kind]) throw new Error('Media preview original checksum mismatch');
  if (direct ? sha(source.slice(0, direct.index)) !== direct[3] : sha(source) !== V3_HASH[kind]) throw new Error('Media preview patched body checksum mismatch');
  const original = Buffer.from(match[direct ? 4 : 3], 'base64').toString('utf8');
  if (sha(original) !== ORIGINAL_HASH[kind]) throw new Error('Media preview original checksum mismatch');
  return original;
}
export function patchMediaPreviewClient(input, kind) {
  const original = restoreMediaPreviewClient(input, kind);
  if (sha(original) !== ORIGINAL_HASH[kind]) throw new Error('Media preview upstream checksum drift');
  let source = original.replace(/\r\n/g, '\n');
  const functions = [loadRufaAVPlayer, observeMediaVisibility, createDirectVideoController, createMediaPreviewReact].map(fn => fn.toString()).join('\n');
  const hooks = '\n' + functions + '\n';
  if (kind === 'video') {
    const start = source.indexOf('    function VideoView(props) {');
    const end = source.indexOf('    /** Cordis service dependencies', start);
    if (start < 0 || end < 0) throw new Error('Media preview video anchor drift');
    source = source.slice(0, start) + hooks + '\nconst { VideoView } = createMediaPreviewReact(import_react);\n\n' + source.slice(end);
  } else {
    source = replaceOnce(source, '\t\tfunction AudioViewer({ data }) {', hooks + '\nconst { useNativeAudio, AudioStatus } = createMediaPreviewReact(react);\n\t\tfunction AudioViewer({ data }) {');
    source = replaceOnce(source, 'const sourceUrl = source === null ? null : source.url;', 'const sourceUrl = source === null ? null : source.url;\nconst preview = useNativeAudio(sourceUrl);');
    source = replaceOnce(source, 'const decodeStartedRef = (0, react.useRef)(false);', 'const decodeStartedRef = (0, react.useRef)(false);\nconst metadataSourceRef = (0, react.useRef)(null);');
    source = replaceOnce(source, 'if (sourceUrl === null) return;\n\t\t\t\tdecodeStartedRef.current = false;',
      'decodeAbortRef.current?.abort();\nmetadataSourceRef.current = null;\nsetDuration(0); setTime(0); setDecoded(null); setNotice(null); setAudioFailure(false); setSelection(null); setView(fullView(0)); setHeatmap({ image: null, spec: null });\nsetDecodeState({status: "idle", loaded: 0, total: 0});\nif (sourceUrl === null) return;\n\t\t\t\tdecodeStartedRef.current = false;');
    source = replaceOnce(source, 'const onMetadata = () => {', 'const onMetadata = () => {\nmetadataSourceRef.current = sourceUrl; preview.clear();');
    source = replaceOnce(source, 'if (duration <= 0 || decodeStartedRef.current) return;', 'if (metadataSourceRef.current !== sourceUrl || duration <= 0 || decodeStartedRef.current) return;');
    source = replaceOnce(source, 'const onError = () => setNotice(t.loadFailed);', 'const onError = () => { setReady(false); void preview.onError(element.error); };');
    source = replaceOnce(source, 'setNotice(error instanceof Error ? error.message : String(error));', 'void preview.onError(error);');
    source = replaceOnce(source, '}, [sourceUrl, t.loadFailed]);', '}, [sourceUrl, t.loadFailed, preview.retryKey]);\n(0, react.useEffect)(() => observeMediaVisibility(containerRef.current, visible => { if (!visible) playerRef.current?.pause(); }), [sourceUrl]);');
    source = replaceOnce(source, 'if (ready === false) parts.unshift(t.loading);', 'if (ready === false && preview.phase !== "failed") parts.unshift(t.loading);');
    source = replaceOnce(source, '\t\t\t\tpeakHz,\n\t\t\t\tready,\n\t\t\t\tstats,', '\t\t\t\tpeakHz,\n\t\t\t\tready,\n\t\t\t\tpreview.phase,\n\t\t\t\tstats,');
    source = replaceOnce(source, 'className: "dsh-audio__notices",\n\t\t\t\t\t\tchildren: [', 'className: "dsh-audio__notices",\n\t\t\t\t\t\tchildren: [react.createElement(AudioStatus, {key: "playback-status", preview}),');
  }
  return source + '\n/* ' + MARKER + ' ' + kind + ' ' + sha(original) + ' ' + sha(source) + ' ' + Buffer.from(original).toString('base64') + ' */\n';
}
