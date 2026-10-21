// Replays bounded company changes only onto the pinned, materialized Harness.
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rufaProjectRank, rufaOpenIndependent, rufaStartSession, rufaRestoreSelection, rufaProjectPickFlow, rufaProjectViewOptions } from '../src/runtime/projects-ui.mjs';

const marker = '// Rufajx projects v1';
const legacyPickFlowHashes = new Set([
  'd2f13f1fc1f64d20bc679537a880e56b036e02c63b19d70270b6efb8c035fd08',
  '9df75b2f6d77652c0b3f452c4f6b83e3d5a53161efc516f8bf6d6ac21d0c6aa2',
]);
const legacyProjectRank = `function rufaProjectRank(workspace, summaries) {
  return Math.max(Date.parse(workspace.updatedAt || workspace.createdAt) || 0,
    ...workspace.sessionIds.map(id => summaries[id]?.updatedAt ?? 0));
}`;
const withIntegrity = source => `${source}\n// Rufajx projects integrity: ${createHash('sha256').update(source).digest('hex')}\n`;
function exact(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Pinned projects anchor changed: ${before.slice(0, 100)}`);
  return source.replace(before, () => after);
}
function section(source, start, end, replacement) {
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error(`Pinned projects section changed: ${start}`);
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  if (to < from) throw new Error('Project section anchors are out of order');
  return source.slice(0, from) + replacement + source.slice(to);
}
const method = (fn, name) => fn.toString().replace(/^(async )?function \w+/, (_, async) => `${async ?? ''}${name}`);
function upgradeReferences(source, kind) {
  if (kind === 'host-codec' || kind === 'remote-codec') {
    for (const [suffix, object] of [['', 'object'], ['_strict', 'strictObject']]) {
      const prefix = `_deepseek_ai_dsh_api_workspace_controller_workspace_create_parameter_0${suffix}$schema`;
      const before = `const ${prefix} = () => (${prefix}$value ??= z.${object}({\n  'path': z.string().readonly(),\n  'title': z.string().min(1).max(100).readonly(),\n}))`;
      const after = before.replace("  'title':", "  'referencePaths': z.array(z.string()).max(31).readonly().optional(),\n  'title':");
      if (!source.includes(after)) source = exact(source, before, after);
    }
    for (const strict of [true, false]) {
      const properties = { path: { type: 'string' }, title: { type: 'string', minLength: 1, maxLength: 100 } };
      const before = JSON.stringify({ type: 'object', properties, required: ['path', 'title'], additionalProperties: strict });
      const after = JSON.stringify({ type: 'object', properties: { ...properties, referencePaths: { type: 'array', items: { type: 'string' }, maxItems: 31 } }, required: ['path', 'title'], additionalProperties: strict });
      if (!source.includes(after)) source = exact(source, before, after);
    }
  } else if (kind === 'remotes-browser') {
    for (const [suffix, object] of [['', 'object'], ['_strict', 'strictObject']]) {
      const prefix = `_deepseek_ai_dsh_api_workspace_controller_workspace_create_parameter_0${suffix}$schema`;
      const before = `const ${prefix} = () => ${prefix}$value ??= zod.z.${object}({ "path": zod.z.string().readonly(), "title": zod.z.string().min(1).max(100).readonly() });`;
      const after = before.replace(' });', ', "referencePaths": zod.z.array(zod.z.string()).max(31).readonly().optional() });');
      if (!source.includes(after)) source = exact(source, before, after);
    }
    const from = source.indexOf('"workspace/create": {'), to = source.indexOf('"workspace/delete": {', from);
    if (from < 0 || to < from) throw new Error('Workspace reference codec metadata anchors changed');
    let block = source.slice(from, to);
    const before = '"properties": { "path": { "type": "string" }, "title": { "type": "string", "minLength": 1, "maxLength": 100 } },';
    const after = '"properties": { "path": { "type": "string" }, "title": { "type": "string", "minLength": 1, "maxLength": 100 }, "referencePaths": { "type": "array", "items": { "type": "string" }, "maxItems": 31 } },';
    if (!block.includes(after)) {
      if (block.split(before).length !== 3) throw new Error('Workspace reference codec metadata changed');
      block = block.replaceAll(before, after);
    } else if (block.split(after).length !== 3) throw new Error('Workspace reference codec metadata incomplete');
    source = source.slice(0, from) + block + source.slice(to);
  }
  return source;
}

export function patchProjectSource(input, kind) {
  // The integrity trailer makes replays reject partial edits. Other company
  // patches run first and are already idempotent on this materialized file.
  const trailer = /\n\/\/ Rufajx projects integrity: ([a-f0-9]{64})\n?$/;
  if (input.includes(marker)) {
    const match = input.match(trailer); let body = match && input.slice(0, match.index);
    if (!match || createHash('sha256').update(body).digest('hex') !== match[1]) throw new Error('Company projects patch is incomplete or modified');
    if (kind === 'browser') {
      const start = 'function rufaProjectRank(workspace, summaries) {', end = '\nfunction WorkspaceBrowser({';
      if (body.split(start).length !== 2 || body.split(end).length !== 2) throw new Error('Company project activity rank anchors changed');
      const from = body.indexOf(start), to = body.indexOf(end, from);
      if (to < from) throw new Error('Company project activity rank anchors are out of order');
      const previous = body.slice(from, to), normalized = previous.replaceAll('\r\n', '\n');
      const current = rufaProjectRank.toString().replaceAll('\r\n', '\n');
      if (normalized !== current) {
        if (normalized !== legacyProjectRank.replaceAll('\r\n', '\n')) throw new Error('Unknown company project activity rank implementation');
        body = body.slice(0, from) + current + body.slice(to);
      }
      const flowStart = 'function WorkspacePickFlow({', flowEnd = '\n\n\t\t/**\n\t\t* The conversation empty-state registration:';
      if (body.split(flowStart).length !== 2 || body.split(flowEnd).length !== 2) throw new Error('Company project dialog anchors changed');
      const flowFrom = body.indexOf(flowStart), flowTo = body.indexOf(flowEnd, flowFrom);
      const oldFlow = body.slice(flowFrom, flowTo).replaceAll('\r\n', '\n');
      const newFlow = rufaProjectPickFlow.toString().replace('rufaProjectPickFlow', 'WorkspacePickFlow').replaceAll('\r\n', '\n');
      if (oldFlow !== newFlow) {
        if (!legacyPickFlowHashes.has(createHash('sha256').update(oldFlow).digest('hex'))) throw new Error('Unknown company project dialog implementation');
        body = body.slice(0, flowFrom) + newFlow + body.slice(flowTo);
      }
    }
    body = upgradeReferences(body, kind);
    return body === input.slice(0, match.index) ? input : withIntegrity(body);
  }
  let source = input.replaceAll('\r\n', '\n');
  if (kind === 'session') {
    source = exact(source, 'const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd;',
      'const rufaDirectories = this.ctx.get("rufaProjectDirectories");\nif (!rufaDirectories) throw new Error("公司项目目录服务尚未就绪。");\nconst cwd = workspace?.path ?? request.cwd ?? await rufaDirectories.allocateSessionDirectory();');
  } else if (kind === 'registry') {
    source = exact(source, 'if (path === void 0) continue;\n\t\t\tconst group = groupsByPath.get(path);',
      'if (path === void 0 || this.ctx.get("rufaProjectDirectories")?.isSessionDirectory(path)) continue;\n\t\t\tconst group = groupsByPath.get(path);');
  } else if (kind === 'controller') {
    source = exact(source, 'const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path);',
      `const rufaDirectories = this.ctx.get("rufaProjectDirectories");
      if (!rufaDirectories) throw new Error("公司项目目录服务尚未就绪。");
      if (rufaDirectories) {
        const workspace = await rufaDirectories.createProject(request, this.ctx.workspaceRegistry);
        return { workspace: workspaceView(workspace), created: true };
      }
      const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path);`);
  } else if (kind === 'host-codec' || kind === 'remote-codec') {
    for (const [suffix, object] of [['', 'object'], ['_strict', 'strictObject']]) {
      const prefix = `_deepseek_ai_dsh_api_workspace_controller_workspace_create_parameter_0${suffix}$schema`;
      source = exact(source, `const ${prefix} = () => (${prefix}$value ??= z.${object}({\n  'path': z.string().readonly(),\n}))`,
        `const ${prefix} = () => (${prefix}$value ??= z.${object}({\n  'path': z.string().readonly(),\n  'title': z.string().min(1).max(100).readonly(),\n}))`);
    }
    for (const strict of [true, false]) {
      const before = JSON.stringify({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: strict });
      const after = JSON.stringify({ type: 'object', properties: { path: { type: 'string' }, title: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['path', 'title'], additionalProperties: strict });
      source = exact(source, before, after);
    }
  } else if (kind === 'remotes-browser') {
    for (const [suffix, object] of [['', 'object'], ['_strict', 'strictObject']]) {
      const prefix = `_deepseek_ai_dsh_api_workspace_controller_workspace_create_parameter_0${suffix}$schema`;
      source = exact(source, `const ${prefix} = () => ${prefix}$value ??= zod.z.${object}({ "path": zod.z.string().readonly() });`,
        `const ${prefix} = () => ${prefix}$value ??= zod.z.${object}({ "path": zod.z.string().readonly(), "title": zod.z.string().min(1).max(100).readonly() });`);
    }
    const start = '"workspace/create": {', end = '"workspace/delete": {';
    const from = source.indexOf(start), to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error('Workspace codec metadata anchors changed');
    let block = source.slice(from, to);
    const properties = '"properties": { "path": { "type": "string" } },';
    if (block.split(properties).length !== 3 || block.split('"required": ["path"],').length !== 3) throw new Error('Workspace codec metadata changed');
    block = block.replaceAll(properties, '"properties": { "path": { "type": "string" }, "title": { "type": "string", "minLength": 1, "maxLength": 100 } },')
      .replaceAll('"required": ["path"],', '"required": ["path", "title"],');
    source = source.slice(0, from) + block + source.slice(to);
  } else if (kind === 'browser') {
    source = exact(source, 'openWorkspace(workspaceId, beforeOpen, options = {}) {',
      'openWorkspace(workspaceId, beforeOpen, options = {}) {\nif (workspaceId === void 0) return this.rufaOpenIndependent(options, beforeOpen);');
    source = exact(source, 'sessionId = await this.connectBlank(workspaceId, reuse);',
      'sessionId = await this.sessions.create({ workspaceId, ...(reuse?.agentPreset === void 0 ? {} : { agentPreset: reuse.agentPreset }) });');
    source = exact(source, 'if (session.blank && session.id !== current) return false;',
      '// Company independent blanks remain addressable so unsent drafts can be reopened.');
    source = section(source, 'startSession(workspaceId, options) {', '\n\t\t\tprepareDraft(binding, options) {',
      `${method(rufaOpenIndependent, 'rufaOpenIndependent')}\n${method(rufaStartSession, 'startSession')}`);
    source = section(source, 'async restoreSelection(workspaces, sessions) {', '\n\t\t\tasync initializeDefaultWorkspace(signal) {',
      method(rufaRestoreSelection, 'restoreSelection'));
    source = section(source, 'function WorkspacePickFlow({', '\n\t\t/**\n\t\t* The conversation empty-state registration:',
      `${rufaProjectPickFlow.toString().replace('rufaProjectPickFlow', 'WorkspacePickFlow')}\n`);
    source = section(source, 'function ViewOptionsMenu({', '\n\t\t/** Apply a visible drop to the complete account',
      `${rufaProjectViewOptions.toString().replace('rufaProjectViewOptions', 'ViewOptionsMenu')}\n`);
    source = exact(source, 'function WorkspaceBrowser({', `${rufaProjectRank}\nfunction WorkspaceBrowser({`);
    source = exact(source, 'persist: "dsh.workspace.view.v5",', 'persist: "rufa.projects.view.v1",');
    source = exact(source, 'const groupBy = useStore((s) => s.groupBy);', 'const groupBy = "workspace";');
    source = exact(source, 'const orderBy = useStore((s) => s.orderBy);', 'const orderBy = "updated";');
    source = exact(source, ')), [storedWorkspaces, defaultWorkspaceName]);',
      ')).sort((a, b) => rufaProjectRank(b, list.byId) - rufaProjectRank(a, list.byId) || a.workspaceId.localeCompare(b.workspaceId)), [storedWorkspaces, defaultWorkspaceName, list.byId]);');
    source = exact(source, 'if (current === void 0 || currentGroup === void 0 || Object.hasOwn(groupExpansion, currentGroup)) return;',
      'if (currentGroup !== "" || current === void 0 || Object.hasOwn(groupExpansion, currentGroup)) return;');
    source = exact(source, '.filter((key) => groupExpansion[key] ?? ancestorKeys.has(key));',
      '.filter((key) => key === "" || (groupExpansion[key] ?? false));');
    source = exact(source, 'sectionMembers(g.sessions, pinned, archived).map((session) => sessionNode(session, list, statuses, pinned, archived))',
      '[...g.sessions].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map((session) => sessionNode(session, list, statuses, pinned, archived))');
    source = exact(source, 'const rootGroups = childrenByParent.get(void 0) ?? [];',
      `const [rufaAllProjects, setRufaAllProjects] = (0, react.useState)(false);
      const rufaRootGroups = childrenByParent.get(void 0) ?? [];
      const rufaProjects = rufaRootGroups.filter(group => group.workspaceId !== void 0);
      const rootGroups = [...(rufaAllProjects ? rufaProjects : rufaProjects.slice(0, 3)), ...rufaRootGroups.filter(group => group.workspaceId === void 0)];`);
    source = exact(source, 'rowKeys.push(`workspace:${group.key}`);', 'if (workspaceId !== void 0) rowKeys.push(`workspace:${group.key}`);');
    source = exact(source, 'style: { "--dsh-workspace-indent": `${depth * 12}px` },',
      `style: { "--dsh-workspace-indent": (depth * 12) + "px" },
      "data-rufa-project-id": workspaceId,
      "data-rufa-unassigned-sessions": workspaceId === void 0 ? "" : void 0,`);
    source = exact(source, '(0, react_jsx_runtime.jsx)(ProjectRowItem, {', 'workspaceId !== void 0 && (0, react_jsx_runtime.jsx)(ProjectRowItem, {');
    source = exact(source, 'drag: workspaceDragProps,', 'drag: void 0,');
    source = exact(source, 'drag: dragProps,', 'drag: void 0,');
    source = exact(source, '"data-row-key": `session:${node.id}`,', '"data-row-key": `session:${node.id}`, "data-rufa-session-id": node.id,');
    source = exact(source, 'const groupRows = rootGroups.map((group) => renderGroup(group, 0));',
      `const groupRows = [];
      for (const group of rootGroups.filter(group => group.workspaceId !== void 0)) groupRows.push(renderGroup(group, 0));
      if (rufaProjects.length > 3) {
        rowKeys.push("rufa-more-projects");
        groupRows.push((0, react_jsx_runtime.jsx)("button", { type: "button", className: "rufa-more-projects",
          "data-row-key": "rufa-more-projects", "data-rufa-more-projects": "", "aria-expanded": rufaAllProjects,
          onClick: () => setRufaAllProjects(value => !value), children: rufaAllProjects ? "收起项目" : "更多项目（" + (rufaProjects.length - 3) + "）" }, "rufa-more-projects"));
      }
      for (const group of rootGroups.filter(group => group.workspaceId === void 0)) groupRows.push(renderGroup(group, 0));`);
    source = exact(source, '"aria-label": t("workspace.add"),', '"aria-label": t("workspace.add"), "data-rufa-create-project": "",');
    source = exact(source, 'ctx.locale.register(NS, {\n\t\t\t\tzh,\n\t\t\t\ten\n\t\t\t})',
      'ctx.locale.register(NS, { zh: Object.fromEntries(Object.entries(zh).map(([key, value]) => [key, value.replaceAll("工作区", "项目")])), en })');
  } else if (kind === 'conversation') {
    source = exact(source, 'const inert = sessionId === void 0 || hero && chipTitle === void 0;',
      'const inert = sessionId === void 0 || hero && chipTitle === void 0 && (cwd === void 0 || cwd === "");');
    source = exact(source, '"hero.chooseWorkspace": "选择工作区",', '"hero.chooseWorkspace": "选择项目",');
    source = exact(source, '"aria-label": t("hero.chooseWorkspace"),', '"aria-label": t("hero.chooseWorkspace"), "data-rufa-project-picker": "",');
    source = exact(source, 'children: label ?? t("hero.chooseWorkspace")', 'children: label ?? "无项目"');
  } else throw new Error(`Unknown projects patch: ${kind}`);
  source = `${marker}\n${upgradeReferences(source, kind)}`;
  return withIntegrity(source);
}

export async function patchProjectsRuntime(runtimeRoot) {
  const root = resolve(runtimeRoot), manifest = JSON.parse(await readFile(join(root, 'rufa-runtime.json'), 'utf8'));
  if (manifest.upstreamCommit !== '687f282e8625c6b8d11ff58211a90524be2e4317') throw new Error('Unsupported projects Harness revision');
  const files = [
    ['session', '@deepseek-ai/dsh-api-session-controller/lib/index.js'],
    ['controller', '@deepseek-ai/dsh-api-workspace-controller/lib/index.js'],
    ['registry', '@deepseek-ai/dsh-workspace/lib/index.js'],
    ['host-codec', '@deepseek-ai/dsh-api-workspace-controller/lib/typert.host.js'],
    ['remote-codec', '@deepseek-ai/dsh-api-workspace-controller/lib/typert.remote-client.js'],
    ['remotes-browser', '@deepseek-ai/dsh-api-remotes/lib/client.js'],
    ['browser', '@deepseek-ai/dsh-client-ui-workspace/lib/client.js'],
    ['conversation', '@deepseek-ai/dsh-client-ui-conversation/lib/client.js'],
  ];
  // Validate every anchor before writing any file; atomic rename breaks hardlinks.
  const edits = await Promise.all(files.map(async ([kind, relative]) => {
    const path = join(root, 'node_modules', relative), source = await readFile(path, 'utf8');
    return { path, source, patched: patchProjectSource(source, kind) };
  }));
  for (const { path, source, patched } of edits) if (source !== patched) {
    const temporary = `${path}.${randomUUID()}.pending`;
    try { await writeFile(temporary, patched, { flag: 'wx' }); await rename(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { projects: 1, files: files.length };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(await patchProjectsRuntime(process.argv[2])));
