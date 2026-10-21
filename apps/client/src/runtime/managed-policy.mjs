// Company invariants around the original management services; ordinary plugin operations retain their native implementation.
import { resolve } from 'node:path';
import { companyPersonaPrefix } from './company-persona.mjs';
import { installStandardMode } from './standard-mode.mjs';
import { accountContext } from './account-context.mjs';
import { computerUseContext } from './computer-use-context.mjs';
import { computerTaskSession } from './computer-task-controller.mjs';
export const name = 'rufa-managed-policy';
const disabled = new Set(['credentials', 'llm-deepseek', 'llm-pi-ai', 'llm-deepseek-account', 'session-persistence-jsonl', 'web-search-deepseek', 'web-deepseek-api', 'session-log-deepseek', 'desktop-product-telemetry', 'product-analytics', 'ui-brand-official', 'ui-settings-models', 'ui-settings-account', 'deepseek-account', 'account-controller', 'ui-agent-preset', 'ui-settings-plugins', 'ui-settings-plugin-inventory', 'preset-ptc', 'preset-minimal', 'preset-cordis']);
const required = new Set(['llm', 'web', 'session', 'config-editor', 'hmr', 'deepseek-llm-api-extensions', 'plugin-manager', 'agent-preset-registry', 'preset-standard', 'workspace-controller', 'system-prompt', 'session-controller', 'auto-review', 'permission', 'approval']);
export const managedPlugin = id => typeof id === 'string' && (id.startsWith('rufa-') || disabled.has(id) || required.has(id));
const originalService = value => value[Symbol.for('cordis.original')] ?? value;
const reject = () => { throw new Error('此项由公司统一管理，不能修改公司模型、凭据或会话存储路径。'); };

export function isolatedSkillConfig(value = {}, config) {
  if (!config.skillsRoot || !config.companyHome || !config.agentsHome) throw new Error('Company skill directories are required.');
  const allowed = new Set((config.allowedBuiltinSkillDirs ?? []).map(path => resolve(path)));
  // Preserve explicitly mounted skills shipped with Rufajx-DSH, never ambient/shared agent roots.
  const bundled = (value.customSkillDirs ?? []).filter(path => typeof path === 'string' && allowed.has(resolve(path)));
  return { ...value, includeDefaultRoots: false, dshHome: config.companyHome, agentsHome: config.agentsHome,
    customSkillDirs: [config.skillsRoot, ...bundled], bundledSkillDir: undefined };
}

export function installManagementPolicy(manager, editor, config) {
  const originals = new Map();
  const wrap = (object, key, factory) => { const previous = object[key], replacement = factory(previous); originals.set(replacement, { object, key, previous }); object[key] = replacement; };
  const bundleManaged = bundle => (bundle.rows ?? []).some(row => required.has(row.rowId) || row.rowId?.startsWith('rufa-'));
  wrap(manager, 'listPlugins', previous => async function(...args) {
    return (await previous.apply(this, args)).map(row => managedPlugin(row.patchId) ? { ...row, readOnlyReason: 'management-required' } : row);
  });
  wrap(manager, 'listBundles', previous => async function(...args) {
    return (await previous.apply(this, args)).map(row => bundleManaged(row) ? { ...row, readOnlyReason: 'management-required', removable: false } : row);
  });
  // Native setPluginEnabled consults listPlugins, so its validation, transaction and failed result remain intact.
  wrap(manager, 'setBundleEnabled', previous => async function(name, enabled) {
    const row = (await this.listBundles()).find(item => item.name === name);
    if (row && bundleManaged(row)) return { stage: 'enable', target: name, enabled, changed: false, application: 'failed', error: { code: 'management-required' } };
    return previous.call(this, name, enabled);
  });
  wrap(editor, 'edit', previous => function(entry, change) {
    const id = entry.options.id;
    if (id?.startsWith('rufa-') || disabled.has(id) || ['auto-review', 'permission', 'approval'].includes(id)) return Promise.reject(new Error('此组件由公司统一管理。'));
    return previous.call(this, entry, (current, inherited) => {
      const next = change(current, inherited);
      if (id === 'agent-default-model' && (next.provider !== 'deepseek-official' || !config.modelIds.includes(next.model))) reject();
      return next;
    });
  });
  return () => { for (const [replacement, { object, key, previous }] of originals) if (object[key] === replacement) object[key] = previous; };
}

export function apply(ctx, config) {
  ctx.on('tools/execute', (execution, next) => {
    const protectedCall = ['write', 'edit', 'pwsh', 'bash', 'terminal_open', 'terminal_send', 'company_solidworks_run'].includes(execution.name)
      || execution.name === 'str_replace_editor' && execution.arguments?.command !== 'view'
      || execution.name === 'company_badge' && execution.arguments?.operation === 'stamp';
    if (execution.agent && protectedCall && !ctx.get('rufaFileVersions')?.active) throw new Error('文件版本保护尚未就绪，请稍后重试。');
    return next();
  }, { prepend: true, global: true });
  // Native Auto disposal temporarily falls back to full access. Never run a call in that transition.
  // Check again after downstream gates so a reload cannot authorize a call under an obsolete reviewer.
  ctx.on('tools/pre-execute', async function(execution, next) {
    if (!execution.agent) return next();
    if ((execution.name?.startsWith('mcp__wincu__windows_computer_use_') || computerTaskSession(execution.agent.session)) && !ctx.get('rufaComputerTasks')) return { kind: 'deny', reason: '电脑专用子任务服务尚未就绪，请稍后重试。' };
    const ready = ctx.get('rufaAutoReviewReady');
    const permitted = () => ready?.active && ctx.get('rufaAutoReviewReady') === ready
      && ctx.get('permissionPresets')?.current(execution.agent.session) === 'auto';
    if (!permitted()) return { kind: 'deny', reason: '公司自动审查尚未就绪，请稍后重试。' };
    const decision = await next();
    return permitted() ? decision : { kind: 'cancel' };
  }, { prepend: true, global: true });
  // Only these dedicated fields are enforced; font, theme, general preferences and reasoning effort stay editable.
  ctx.on('internal/config', function(raw, next) {
    const value = next();
    const id = this.entry?.options.id;
    if (id === 'system-prompt' || this.entry?.options.name === '@deepseek-ai/dsh-system-prompt') return { ...value, includeHarnessIdentity: false, personaPrefix: companyPersonaPrefix(value?.personaPrefix) };
    if (this.entry?.options.name === '@deepseek-ai/dsh-persona' || this.runtime?.name === 'persona') return { ...value, prefix: companyPersonaPrefix(value?.prefix) };
    if (this.entry?.options.name === '@deepseek-ai/dsh-skill-filesystem' || this.runtime?.name === 'skill-filesystem') return isolatedSkillConfig(value, config);
    if ((id === 'file-upload-ocr' || this.entry?.options.name === 'dsh-file-upload-ocr-plugin') && config.officePython) return { ...value, pythonCommand: config.officePython };
    if (id === 'agent-default-model') return { ...value, provider: 'deepseek-official', model: config.modelIds.includes(value.model) ? value.model : config.defaultModelId };
    return value;
  }, { global: true, prepend: true });
  // Explicit subagent personas can shadow preset rows without loading dsh-persona.
  // Keep their task instructions and the company role; complete presets already receive it through config above.
  ctx.on('system-prompt/assemble', async function(assembly, context, next) {
    const result = await next();
    const officeRuntime = config.officePython ? [{ name: 'company:office-runtime', order: 140, interpolate: false, text: `本机已预装办公文档处理环境。执行 Python 办公脚本时使用 ${JSON.stringify(config.officePython)}；工具的实际可用状态以当前工具和技能目录为准。` }] : [];
    return { ...result, contexts: [...result.contexts.filter(section => !['company:account', 'company:office-runtime', 'company:computer-use'].includes(section.name)), await accountContext(), ...officeRuntime,
      ...computerUseContext(result.tools)], sections: result.sections.map(section => section.name === 'deployment:persona-prefix'
      ? { ...section, text: companyPersonaPrefix(section.text) } : section) };
  }, { global: true });
  // The preset registry's Loader inject gate waits for this synchronous policy registration.
  ctx.provide('rufaCompanyPolicy', Object.freeze({ isolatedSkills: true }));
  ctx.inject(['agentPresets'], scoped => {
    scoped.effect(() => installStandardMode(originalService(scoped.agentPresets)));
    scoped.provide('rufaStandardModeReady', true);
  });
  ctx.inject(['pluginManager', 'configEditor'], scoped => {
    scoped.effect(() => installManagementPolicy(originalService(scoped.pluginManager), originalService(scoped.configEditor), config));
  });
}
