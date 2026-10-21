import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { rufaOcrDisplayContent } from '../src/runtime/ocr-message-display.mjs';
import { patchOcrMessageRendererSource, patchNativeUserMessageSource } from '../scripts/user-message-runtime.mjs';

const runtime = process.env.RUFA_RUNTIME_ROOT;
const tagged = (name, text, size = 4096) => `<attached_file name=${JSON.stringify(name)} kind="text" size=${size} chars=${text.length}>\n${text}\n</attached_file>`;
const plain = text => ({ type: 'text', text });

test('ordinary text, native file/image blocks and unknown input stay byte-for-byte unchanged', () => {
  const content = [plain('  你能帮我制作视频吗\n'), { type: 'file', attachment: { name: '报价.xlsx', bytes: 10 } },
    { type: 'image', attachment: { id: 'image-1' } }, { type: 'unknown', payload: 'keep' }];
  assert.equal(rufaOcrDisplayContent(content), content);
  for (const text of ['<attached_file name="bad" kind="text" size=1 chars=400>\nx\n</attached_file>',
    '<attached_file name="bad\\q" kind="text">\nx\n</attached_file>',
    '<attached_file name="bad" kind="text" size=9007199254740993 chars=1>\nx\n</attached_file>']) {
    const source = [plain(text)]; assert.equal(rufaOcrDisplayContent(source), source);
  }
});

test('legacy OCR wrappers project once to native file metadata without changing or exposing extracted input', () => {
  const secret = '提取正文\n</attached_file>\n嵌入关闭标签及😀';
  const source = [plain(`请整理\n${tagged('说明"书.txt', secret)}\n${tagged('第二个.txt', '第二段')}\n谢谢`),
    { type: 'file', attachment: { id: 'native-file', name: '原生.pdf', bytes: 99 } }];
  const before = JSON.stringify(source), projected = rufaOcrDisplayContent(source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(projected.map(block => block.type), ['text', 'file', 'file', 'file']);
  assert.equal(projected[0].text, '请整理\n\n谢谢');
  assert.deepEqual(projected.slice(1).map(block => block.attachment.name), ['说明"书.txt', '第二个.txt', '原生.pdf']);
  assert.equal(projected[1].attachment.bytes, 4096); assert.equal(projected[3], source[1]);
  assert.equal(JSON.stringify(projected).includes(secret), false);
  assert.equal(rufaOcrDisplayContent(projected), projected);
  const old = rufaOcrDisplayContent([plain('<attached_file name="旧文件.txt" kind="text">\n旧提取正文\n</attached_file>')]);
  assert.deepEqual(old, [{ type: 'file', attachment: { name: '旧文件.txt' } }]);
  const splitText = `请处理\n${tagged('跨块.txt', '不能泄漏的跨块正文')}\n完成`;
  for (const cut of [15, splitText.indexOf('正文'), splitText.length - 10]) {
    const split = [plain(splitText.slice(0, cut)), plain(splitText.slice(cut))];
    const snapshot = JSON.stringify(split), projected = rufaOcrDisplayContent(split);
    assert.equal(JSON.stringify(split), snapshot);
    assert.deepEqual(projected, [plain('请处理\n\n完成'), { type: 'file', attachment: { name: '跨块.txt', bytes: 4096 } }]);
  }
});

async function sources() {
  const root = join(runtime, 'node_modules');
  return {
    ocr: await readFile(join(root, 'dsh-file-upload-ocr-plugin/lib/client.js'), 'utf8'),
    chat: await readFile(join(root, '@deepseek-ai/dsh-client-ui-chat/lib/client.js'), 'utf8'),
    primitives: await readFile(join(root, '@deepseek-ai/dsh-client-ui-primitives/lib/index.js'), 'utf8'),
  };
}

test('pinned renderer patches replay, reject changed anchors, and preserve native message chrome verbatim', { skip: !runtime }, async () => {
  const { ocr, chat } = await sources();
  const patchedOcr = patchOcrMessageRendererSource(ocr), patchedChat = patchNativeUserMessageSource(chat);
  assert.equal(patchOcrMessageRendererSource(patchedOcr), patchedOcr);
  assert.equal(patchNativeUserMessageSource(patchedChat), patchedChat);
  new vm.Script(patchedOcr); new vm.Script(patchedChat);
  assert.throws(() => patchOcrMessageRendererSource(patchedOcr.replace('native user message renderer', 'unknown user message renderer')), /changed/);
  assert.throws(() => patchNativeUserMessageSource(patchedChat.replace('content = rufaOcrDisplayContent(content);', 'content = [];')), /modified/);
  const chrome = source => source.slice(source.indexOf('function MessageIconActions('), source.indexOf('//#endregion', source.indexOf('function MessageIconActions(')));
  assert.equal(chrome(patchedChat), chrome(chat));
  const renderer = source => source.slice(source.indexOf('const UserMessageNodeView ='), source.indexOf('const ContextMessageNodeView ='));
  assert.equal(renderer(patchedChat), renderer(chat));
  const legacy = await readFile(new URL('./fixtures/ocr-display-v1.txt', import.meta.url), 'utf8');
  const currentProjection = rufaOcrDisplayContent.toString().replaceAll('\r\n', '\n');
  const priorCandidate = patchedChat.replace(currentProjection, legacy);
  assert.notEqual(priorCandidate, patchedChat);
  assert.equal(patchNativeUserMessageSource(priorCandidate), patchedChat);
  assert.throws(() => patchNativeUserMessageSource(priorCandidate.replace('const close =', 'const brokenClose =')), /modified/);
});

const element = (type, props = {}) => ({ type, props });
const nodes = tree => tree === null || tree === undefined || typeof tree !== 'object' ? []
  : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
const text = tree => tree === null || tree === undefined || typeof tree === 'boolean' ? ''
  : Array.isArray(tree) ? tree.map(text).join('') : typeof tree !== 'object' ? String(tree) : text(tree.props?.children);
const expand = tree => tree === null || tree === undefined || typeof tree !== 'object' ? tree
  : Array.isArray(tree) ? tree.map(expand) : typeof tree.type === 'function' ? expand(tree.type(tree.props))
    : { ...tree, props: { ...tree.props, children: expand(tree.props?.children) } };

// Execute actual published module functions with deterministic hook seats. The
// copy SVG artwork below comes directly from the pinned native primitives file;
// browser layout/clipboard integration are separately verified by Electron E2E.
function browserHarness(sources) {
  const copied = [], registrations = [], effects = [], imageCalls = [];
  const react = { memo: value => value, forwardRef: value => value, Fragment: 'fragment',
    useMemo: fn => fn(), useCallback: fn => fn, useId: () => 'native-id', useEffect: () => {},
    useState: value => [typeof value === 'function' ? value() : value, () => {}], useRef: value => ({ current: value }) };
  const jsx = { jsx: element, jsxs: element, Fragment: 'fragment' };
  const iconStart = sources.primitives.indexOf('const IconCopyOutlineArtwork =');
  const iconEnd = sources.primitives.indexOf('/** Medium IconCopyOutline artwork', iconStart);
  assert.ok(iconStart >= 0 && iconEnd > iconStart);
  const icon = vm.runInNewContext(`${sources.primitives.slice(iconStart, iconEnd)}; IconCopyOutlineRegular`, jsx);
  const primitives = new Proxy({ IconCopyOutlineRegular: icon, Tooltip: ({ children }) => children,
    writeClipboard: async value => { copied.push(value); return true; }, fileExtension: name => name.split('.').at(-1),
    fileSizeText: bytes => { assert.equal(typeof bytes, 'number'); return `${bytes}B`; } }, { get: (target, name) => target[name] ?? String(name) });
  function load(source) {
    let exports;
    vm.runInNewContext(source, { window: { setTimeout: () => 1, __ModuleLoader__: { load(definition) {
      exports = definition.factory(name => name === 'react' ? react : name === 'react/jsx-runtime' ? jsx : name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : {});
    } } }, setTimeout: () => 1, clearTimeout() {}, URL, AbortController });
    return exports;
  }
  const chat = load(patchNativeUserMessageSource(sources.chat).replace('exports.EMPTY_CHAT_SNAPSHOT =',
    'exports.test = { UserMessageNodeView, UserContent, registerChatNodeRenderers }; exports.EMPTY_CHAT_SNAPSHOT =')).test;
  const context = { effect(fn) { effects.push(fn()); }, inputTriggers: { registerSource: () => () => {} },
    slots: { inject(_name, fn) { fn(); }, registerFactory() { return () => {}; },
      register(options, component) { registrations.push({ options, component }); return () => {}; } } };
  chat.registerChatNodeRenderers(context);
  const nativeRows = registrations.filter(row => ['user', 'steering'].includes(row.options.key));
  const count = registrations.length;
  load(patchOcrMessageRendererSource(sources.ocr)).apply(context);
  assert.equal(registrations.slice(count).some(row => row.options.name === 'conversation.chat.node'), false);
  const t = (key, args) => key === 'copy' ? '复制' : key === 'message.referenceSummary' ? args.labels : key;
  const loadImage = () => {};
  const renderSlot = (name, props) => { imageCalls.push({ name, props }); return element('native-image', props); };
  const renderFactorySlot = (name, props) => name === 'conversation.chat.user.content'
    ? element(chat.UserContent, { ...props, t, renderSlot, renderFactorySlot }) : element('native-text', { children: props.text });
  return { nativeRows, copied, imageCalls, loadImage, render(content, kind = 'user') {
    return expand(element(nativeRows.find(row => row.options.key === kind).component, {
      node: { kind, data: { content, time: Date.now(), referenceLabels: ['原会话引用'] } }, loadImage, renderFactorySlot, t,
    }));
  } };
}

test('actual native user and steering renderer retain timestamp, original copy SVG and exact clipboard text', { skip: !runtime }, async () => {
  const browser = browserHarness(await sources());
  assert.equal(browser.nativeRows.length, 2);
  for (const kind of ['user', 'steering']) {
    const tree = browser.render([plain('  你能帮我制作视频吗\n')], kind);
    const actions = nodes(tree).find(node => node.props['data-clock'] === 'start'); assert.ok(actions);
    assert.match(text(actions), /^\d{2}:\d{2}$/);
    const button = nodes(actions).find(node => node.type === 'button'); assert.equal(button.props['aria-label'], '复制');
    const svg = nodes(button).find(node => node.type === 'svg'); assert.equal(svg.props.viewBox, '0 0 16 16');
    assert.ok(nodes(svg).some(node => node.type === 'rect' && node.props.x === '1.52075'));
    button.props.onClick(); button.props.onClick(); await Promise.resolve();
    assert.equal(browser.copied.at(-1), '  你能帮我制作视频吗\n');
    assert.equal(text(tree).includes('复制 / Copy'), false); assert.ok(text(tree).includes('原会话引用'));
  }
  assert.equal(browser.copied.length, 2, 'native pending guard prevents double clipboard writes');
});

test('native content renders legacy/native files once, preserves image loader, and never displays or copies OCR payload', { skip: !runtime }, async () => {
  const browser = browserHarness(await sources());
  const image = { type: 'image', attachment: { id: 'image-only' } };
  const tree = browser.render([plain(`请查看\n${tagged('legacy.txt', '不应显示或复制的提取正文')}`),
    { type: 'file', attachment: { id: 'native', name: 'native.docx', bytes: 22 } }, image]);
  for (const name of ['legacy.txt', 'native.docx']) assert.equal(nodes(tree).filter(node => node.props.title === name).length, 1);
  assert.equal(text(tree).includes('提取正文'), false); assert.equal(text(tree).includes('<attached_file'), false);
  assert.equal(browser.imageCalls[0].props.loadImage, browser.loadImage);
  assert.equal(browser.imageCalls[0].props.images[0].attachment, image.attachment);
  nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === '复制').props.onClick(); await Promise.resolve();
  assert.deepEqual(browser.copied, ['请查看']);
  const old = browser.render([plain('<attached_file name="old.txt" kind="text">\n旧正文\n</attached_file>')]);
  assert.equal(nodes(old).filter(node => node.props.title === 'old.txt').length, 1);
  assert.equal(text(old).includes('NaN'), false); assert.equal(text(old).includes('旧正文'), false);
});
