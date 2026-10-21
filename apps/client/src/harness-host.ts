import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join, resolve, dirname, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelCatalog } from './types.js';
import { CompanyError } from './types.js';
import type { CompanyApi } from './company-api.js';
import { RuntimeBridge } from './runtime-bridge.js';
import { protectDiagnostic } from './diagnostic.js';
import { accountRuntimePaths, canonicalRuntimePaths, initializeProfileDefaults, prepareAccountDirectories, writeAccountOverlay } from './runtime-configuration.js';
import { applyCompanyPreset } from './company-preset.js';
import { initializeDesktopVideoDefaults } from './desktop-video-defaults.js';
import { AdminTools } from './admin-tools.js';
import { confirmInChat } from './chat-admin-confirmation.js';
import { PreferenceStore, type PreferenceProject } from './preference-store.js';

export function sanitizedRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Launch only the OS/tool discovery variables; credentials, proxy hooks and NODE_OPTIONS never inherit.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_ALL|TERM)$/i;
  for (const [key, value] of Object.entries(source)) if (allowed.test(key)) env[key.toUpperCase()] = value;
  return env;
}
export async function loadPreferenceValidator(pluginRoot: string): Promise<(text: string) => string> {
  const { validatePreferenceContent } = await import(pathToFileURL(join(pluginRoot, 'company-preference-rules.mjs')).href);
  if (typeof validatePreferenceContent !== 'function') throw new Error('工作偏好规则模块不可用。');
  return validatePreferenceContent;
}

export function enterpriseOverlay(pluginRoot: string, modelId: string, modelIds: string[], user: { username: string; displayName: string; jobTitle?: string; role: 'employee' | 'admin' } | undefined, companyHome: string, runtimeRoot: string): object[] {
  const plugin = (file: string) => pathToFileURL(join(pluginRoot, file)).href;
  return [
    { id: 'credentials', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'session-persistence-jsonl', disabled: true },
    { id: 'web-search-deepseek', disabled: true },
    { id: 'web-deepseek-api', disabled: true },
    { id: 'session-log-deepseek', disabled: true },
    { id: 'desktop-product-telemetry', disabled: true },
    { id: 'product-analytics', disabled: true },
    { id: 'ui-brand-official', disabled: true },
    { id: 'ui-settings-models', disabled: true },
    { id: 'ui-settings-account', disabled: true },
    { id: 'ui-agent-preset', disabled: true },
    { id: 'ui-settings-plugins', disabled: true },
    { id: 'ui-settings-plugin-inventory', disabled: true },
    { id: 'preset-ptc', disabled: true },
    { id: 'preset-minimal', disabled: true },
    { id: 'preset-cordis', disabled: true },
    { id: 'preset-standard', disabled: false },
    // The company wrapper calls the unchanged native reviewer exactly once, then fixes its mode.
    { id: 'auto-review', disabled: true },
    { id: 'deepseek-account', disabled: true },
    { id: 'account-controller', disabled: true },
    { id: 'llm', disabled: false },
    { id: 'web', disabled: false },
    { id: 'session', disabled: false },
    { id: 'config-editor', disabled: false },
    { id: 'hmr', disabled: false },
    { id: 'deepseek-llm-api-extensions', disabled: false },
    // Presets must not activate their filesystem providers before the company discovery policy exists.
    { id: 'agent-preset-registry', inject: ['rufaCompanyPolicy'] },
    { id: 'system-prompt', inject: ['rufaCompanyPolicy'] },
    { id: 'skill-filesystem', inject: ['rufaCompanyPolicy'] },
    { id: 'file-upload-ocr', inject: ['rufaCompanyPolicy'] },
    { id: 'workspace', inject: ['rufaProjectDirectories'] },
    { id: 'workspace-controller', inject: ['rufaWorkspaceReady', 'rufaProjectDirectories'] },
    { id: 'session-controller', inject: ['rufaStandardModeReady', 'rufaAutoReviewReady', 'rufaWorkspaceReady', 'rufaProjectDirectories'] },
    { insert: [
      { id: 'rufa-managed-policy', name: plugin('managed-policy.mjs'), config: { modelIds, defaultModelId: modelId,
        companyHome, skillsRoot: join(companyHome, 'skills'), agentsHome: join(companyHome, 'agent-context'),
        officePython: join(runtimeRoot, 'company-python/python.exe'),
        allowedBuiltinSkillDirs: [join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-agent-preset/skills')] } },
      { id: 'rufa-auto-review', name: plugin('company-auto-review.mjs'), config: {} },
      { id: 'rufa-computer-tasks', name: plugin('computer-tasks.mjs'), config: {} },
      { id: 'rufa-project-directories', name: plugin('company-project-directories.mjs'), config: {
        workspaceRoot: join(companyHome, 'workspaces'), accountHome: companyHome, privateRoot: dirname(dirname(companyHome)), runtimeRoot } },
      { id: 'rufa-file-versions', name: plugin('file-versions.mjs'), config: {
        accountHome: companyHome, privateRoot: dirname(dirname(companyHome)), runtimeRoot,
        pythonPath: join(runtimeRoot, 'company-python/python.exe') } },
      { id: 'rufa-company-badge', name: plugin('company-badge.mjs'), config: {
        pythonPath: join(runtimeRoot, 'company-python/python.exe'),
        helperPath: join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-skill-badge/assets/badge_metadata.py') } },
      { id: 'rufa-solidworks', name: plugin('solidworks-tools.mjs'), config: {
        companyHome, pythonPath: join(runtimeRoot, 'company-python/python.exe'),
        toolkitRoot: join(runtimeRoot, 'company-tools/solidworks') } },
      { id: 'rufa-work-preferences', name: plugin('company-preferences.mjs'), config: {} },
      { id: 'rufa-workspace', name: plugin('company-workspace.mjs'), config: { workspaceRoot: join(companyHome, 'workspaces/default'), projects: true } },
      { id: 'rufa-brand', name: plugin('brand/index.mjs'), config: { user } },
      { id: 'rufa-credentials', name: plugin('managed-credentials.mjs'), config: {} },
      { id: 'rufa-model', name: plugin('company-model.mjs'), config: {} },
      { id: 'rufa-persistence', name: plugin('remote-persistence.mjs'), config: {} },
      { id: 'rufa-web', name: plugin('company-web.mjs'), config: {} },
      ...(user?.role === 'admin' ? [{ id: 'rufa-admin-tools', name: plugin('admin-tools.mjs'), config: {} }] : []),
    ] },
  ];
}

export interface HarnessState { status: 'stopped' | 'starting' | 'running' | 'failed'; message?: string }
export class HarnessHost extends EventEmitter {
  #child: ChildProcess | null = null;
  #solidworksActive = false;
  #bridge: RuntimeBridge | null = null;
  #url: string | null = null;
  #starting: Promise<string> | null = null;
  #state: HarnessState = { status: 'stopped' };
  #versionRequests = new Set<() => void>();
  #preferences: PreferenceStore | null = null;
  #preferencesUnavailable = false;
  private readonly diagnostic: (text: string) => void;
  constructor(private readonly api: CompanyApi, private readonly config: { runtimeRoot: string; pluginRoot: string; userRoot: string; execPath: string; electronMode: boolean; legacyProjectAccountsRoot?: string; diagnostic?: (text: string) => void }) { super(); this.diagnostic = protectDiagnostic(config.diagnostic); }
  get state() { return { ...this.#state }; }
  async preferenceProjects(): Promise<PreferenceProject[]> {
    const child = this.#child;
    if (!child?.connected) throw new CompanyError('RUNTIME_STOPPED', '工作台尚未就绪，请稍候重试。');
    const requestId = randomUUID();
    return new Promise((resolveProjects, reject) => {
      const finish = (error?: Error, value?: PreferenceProject[]) => {
        clearTimeout(timer); child.removeListener('message', receive); child.removeListener('exit', exited);
        if (error) reject(error); else resolveProjects(value!);
      };
      const exited = () => finish(new Error('工作台已关闭。'));
      const receive = (message: unknown) => {
        const value = message as { type?: string; requestId?: string; ok?: boolean; projects?: PreferenceProject[] };
        if (value?.type !== 'rufa:preference-projects-result' || value.requestId !== requestId) return;
        if (this.#child !== child || !value.ok || !Array.isArray(value.projects)) { finish(new Error('无法读取当前账号项目。')); return; }
        finish(undefined, value.projects);
      };
      const timer = setTimeout(() => finish(new Error('读取项目超时，请重试。')), 10000);
      child.on('message', receive); child.once('exit', exited);
      child.send({ type: 'rufa:preference-projects', requestId }, error => { if (error) finish(error); });
    });
  }
  async preferences(action: string, input?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const store = this.#preferences;
    if (!store) throw new CompanyError('PREFERENCES_UNAVAILABLE', this.#preferencesUnavailable
      ? '本机工作偏好缓存暂不可用，原文件已保留。普通工作台仍可使用，请联系管理员修复缓存。' : '工作偏好尚未就绪，请稍候重试。');
    if (action === 'snapshot') {
      const projects = await this.preferenceProjects(); signal?.throwIfAborted();
      return { ...store.snapshot(), projects, ...store.history() };
    }
    if (action === 'mutate') return store.mutate(input, signal);
    if (action === 'history') return store.history();
    if (action === 'sync') { void store.sync().catch(() => {}); return store.snapshot(); }
    if (action === 'resolve') {
      const value = input as { id: string; choice: 'local' | 'cloud' };
      return store.resolveConflict(value?.id, value?.choice, signal);
    }
    throw new CompanyError('INVALID_REQUEST', '不支持这个工作偏好操作。');
  }
  cancelFileVersions() { for (const cancel of this.#versionRequests) cancel(); }
  async fileVersions(action: string, input: unknown, valid: () => boolean): Promise<unknown> {
    const child = this.#child;
    if (!child?.connected || this.#state.status !== 'running' || !valid()) throw new CompanyError('LOGIN_REQUIRED', '请在当前公司工作台操作。');
    const requestId = randomUUID();
    return new Promise((resolveResult, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return; settled = true;
        if (error && child.connected) child.send({ type: 'rufa:file-versions-cancel', requestId }, () => {});
        clearTimeout(timer); child.removeListener('message', onMessage); child.removeListener('exit', onExit);
        this.api.removeListener('change', onChange); this.#versionRequests.delete(cancel);
        if (error) reject(error); else resolveResult(value);
      };
      const cancel = () => finish(new CompanyError('LOGIN_CHANGED', '账号或工作台已变化，未完成的恢复已取消。'));
      const onChange = () => { if (this.#child !== child || !valid()) cancel(); };
      const onExit = () => finish(new CompanyError('RUNTIME_STOPPED', '工作台已关闭，请重新打开后查看文件版本。'));
      const onMessage = (message: unknown) => {
        const value = message as { type?: string; requestId?: string; checkId?: string; ok?: boolean; value?: unknown; error?: { message?: string } };
        if (value?.type === 'rufa:file-versions-check' && value.requestId === requestId && typeof value.checkId === 'string') {
          void Promise.resolve().then(async () => {
            if (settled || this.#child !== child || !valid()) return false;
            await this.api.verify();
            return !settled && this.#child === child && valid();
          }).catch(() => false).then(allowed => {
            if (child.connected) child.send({ type: 'rufa:file-versions-confirm', requestId, checkId: value.checkId, allowed }, () => {});
            if (!allowed) cancel();
          });
          return;
        }
        if (value?.type !== 'rufa:file-versions-result' || value.requestId !== requestId) return;
        if (this.#child !== child || !valid()) { finish(new CompanyError('LOGIN_CHANGED', '账号已变化，请重新打开文件版本。')); return; }
        if (value.ok) finish(undefined, value.value);
        else finish(new CompanyError('FILE_VERSIONS_FAILED', typeof value.error?.message === 'string' ? value.error.message : '文件版本暂不可用，请重试。'));
      };
      const timer = setTimeout(() => finish(new CompanyError('FILE_VERSIONS_TIMEOUT', '文件版本操作暂未完成，请稍后刷新核对。')), 60000);
      this.#versionRequests.add(cancel); this.api.on('change', onChange);
      child.on('message', onMessage); child.once('exit', onExit);
      child.send({ type: 'rufa:file-versions', requestId, action, input }, error => { if (error) finish(error); });
    });
  }
  async discardEmptySession(sessionId: string, confirm: () => Promise<boolean>): Promise<boolean> {
    const child = this.#child, epoch = this.api.authorizationEpoch;
    if (!child?.connected || this.#state.status !== 'running' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return false;
    const requestId = randomUUID();
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (deleted: boolean) => { settled = true; clearTimeout(timer); child.removeListener('message', onMessage); child.removeListener('exit', onExit); resolve(deleted); };
      const onExit = () => finish(false);
      const onMessage = (message: unknown) => {
        const value = message as { type?: string; requestId?: string; checkId?: string; deleted?: boolean };
        if (value?.type === 'rufa:discard-empty-check' && value.requestId === requestId && typeof value.checkId === 'string') {
          void Promise.resolve().then(confirm).catch(() => false).then(allowed => {
            if (child.connected) child.send({ type: 'rufa:discard-empty-confirm', requestId, checkId: value.checkId,
              allowed: allowed && !settled && this.#child === child && this.api.authorizationEpoch === epoch }, () => {});
          });
          return;
        }
        if (value?.type === 'rufa:discard-empty-result' && value.requestId === requestId) finish(value.deleted === true && this.#child === child && this.api.authorizationEpoch === epoch);
      };
      const timer = setTimeout(() => finish(false), 15000);
      child.on('message', onMessage); child.once('exit', onExit);
      child.send({ type: 'rufa:discard-empty', requestId, sessionId }, error => { if (error) finish(false); });
    });
  }
  private setState(status: HarnessState['status'], message?: string) { this.#state = { status, message }; this.emit('change', this.state); }
  async start(): Promise<string> {
    if (this.#url) return this.#url;
    if (this.#starting) return this.#starting;
    this.#starting = this.launch().finally(() => { this.#starting = null; });
    return this.#starting;
  }
  private async launch(): Promise<string> {
    await this.api.verify();
    const { user, deviceId } = this.api.state;
    if (!user || !deviceId) throw new CompanyError('LOGIN_REQUIRED', '请先登录。');
    const paths = await canonicalRuntimePaths(this.config);
    const root = paths.runtimeRoot;
    let cli = join(root, 'apps/cli/lib/bin.js');
    try { await access(cli); } catch {
      try {
        const manifest = JSON.parse(await readFile(join(root, 'rufa-runtime.json'), 'utf8'));
        if (!manifest.cli || manifest.cli.includes('..')) throw new Error('Invalid runtime manifest');
        cli = resolve(root, manifest.cli); await access(cli);
      } catch { throw new CompanyError('RUNTIME_MISSING', '完整 Harness 运行环境尚未安装，请联系管理员。'); }
    }
    const catalog = await this.api.json<ModelCatalog>('GET', '/models');
    if (!catalog.models.length) throw new CompanyError('NO_MODELS', '公司服务器尚未配置可用模型。');
    const account = accountRuntimePaths(paths.userRoot, this.api.state.serverUrl!, user.id);
    const { companyHome } = account;
    await prepareAccountDirectories(paths.userRoot, account);
    if (this.config.legacyProjectAccountsRoot) {
      const legacy = accountRuntimePaths(this.config.legacyProjectAccountsRoot, this.api.state.serverUrl!, user.id);
      const { migrateCompanyProjects } = await import(pathToFileURL(join(paths.pluginRoot, 'company-project-migration.mjs')).href);
      await migrateCompanyProjects({ sourceAccountHome: legacy.companyHome, targetAccountHome: companyHome,
        serverUrl: this.api.state.serverUrl!, userId: user.id, dryRun: false });
    }
    await initializeProfileDefaults(companyHome, root, catalog.models[0].id);
    await applyCompanyPreset(companyHome, root, catalog.models[0].id);
    await initializeDesktopVideoDefaults(companyHome, root);
    const epoch = this.api.authorizationEpoch, server = this.api.state.serverUrl!;
    // Packaged plugins live outside ASAR; use the canonical plugin root in both modes.
    this.#preferencesUnavailable = false;
    try {
    const validatePreferenceContent = await loadPreferenceValidator(paths.pluginRoot);
    this.#preferences = await PreferenceStore.open({ directory: companyHome, server, userId: user.id,
      valid: () => this.api.authorizationEpoch === epoch && this.api.state.user?.id === user.id && this.api.state.serverUrl === server && this.api.state.deviceId === deviceId,
      projects: () => this.preferenceProjects(), validateText: validatePreferenceContent,
      onChange: notice => this.emit('preferences-change', notice),
      fetch: async (method, path, body, signal) => {
        const response = await this.api.authorizedFetch(path, { method, signal,
          ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      } });
    } catch {
      if (this.api.authorizationEpoch !== epoch || this.api.state.user?.id !== user.id || this.api.state.serverUrl !== server) throw new CompanyError('LOGIN_CHANGED', '工作台打开期间账号已变化。');
      // Never overwrite a corrupt cache or block unrelated Harness features.
      this.#preferences = null; this.#preferencesUnavailable = true;
    }
    const overlayPath = await writeAccountOverlay(companyHome, enterpriseOverlay(paths.pluginRoot, catalog.models[0].id, catalog.models.map(model => model.id), { username: user.username, displayName: user.displayName, jobTitle: user.jobTitle, role: user.role }, companyHome, root));
    this.#bridge = new RuntimeBridge(this.api, user.role === 'admin' ? new AdminTools(this.api, {
      confirm: (approval, interaction) => confirmInChat(this.#child, approval, interaction),
    }) : undefined, this.#preferences ?? undefined); await this.#bridge.start(); this.#preferences?.start();
    this.setState('starting', '正在准备工作台…');
    const env = {
      ...sanitizedRuntimeEnvironment(process.env),
      PATH: `${join(root, 'company-python')}${delimiter}${dirname(paths.execPath)}${delimiter}${sanitizedRuntimeEnvironment(process.env).PATH ?? ''}`,
      DSH_HOME: companyHome, DSH_AGENTS_HOME: account.agentsHome, RUFA_RUNTIME_ROOT: root, RUFA_BRIDGE_ORIGIN: this.#bridge.origin,
      RUFA_BRIDGE_TOKEN: this.#bridge.token, RUFA_DEVICE_ID: deviceId,
      ...(this.config.electronMode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    };
    const child = spawn(paths.execPath, ['--expose-internals', cli, '--profile', 'web', '--patch', overlayPath, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: account.workspaceRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.#child = child;
    this.#solidworksActive = false;
    child.on('message', (message: unknown) => {
      const data = message as { type?: string; active?: boolean };
      if (this.#child === child && data?.type === 'rufa:solidworks-state' && typeof data.active === 'boolean') this.#solidworksActive = data.active;
    });
    child.on('exit', () => {
      if (this.#child === child) { this.#url = null; this.#child = null; this.#solidworksActive = false; if (this.#state.status !== 'stopped') this.setState('failed', '工作台已退出，请重新打开。'); }
    });
    try {
      const url = await new Promise<string>((resolveReady, reject) => {
        let output = '';
        const timer = setTimeout(() => { reject(new CompanyError('RUNTIME_TIMEOUT', 'Harness 启动超时。')); }, 90_000);
        const fail = () => { clearTimeout(timer); reject(new CompanyError('RUNTIME_START_FAILED', 'Harness 启动失败，请检查固定运行时及企业插件。')); };
        child.once('error', fail); child.once('exit', fail);
        child.stdout!.on('data', (chunk: Buffer) => {
          output = (output + chunk.toString('utf8')).slice(-16_384);
          const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/);
          if (match) { clearTimeout(timer); child.removeListener('error', fail); child.removeListener('exit', fail); resolveReady(match[1]); }
        });
        // Do not persist upstream diagnostics: arbitrary plugin errors may include environment or credentials.
        child.stderr!.on('data', (chunk: Buffer) => {
          this.diagnostic(chunk.toString('utf8').replaceAll(this.#bridge?.token ?? 'no-token', '[bridge-redacted]'));
        });
      });
      this.#url = url; this.setState('running'); return url;
    } catch (error) { await this.stop(); this.setState('failed', error instanceof CompanyError ? error.message : 'Harness 启动失败。'); throw error; }
  }
  async stop(): Promise<void> {
    this.cancelFileVersions();
    this.#url = null; this.setState('stopped');
    const child = this.#child, solidworksActive = this.#solidworksActive; this.#child = null; this.#solidworksActive = false;
    if (child && child.exitCode === null) {
      await new Promise<void>(resolveStopped => {
        let flushed = false, extended = solidworksActive, forced = false;
        const stoppingAt = Date.now();
        const forceStop = () => {
          forced = true;
          child.kill(); this.setState('stopped', extended
            ? 'Harness 已关闭；SolidWorks窗口交还或部分会话同步尚未确认，请核对可见模型及已保存文件。'
            : 'Harness 已关闭；部分事件可能尚未同步，重新登录同一账号后将尝试恢复。'); resolveStopped();
        };
        let timer = setTimeout(forceStop, extended ? 35_000 : 10_000);
        child.on('message', (message: unknown) => {
          const data = message as { type?: string; ok?: boolean; active?: boolean };
          this.diagnostic(`runtime IPC: ${String(data.type)} ${String(data.ok)}\n`);
          if (data.type === 'rufa:persistence-flushed') flushed = data.ok === true;
          if (data.type === 'rufa:solidworks-state' && data.active === true && !extended) {
            extended = true; clearTimeout(timer); timer = setTimeout(forceStop, Math.max(1, 35_000 - (Date.now() - stoppingAt)));
          }
        });
        child.once('exit', (code, signal) => {
          this.diagnostic(`runtime exit: ${code} ${signal}\n`);
          clearTimeout(timer);
          if (!flushed && !forced) this.setState('stopped', '退出时未确认全部会话同步，重新登录同一账号后将尝试恢复。');
          resolveStopped();
        });
        if (child.connected) child.send({ type: 'rufa:shutdown' }, () => {});
        else child.kill('SIGTERM');
      });
    }
    await this.#bridge?.stop(); this.#bridge = null;
    await this.#preferences?.close(); this.#preferences = null;
  }
}
