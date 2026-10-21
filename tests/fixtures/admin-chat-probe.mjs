// Test-only human answerer. Never shipped with the application.
import { apply } from '../../apps/client/dist/runtime/admin-tools.mjs';
const tools = new Map();
let mode = 'confirm';
apply({
  tools: { register: tool => tools.set(tool.name, tool) },
  effect: fn => fn(),
  userQuestions: { async ask(request) {
    process.send({ type: 'test:question', title: request.questions[0].question });
    if (mode === 'unavailable') throw new Error('No UI');
    if (mode === 'abort') return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
    return { answers: [{ id: request.questions[0].id, selected: [mode === 'confirm' ? '确认执行' : '取消'] }] };
  } },
});
process.on('message', async message => {
  if (message?.type !== 'test:invoke') return;
  mode = message.mode;
  const controller = new AbortController();
  if (mode === 'abort') setTimeout(() => controller.abort(), 100);
  try {
    const result = await tools.get('rufa_admin_delete_user').execute({ userId: 'fixture-only' }, { agent: { session: {} }, signal: controller.signal });
    process.send({ type: 'test:result', result: JSON.parse(result) });
  } catch { process.send({ type: 'test:result', cancelled: true }); }
});
process.send({ type: 'test:ready', schemas: Object.fromEntries(['create_user', 'update_user'].map(action => [action, tools.get(`rufa_admin_${action}`).parameters])) });
