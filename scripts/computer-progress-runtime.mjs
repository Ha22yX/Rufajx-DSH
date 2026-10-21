// Bounded presentation patch for the pinned computer-use plugin; never patch a
// running runtime. Native input, stop hooks and permission gates remain owners.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const assets = fileURLToPath(new URL('../preinstalled/desktop-video/progress/', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const originals = {
  'mcp/activity.mjs': 'ced1e47ad70a4bca0920b27ae1dd7f4fec9db248bcaea8a099cd21c53ae7db57',
  'mcp/takeover.mjs': '18517cc9fc8ed2456281326ff030f44a9897142b760a6820f1c08a17c5672b77',
  'mcp/dsh-plugin.mjs': '4309754468c565d668c1ca11d881e432a07f2ca94823e9a31d8e04bdbe328fdf',
  'scripts/windows-takeover.cs': '86f208a87b1fbcf4d495316e9ae0201615bd479d3b861fef28ceee13da138b89',
};
const patched = {
  'mcp/activity.mjs': '2930791e195387317a46e3deb13ae84a1528fe3d66335b4632dcec0741876f6e',
  'mcp/takeover.mjs': '535a707923e883257b2da3e006a6a5d8b666960b7a6e525256807da7ddb52fbb',
  'mcp/dsh-plugin.mjs': '525e91bafd3c83a11c72007fa3d80a907f3a7f1bbfbd08afbfd65ec5b3ccf0a6',
};
const extensionMarker = '// Rufajx presentation extension.';
const nativePrefixHash = 'a23f18dbb15d80d2158da6148191a9af1315eda72998e5847c67473b5806b18c';
const cardHashes = {
  native: '9b5c3539c31551d7c9e328fe78d5ce061d02462d616fb062692bddc267c749d9',
  activity: 'afe02794006e07b0f18325ac43ebdb7923f669dfbb05543f68182da93a4b9974',
  takeover: 'a51db4527800ca71dede9d120a89ed72d0f6aa90ffed091098deb3cde0717283',
};
function exact(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Computer progress anchor changed: ${before.slice(0, 80)}`);
  return source.replace(before, () => after);
}
const trailer = /\n\/\/ Rufajx computer progress integrity: ([a-f0-9]{64})\n?$/;
const activityCurrentHash = 'fb1dd4c896051aed8438a78cfb64a6ecc7a4779016f996be67e45c4631f48787';
function currentActivity(source) {
  source = exact(source, "const syncTaskOwner=()=>{\n    const task=", "const syncTaskOwner=()=>{\n    if(closed)return;\n    const task=");
  source = exact(source, 'let owner,closed=false,needsPublish=true,lastStopped;', 'let owner,closed=false,needsPublish=true;const acknowledgedStops=new Set();');
  source = exact(source, `if(state?.paused&&state.stoppedSeriesKey&&state.stoppedSeriesKey!==lastStopped){
            const [sessionId,turn]=JSON.parse(state.stoppedSeriesKey);
            if(typeof sessionId==='string'&&Number.isSafeInteger(turn)){
              lastStopped=state.stoppedSeriesKey;
              Promise.resolve(ctx.get?.('rufaComputerTasks')?.stopFromDesktop({sessionId,turn})).catch(error=>ctx.logger.error(error));
            }
          }`, `const keys=new Set(Object.keys(state?.blockedSeries??{}));
          if(state?.paused&&typeof state.stoppedSeriesKey==='string')keys.add(state.stoppedSeriesKey);
          for(const key of acknowledgedStops)if(!keys.has(key))acknowledgedStops.delete(key);
          for(const key of keys){
            if(acknowledgedStops.has(key))continue;
            let pair;try{pair=JSON.parse(key);}catch{continue;}
            if(!Array.isArray(pair)||pair.length!==2)continue;
            const [sessionId,turn]=pair;
            if(typeof sessionId==='string'&&Number.isSafeInteger(turn)&&ctx.get?.('rufaComputerTasks')?.stopFromDesktop({sessionId,turn})===true)acknowledgedStops.add(key);
          }`);
  return source;
}
function cardActivity(source) {
  source = exact(source, 'const progressFor=id=>normalizeProgress', `const presentation=()=>{
    if(closed)return null;
    const receipt=ctx.get?.('rufaComputerTasks')?.presentationTask?.();
    const progress=normalizeProgress(receipt?.progress);
    return progress&&['completed','stopped','failed'].includes(progress.status)&&typeof receipt.sessionId==='string'&&Number.isSafeInteger(receipt.turn)&&Number.isFinite(receipt.expiresAt)&&receipt.expiresAt>Date.now()
      ?{sessionId:receipt.sessionId,turn:receipt.turn,expiresAt:receipt.expiresAt,progress}:null;
  };
  const progressFor=id=>normalizeProgress`);
  source = exact(source, 'progress:owner?(progressFor(owner.id)??normalizeProgress(owner.progress)):null',
    'progress:owner?(progressFor(owner.id)??normalizeProgress(owner.progress)):null,presentation:presentation()');
  return exact(source, "if(owner||needsPublish||ctx.get?.('rufaComputerTasks')?.activeTask())publish();",
    "if(owner||needsPublish||ctx.get?.('rufaComputerTasks')?.activeTask()||presentation())publish();");
}
function cardTakeover(source) {
  source = exact(source, '    if(this.activityFile){', '    let receipt;\n    if(this.activityFile){');
  source = exact(source, 'this.progress=held?normalizeProgress(activity.progress):null;',
    'this.progress=held?normalizeProgress(activity.progress):null;\n      if(!held)receipt=activity.presentation;');
  source = exact(source, '    if (this.config.resumeToken !== this.resumeToken', `    const terminal=normalizeProgress(receipt?.progress);
    const receiptKey=receipt?JSON.stringify([receipt.sessionId,receipt.turn,receipt.expiresAt,terminal?.status]):null;
    // A receipt cannot hold a control lease, clear Esc, resume input or extend itself.
    if(!this.seriesHeld&&this.active===0&&terminal&&['completed','stopped','failed'].includes(terminal.status)&&Number.isFinite(receipt.expiresAt)&&receipt.expiresAt>Date.now()&&receiptKey!==this.shownReceipt&&!this.disabledForTest){
      await this.command('task_result',{...this.config,progress:terminal,displayMs:Math.min(2000,receipt.expiresAt-Date.now())});
      this.shownReceipt=receiptKey;
    }
    if (this.config.resumeToken !== this.resumeToken`);
  return source;
}
function cardNative(source) {
  source = exact(source, 'TaskProgress.Read(command))) image.Save',
    'TaskProgress.Read(command),(float)Get(command,"scale",1.0))) image.Save');
  source = exact(source, '    TaskProgress progress;', '    TaskProgress progress;\n    bool showingResult;');
  source = exact(source, 'armed = false; hideAt = DateTime.MaxValue; return;',
    'armed = false; showingResult = false; hideAt = DateTime.MaxValue; return;');
  source = exact(source, 'if(armed&&!paused)RefreshDisplays(false);', 'if((armed&&!paused)||showingResult)RefreshDisplays(false);');
  source = exact(source, 'if(armed&&!paused&&indicator)ShowFrames();', 'if(((armed&&!paused)||showingResult)&&indicator)ShowFrames();');
  source = exact(source, '          armed = true; hideAt', '          showingResult = false;\n          armed = true; hideAt');
  source = exact(source, '        } else if (action == "configure") {', `        } else if (action == "task_result") {
          var result = TaskProgress.Read(command);
          if(result == null || !result.Terminal) throw new ArgumentException("Terminal task receipt required");
          // Display only. Preserve the cancellation event and paused state.
          armed = false; showingResult = true; progress = result; HidePointer();
          indicator = Get(command,"indicatorEnabled",true);
          position = Get(command,"indicatorPosition",position);
          ConfigureVisibility(Get(command,"remoteIndicatorVisible",remoteVisible));
          hideAt = DateTime.UtcNow.AddMilliseconds(Math.Max(1,Math.Min(2000,Get(command,"displayMs",2000))));
          RefreshDisplays(true);
          if(!indicator)HideFrames();
          else if(frames.Count==0)ShowFrames();
          else foreach(var frame in frames){frame.UpdateContent(text,position,progress);frame.Present(255);}
        } else if (action == "configure") {`);
  source = exact(source, '          hideAt = DateTime.UtcNow.AddMilliseconds(idleMs);',
    '          if(!showingResult)hideAt = DateTime.UtcNow.AddMilliseconds(idleMs);');
  source = exact(source, 'paused = false; armed = false; cancel.Reset();', 'showingResult = false; paused = false; armed = false; cancel.Reset();');
  source = exact(source, 'cancel.Set(); paused = true; armed = false; hideAt', 'cancel.Set(); showingResult = false; paused = true; armed = false; hideAt');
  source = exact(source, 'progressVisible=frames.Count>0&&progress!=null,',
    'progressVisible=frames.Count>0&&progress!=null, resultVisible=showingResult&&frames.Count>0,');
  source = exact(source, '      using (var image = Draw(rectangle.Width, rectangle.Height, text, position, progress))',
    '      using (var image = Draw(rectangle.Width, rectangle.Height, text, position, progress, DisplayScale(rectangle)))');
  source = exact(source, 'Draw(bounds.Width, bounds.Height, text, position, progress)',
    'Draw(bounds.Width, bounds.Height, text, position, progress, DisplayScale(bounds))');
  source = exact(source, '    internal static Bitmap Draw(int width, int height, string text, string position, TaskProgress progress = null) {',
    `    static float DisplayScale(Rectangle bounds) {
      uint x=96,y=96;
      try { if(Native.GetDpiForMonitor(Native.MonitorFromPoint(new Native.Point(bounds.Left+bounds.Width/2,bounds.Top+bounds.Height/2),2),0,out x,out y)!=0)x=96; }
      catch(EntryPointNotFoundException) { }
      return Math.Max(1f,Math.Min(3f,x/96f));
    }
    internal static Bitmap Draw(int width, int height, string text, string position, TaskProgress progress = null, float progressScale = 1f) {`);
  source = exact(source, '        for (int i=0;i<12;i++) {', '        if(progress==null||!progress.Terminal)for (int i=0;i<12;i++) {');
  source = exact(source, '        using (var pen = new Pen(Color.FromArgb(160,150,215,255),1))',
    '        if(progress==null||!progress.Terminal)using (var pen = new Pen(Color.FromArgb(160,150,215,255),1))');
  source = exact(source, '        using (var font = new Font("Microsoft YaHei UI",10f*scale,FontStyle.Regular,GraphicsUnit.Point)) {',
    '        if(progress==null)using (var font = new Font("Microsoft YaHei UI",10f*scale,FontStyle.Regular,GraphicsUnit.Point)) {');
  source = exact(source, 'progress.Draw(g, width, height, position);', 'progress.Draw(g, width, height, position, progressScale);');
  source = exact(source, 'foreach(var frame in frames)Native.KeepOnTop(frame.Handle);', 'foreach(var frame in frames)frame.KeepOnTop();');
  source = exact(source, 'resultVisible=showingResult&&frames.Count>0,',
    'resultVisible=showingResult&&frames.Count>0, backdropWindows=frames.FindAll(frame=>frame.BackdropApplied).Count,');
  source = exact(source, '    readonly Rectangle rectangle;', '    readonly Rectangle rectangle;\n    BlurBackdrop backdrop;\n    byte lastAlpha=255;');
  source = exact(source, 'previous = Native.SelectObject(dc, bitmap);\n    }',
    'previous = Native.SelectObject(dc, bitmap);\n      UpdateBackdrop(progress,position);\n    }');
  // PointerFrame has a similar visibility method. Anchor to Frame-only DisplayBounds.
  source = exact(source, 'internal void SetRemoteVisible(bool visible) {remoteVisible=visible;if(IsHandleCreated)Native.SetWindowDisplayAffinity(Handle,visible?0u:0x11u);}\n    internal Rectangle DisplayBounds',
    'internal void SetRemoteVisible(bool visible) {remoteVisible=visible;if(IsHandleCreated)Native.SetWindowDisplayAffinity(Handle,visible?0u:0x11u);if(backdrop!=null)backdrop.SetRemoteVisible(visible);}\n    internal Rectangle DisplayBounds');
  source = exact(source, '    internal void Present(byte alpha) {\n      if (IsDisposed) return;', `    internal bool BackdropApplied {get{return backdrop!=null&&backdrop.Applied;}}
    void UpdateBackdrop(TaskProgress progress,string position) {
      if(progress==null){if(backdrop!=null){backdrop.Dispose();backdrop=null;}return;}
      if(backdrop==null)backdrop=new BlurBackdrop();
      float scale=DisplayScale(rectangle);
      backdrop.Update(progress.BackdropBounds(rectangle,position,scale),(int)Math.Round(13*scale));
      backdrop.SetRemoteVisible(remoteVisible);
    }
    internal void KeepOnTop() {
      Native.KeepOnTop(Handle);
      if(backdrop!=null){backdrop.KeepBelow(Handle);backdrop.Present(lastAlpha);}
    }
    internal void Present(byte alpha) {
      if (IsDisposed) return;
      lastAlpha=alpha;`);
  source = exact(source, '"Could not present takeover overlay");\n    }',
    '"Could not present takeover overlay");\n      if(backdrop!=null){backdrop.KeepBelow(Handle);backdrop.Present(alpha);}\n    }');
  source = exact(source, 'Native.SelectObject(dc, next); Native.DeleteObject(bitmap); bitmap = next;\n      }\n    }',
    'Native.SelectObject(dc, next); Native.DeleteObject(bitmap); bitmap = next;\n      }\n      UpdateBackdrop(progress,position);\n    }');
  source = exact(source, '      if (dc!=IntPtr.Zero) { Native.SelectObject(dc,previous);',
    '      if(disposing&&backdrop!=null){backdrop.Dispose();backdrop=null;}\n      if (dc!=IntPtr.Zero) { Native.SelectObject(dc,previous);');
  return source;
}
export function patchProgressSource(input, file, csExtension) {
  let source = input.replaceAll('\r\n', '\n');
  const match = source.match(trailer);
  if (match) {
    if (sha(source.slice(0, match.index)) !== match[1]) throw new Error(`Computer progress integrity mismatch: ${file}`);
    if (file === 'scripts/windows-takeover.cs') {
      let prefix = source.slice(0, source.indexOf(extensionMarker));
      if (sha(prefix) === nativePrefixHash) prefix = cardNative(prefix);
      else if (sha(prefix) !== cardHashes.native) throw new Error(`Unsupported computer progress native base: ${file}`);
      // Replay the current packaged presentation even on a prior intact build.
      source = prefix + csExtension.replaceAll('\r\n', '\n');
      return `${source}\n// Rufajx computer progress integrity: ${sha(source)}\n`;
    }
    if (file === 'mcp/activity.mjs') {
      if (match[1] === cardHashes.activity) return source;
      let payload = source.slice(0, match.index);
      if (match[1] === activityCurrentHash) {
        const migrated = cardActivity(payload);
        return `${migrated}\n// Rufajx computer progress integrity: ${sha(migrated)}\n`;
      }
      if (match[1] === 'b2742618d3439d39b112bd5162741b7ac4d210745bbdeee0229e8d0cdbf3e699')
        payload = exact(exact(payload, "if(closed)return;\n    const task=", "const task="),
          "if(ctx.get?.('rufaComputerTasks')?.stopFromDesktop({sessionId,turn})===true)lastStopped=state.stoppedSeriesKey;",
          "lastStopped=state.stoppedSeriesKey;\n              Promise.resolve(ctx.get?.('rufaComputerTasks')?.stopFromDesktop({sessionId,turn})).catch(error=>ctx.logger.error(error));");
      if (sha(payload) !== patched[file]) throw new Error(`Unsupported computer progress output: ${file}`);
      const migrated = cardActivity(currentActivity(payload));
      return `${migrated}\n// Rufajx computer progress integrity: ${sha(migrated)}\n`;
    }
    if (file === 'mcp/takeover.mjs') {
      if (match[1] === cardHashes.takeover) return source;
      if (match[1] !== patched[file]) throw new Error(`Unsupported computer progress output: ${file}`);
      const migrated = cardTakeover(source.slice(0, match.index));
      return `${migrated}\n// Rufajx computer progress integrity: ${sha(migrated)}\n`;
    }
    if (match[1] !== patched[file]) throw new Error(`Unsupported computer progress output: ${file}`);
    return source;
  }
  if (sha(source) !== originals[file]) throw new Error(`Unsupported computer-use source: ${file}`);
  if (file === 'mcp/dsh-plugin.mjs') {
    source = exact(source, 'installActivity(ctx,runtime.activityFile);', 'installActivity(ctx,runtime.activityFile,{stateFile:runtime.stateFile});');
  } else if (file === 'mcp/activity.mjs') {
    source = exact(source, "import {atomicJson} from './takeover.mjs';", "import {atomicJson} from './takeover.mjs';\nimport {readFileSync} from 'node:fs';\nimport {normalizeProgress,stepForTool} from './rufa-presentation.mjs';");
    source = exact(source, '{idleMs=ACTIVITY_IDLE_MS}={}', '{idleMs=ACTIVITY_IDLE_MS,stateFile}={}')
      .replace('let owner,closed=false,needsPublish=true;', 'let owner,closed=false,needsPublish=true,lastStopped;');
    source = exact(source, 'const expireIdle=()=>{if(owner&&owner.pending===0&&Date.now()-owner.lastActive>=idleMs)owner=undefined;};',
      `const progressFor=id=>normalizeProgress(ctx.get?.('rufaComputerTasks')?.progressFor(id));
  const syncTaskOwner=()=>{
    const task=ctx.get?.('rufaComputerTasks')?.activeTask();
    if(task&&typeof task.sessionId==='string'&&Number.isSafeInteger(task.turn)&&normalizeProgress(task.progress)){
      owner??={id:task.sessionId,turn:task.turn,pending:0,lastActive:Date.now(),managed:true};
      if(owner.id===task.sessionId){owner.turn=task.turn;owner.managed=true;owner.progress=task.progress;}
    }else if(owner?.managed&&owner.pending===0)owner=undefined;
  };
  const expireIdle=()=>{if(owner&&owner.pending===0&&Date.now()-owner.lastActive>=idleMs&&!['working','waiting'].includes(progressFor(owner.id)?.status))owner=undefined;};`);
    source = exact(source, 'needsPublish=true;expireIdle();', 'needsPublish=true;syncTaskOwner();expireIdle();');
    source = exact(source, 'expiresAt:owner?Date.now()+5000:0',
      "expiresAt:owner?Date.now()+5000:0,progress:owner?(progressFor(owner.id)??normalizeProgress(owner.progress)):null");
    source = exact(source, 'current.turn=turn;current.pending++;publish();',
      "current.turn=turn;current.pending++;current.progress={task:'电脑操作',currentStep:stepForTool(exec.name),completedSteps:[],status:'working'};publish();");
    source = exact(source, 'const timer=setInterval(()=>{if((owner||needsPublish)&&!closed)try{publish();}catch(error){ctx.logger.error(error);}},1000);',
      `const timer=setInterval(()=>{
      if(closed)return;
      try {
        if(stateFile){
          let state;try{state=JSON.parse(readFileSync(stateFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
          if(state?.paused&&state.stoppedSeriesKey&&state.stoppedSeriesKey!==lastStopped){
            const [sessionId,turn]=JSON.parse(state.stoppedSeriesKey);
            if(typeof sessionId==='string'&&Number.isSafeInteger(turn)){
              lastStopped=state.stoppedSeriesKey;
              Promise.resolve(ctx.get?.('rufaComputerTasks')?.stopFromDesktop({sessionId,turn})).catch(error=>ctx.logger.error(error));
            }
          }
        }
        if(owner||needsPublish||ctx.get?.('rufaComputerTasks')?.activeTask())publish();
      }catch(error){ctx.logger.error(error);}
    },250);`);
  } else if (file === 'mcp/takeover.mjs') {
    source = exact(source, "import { DEFAULT_SETTINGS, normalizeSettings } from './settings.mjs';",
      "import { DEFAULT_SETTINGS, normalizeSettings } from './settings.mjs';\nimport { normalizeProgress } from './rufa-presentation.mjs';");
    source = exact(source, "const key=held?JSON.stringify([activity.sessionId,activity.turn]):this.seriesKey;",
      "const key=held?JSON.stringify([activity.sessionId,activity.turn]):this.seriesKey;\n      this.progress=held?normalizeProgress(activity.progress):null;");
    source = exact(source, 'this.config.indicatorIdleMs,this.config.stopShortcut]);',
      'this.config.indicatorIdleMs,this.config.stopShortcut,this.progress]);');
    const commandCount = source.split("this.command('begin',this.config)").length - 1;
    if (commandCount !== 2) throw new Error('Computer progress begin anchors changed');
    source = source.replaceAll("this.command('begin',this.config)", "this.command('begin',this.presentation())");
    source = exact(source, "this.command('begin', this.config)", "this.command('begin', this.presentation())");
    source = exact(source, "?'begin':'configure', this.config)", "?'begin':'configure', this.presentation())");
    source = exact(source, '  async begin() {', "  presentation() { return { ...this.config, progress: this.progress ?? null }; }\n  async begin() {");
  } else if (file === 'scripts/windows-takeover.cs') {
    source = exact(source, '    int idleMs = 800;', '    int idleMs = 800;\n    TaskProgress progress;');
    source = exact(source, '          bool rebuild = nextIndicator', '          var nextProgress = TaskProgress.Read(command);\n          bool progressChanged = (progress == null ? "" : progress.Identity) != (nextProgress == null ? "" : nextProgress.Identity);\n          progress = nextProgress;\n          bool rebuild = nextIndicator');
    source = exact(source, '          else foreach (var frame in frames) frame.Present(255);',
      '          else foreach (var frame in frames) { if (progressChanged) frame.UpdateContent(text, position, progress); frame.Present(255); }');
    source = exact(source, 'new Frame(bounds, text, position,remoteVisible)', 'new Frame(bounds, text, position,remoteVisible,progress)');
    source = exact(source, 'internal Frame(Rectangle bounds, string text, string position,bool visible)', 'internal Frame(Rectangle bounds, string text, string position,bool visible,TaskProgress progress)');
    source = exact(source, 'Draw(bounds.Width, bounds.Height, text, position)', 'Draw(bounds.Width, bounds.Height, text, position, progress)');
    source = exact(source, 'internal static Bitmap Draw(int width, int height, string text, string position) {',
      `internal void UpdateContent(string text, string position, TaskProgress progress) {
      using (var image = Draw(rectangle.Width, rectangle.Height, text, position, progress)) {
        IntPtr next = image.GetHbitmap(Color.FromArgb(0));
        Native.SelectObject(dc, next); Native.DeleteObject(bitmap); bitmap = next;
      }
    }
    internal static Bitmap Draw(int width, int height, string text, string position, TaskProgress progress = null) {`);
    source = exact(source, 'Get(command, "indicatorPosition", "top"))) image.Save', 'Get(command, "indicatorPosition", "top"), TaskProgress.Read(command))) image.Save');
    source = exact(source, '      return image;\n    }\n    internal static GraphicsPath Rounded', '      if (progress != null) using (var g = Graphics.FromImage(image)) { g.SmoothingMode = SmoothingMode.AntiAlias; progress.Draw(g, width, height, position); }\n      return image;\n    }\n    internal static GraphicsPath Rounded');
    source = exact(source, 'overlayClickThrough=frames.Count>0&&frames.TrueForAll(frame=>frame.ClickThrough),', 'overlayClickThrough=frames.Count>0&&frames.TrueForAll(frame=>frame.ClickThrough), progressVisible=frames.Count>0&&progress!=null,');
    source = cardNative(source) + '\n' + csExtension.replaceAll('\r\n', '\n');
  }
  if (file === 'mcp/activity.mjs') source = cardActivity(currentActivity(source));
  if (file === 'mcp/takeover.mjs') source = cardTakeover(source);
  return `${source}\n// Rufajx computer progress integrity: ${sha(source)}\n`;
}
async function atomic(file, value) {
  const temporary = `${file}.${randomUUID()}.pending`;
  try { await writeFile(temporary, value, { flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function patchComputerProgressRuntime(runtimeInput, { checkOnly = false } = {}) {
  const root = join(resolve(runtimeInput), 'node_modules/dsh-computer-use-win');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== '0.4.3' || manifest.name !== 'dsh-computer-use-win') throw new Error('Computer progress requires pinned plugin');
  const extension = await readFile(join(assets, 'Progress.cs'), 'utf8') + '\n' + await readFile(join(assets, 'BlurBackdrop.cs'), 'utf8');
  const edits = await Promise.all(Object.keys(originals).map(async file => {
    const source = await readFile(join(root, file), 'utf8');
    return { file, source, value: patchProgressSource(source, file, extension) };
  }));
  const presentation = await readFile(join(assets, 'presentation.mjs'), 'utf8');
  const helper = join(root, 'mcp/rufa-presentation.mjs');
  if (checkOnly) {
    for (const edit of edits) if (edit.source !== edit.value) throw new Error(`Missing packaged computer progress: ${edit.file}`);
    if (await readFile(helper, 'utf8') !== presentation) throw new Error('Packaged computer progress helper mismatch');
  } else {
    await atomic(helper, presentation);
    for (const edit of edits) if (edit.source !== edit.value) await atomic(join(root, edit.file), edit.value);
  }
  return { computerProgress: 1 };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await patchComputerProgressRuntime(process.argv[2], { checkOnly: process.argv.includes('--check') })));
}
