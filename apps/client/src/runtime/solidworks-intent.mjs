import { humanPreferenceMessages, humanPreferenceText } from './company-preference-rules.mjs';

const product = /solid\s*works|solidworks2016|\bsw(?:\s*20\d\d)?\b/iu;
const action = /建模|模型|零件|装配|工程图|草图|曲面|钣金|焊件|拉伸|配合|特征|尺寸|导出|绘制|画|设计|制作|修改|创建|打开|编辑|修复|操作|测试|验证|model|design|create|draw|edit|assembly|part|export|sketch/iu;
const negative = /(?:不要|不用|别用|不使用|无需|停止|取消).{0,12}(?:solid\s*works|\bsw\b|建模)|(?:solid\s*works|\bsw\b).{0,8}(?:停止|取消)|\b(?:do not|don't|stop|cancel|without)\b.{0,24}(?:solid\s*works|\bsw\b|modeling)/iu;
const explanation = /^(?:请)?(?:介绍|解释|什么是|了解|比较|推荐)|\b(?:what is|explain|compare)\b/iu;
const continuation = /^(?:请你|请|帮我|那你|那就)?\s*(?:继续|接着|再|把|将|改为|改成|修改|增大|缩小|增加|减少|去掉|保存|导出|重试|重做|这个|刚才|上面|它|continue\b|retry\b|change\b|save\b|export\b)/iu;
const cadWords = /尺寸|毫米|mm\b|直径|半径|孔|圆角|倒角|拉伸|草图|配合|曲面|钣金|焊件|零件|模型|装配|工程图|特征|轮廓|实体|BOM|STEP|IGES|STL/iu;

export function solidworksIntent(messages) {
  let enabled = false;
  for (const { text = '' } of messages) {
    if (negative.test(text)) { enabled = false; continue; }
    if (product.test(text) && action.test(text) && !explanation.test(text.trim())) { enabled = true; continue; }
    if (enabled && continuation.test(text.trim()) && (cadWords.test(text) || /^(?:请|那你|那就)?\s*(?:继续|接着|重试|重做|continue|retry)[。！.!\s]*$/iu.test(text))) continue;
    enabled = false;
  }
  return enabled;
}

export function solidworksOwner(session, agents) {
  const seen = new Set();
  while (session?.header?.origin === 'subagent') {
    if (seen.has(session.id) || seen.size >= 32) return undefined;
    seen.add(session.id);
    session = agents?.get(session.header.parentSession)?.session;
  }
  return session;
}

export function createSolidworksGate(agents) {
  const pending = new WeakMap();
  return {
    observe(agent, messages = [], append = false) {
      if (!agent?.session || agent.session.header?.origin === 'subagent') return;
      const incoming = messages.filter(message => message.source?.kind === 'user'
        && typeof message.source.rpcId === 'string' && message.source.principal === undefined)
        .map(message => ({ text: humanPreferenceText(message.content), rpcId: message.source.rpcId })).filter(row => row.text);
      const combined = [...(append ? pending.get(agent.session) ?? [] : []), ...incoming];
      pending.set(agent.session, [...new Map(combined.map(row => [row.rpcId, row])).values()]);
    },
    enabled(agent, forExecution = false) {
      const owner = solidworksOwner(agent?.session, agents);
      if (!owner) return false;
      const messages = humanPreferenceMessages(owner);
      // Pending messages affect the first schema assembly only. Calls require
      // the actual committed human event, never a model-supplied request.
      const extra = forExecution ? [] : (pending.get(owner) ?? []);
      if (extra.length && messages.at(-1)?.text !== extra.at(-1)?.text) return solidworksIntent([...messages, ...extra]);
      return solidworksIntent(messages);
    },
  };
}
