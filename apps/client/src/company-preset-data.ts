/** Reviewed, non-personal snapshot of the administrator's 2026-10-19 preset.
 * Values are shipped with the client; no account file is used as a template.
 * Missing ordinary values below were checked against the pinned native schema
 * AND bundle layer (for example Bash 60s and Agent Team maxMembers 8).
 * Network, identity, permissions, executable paths and task data are excluded.
 */
export const companyPresetVersion = 'admin-defaults-20261019-v1';
export const companyPresetMarker = '.rufa-admin-preset-v1.json';
export const companyPresetDirectory = '.rufa-admin-preset-v1';
export const companyPresetBundles = [
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-session-titles-bundle', '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-session-search', '@rufa/dsh-office-bundle', '@rufa/dsh-read-pdf-bundle',
  'dsh-file-upload-ocr-plugin', 'dsh-better-sidebar', 'dsh-video-preview',
  '@huanlin/dsh-plugin-better-sidebar-plugin-audio', '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
] as const;
/** Only these shipped optional bundles are known to be off in the snapshot.
 * Unknown, external and future bundle names are never removed by this migration.
 */
export const companyPresetDisabledBundles = [
  '@deepseek-ai/dsh-experimental-inspector-profile', '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle', '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-tool-worktree', '@deepseek-ai/dsh-experimental-voice-input-bundle',
] as const;

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
export interface PresetRow {
  id: string; name: string; config?: Record<string, Value>; unset?: string[];
  /** Remove an old account override, restoring the bundle's native enable guard. */
  restoreEnabled?: boolean;
}
const native = (name: string) => `@deepseek-ai/${name}`;
export const companyPresetRows: readonly PresetRow[] = [
  { id: 'agent-default-model', name: native('dsh-agent-default-model'), config: { reasoningEffort: 'low' } },
  { id: 'ui-theme', name: native('dsh-client-ui-theme'), restoreEnabled: true, config: {
    preference: 'dark', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
    textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
  } },
  // The native automatic locale is represented by absence, not an invented 'auto' locale.
  { id: 'locale', name: native('dsh-client-locale'), restoreEnabled: true, unset: ['preference'] },
  { id: 'ui-settings', name: native('dsh-client-ui-settings'), restoreEnabled: true, config: { enabled: true } },
  { id: 'ui-conversation', name: native('dsh-client-ui-conversation'), restoreEnabled: true, config: { busyEnter: 'queue' } },
  { id: 'ui-chat', name: native('dsh-client-ui-chat'), restoreEnabled: true, config: {
    transcriptView: 'detailed', collapseTiming: 'completion', performanceUsage: 'detailed', linkOpening: 'sidebar',
  } },
  { id: 'shortcuts', name: native('dsh-client-shortcuts'), restoreEnabled: true, config: { stopSequenceMs: 500 } },
  { id: 'cot-translation', name: native('dsh-experimental-client-ui-cot-translation'), restoreEnabled: true,
    config: { provider: 'bing', targetLanguage: 'auto' } },
  { id: 'translator', name: native('dsh-experimental-translator'), restoreEnabled: true, config: {
    timeoutMs: 10000, maxTextChars: 4000, maxResponseBytes: 1048576, deepseekTimeoutMs: 60000, deepseekMaxOutputTokens: 8192,
  } },
  { id: 'agent-loop', name: native('dsh-agent-loop'), config: { maxParallelToolCalls: 10 } },
  { id: 'subagent', name: native('dsh-subagent'), config: { maxDepth: 1, maxActiveSubagents: 8 } },
  { id: 'subagent-model-selection-settings', name: native('dsh-tool-subagent/model-selection-settings'),
    config: { enabled: false, allowedModels: [] } },
  // Preserve each account's cwd/executable settings and the platform-specific disabled guard.
  { id: 'bash-sandbox', name: native('dsh-bash-sandbox'), config: {
    timeoutMs: 60000, maxTimeoutMs: 600000, maxOutputBytes: 64000, maxSpillBytes: 67108864, graceMs: 3000,
  } },
  { id: 'pwsh-sandbox', name: native('dsh-pwsh-sandbox'), config: {
    timeoutMs: 120000, maxTimeoutMs: 600000, maxOutputBytes: 64000, maxSpillBytes: 67108864, graceMs: 3000,
  } },
  { id: 'session-title', name: native('dsh-session-title'), config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } },
  { id: 'optional-session-title-all-prompts', name: native('dsh-session-title-all-prompts-llm'), restoreEnabled: true, config: {
    targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000,
  } },
  { id: 'pdf-reader', name: '@rufa/dsh-read-pdf-bundle', restoreEnabled: true, config: { dpi: 200, timeoutMs: 120000 } },
  { id: 'file-upload-ocr', name: 'dsh-file-upload-ocr-plugin', restoreEnabled: true, config: {
    maxFileBytes: 26214400, maxPages: 50, dpi: 144, nativeTextMinChars: 24, timeoutMs: 120000, maxOutputChars: 200000,
  } },
  { id: 'better-sidebar', name: 'dsh-better-sidebar', restoreEnabled: true, config: {
    listLimit: 1000, autoOpenSubagent: true, autoOpenJobs: true, tasksViewMode: 'graph',
    mobileNoAutoOpen: true, mobileDefaultTree: true, agentOpenTools: true, editorExplorer: false,
    editorGitGutter: true, explorerExclude: ['.DS_Store', 'Thumbs.db'], customCss: '',
    htmlViewerNoSandbox: false, htmlViewerDefaultUnsafe: false,
    tabsEnabled: { editor: true, subagent: true, sidechat: true, git: false, 'terminal-bottom': false, diff: false },
    viewersEnabled: { markdown: true, html: true, jsonl: true, code: true, 'dsh-audio-preview:audio': true, video: true },
    pluginSettings: { editor: { openWithPluginTargets: false } },
  } },
  { id: 'agent-team', name: native('dsh-experimental-agent-team'), restoreEnabled: true,
    config: { maxMembers: 8, maxTasks: 256, maxMessageBytes: 65536, disposalTimeoutMs: 5000 } },
  { id: 'tool-agent-team', name: native('dsh-experimental-tool-agent-team'), restoreEnabled: true, config: { interrupt: true } },
  { id: 'office-to-pdf', name: native('dsh-office-to-pdf'), restoreEnabled: true, config: {
    maxConcurrentConversions: 2, maxQueuedJobs: 8, maxReaders: 32, maxSourceBytes: 104857600,
    maxBackgroundConversions: 1, maxCachedEntries: 8, maxCachedBytes: 134217728, maxSourceEntries: 64,
    timeoutMs: 60000, maxInputBytes: 52428800, maxOutputBytes: 104857600, maxImageResolution: 192,
    maxArchiveEntries: 10000, maxUncompressedBytes: 262144000, maxFontFiles: 20000,
    maxFontFileBytes: 268435456, maxLoadedFontBytes: 536870912,
  } },
  { id: 'ui-sidebar-documentpreview', name: native('dsh-client-ui-sidebar-documentpreview'), restoreEnabled: true, config: {
    office: { maxCachedEntries: 8, maxCachedBytes: 67108864, maxPending: 8, maxReaders: 32 },
    excel: { maxBytes: 16777216, maxCells: 250000, timeoutMs: 15000 },
  } },
  ...[
    ['skill-office', native('dsh-skill-office')], ['skill-badge', native('dsh-skill-badge')],
    ['video-preview', 'dsh-video-preview'], ['better-sidebar-audio', '@huanlin/dsh-plugin-better-sidebar-plugin-audio'],
    ['ui-agent-team', native('dsh-experimental-client-ui-agent-team')], ['optional-session-search', 'cordis:group'],
  ].map(([id, name]) => ({ id, name, restoreEnabled: true })),
];

/** Immutable at runtime too; a plugin cannot modify the shipped next-account preset. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
freeze(companyPresetRows); freeze(companyPresetBundles); freeze(companyPresetDisabledBundles);
