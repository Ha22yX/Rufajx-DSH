function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text') return part.text ?? '';
    if (part.type === 'reasoning') return `思考：${part.text ?? ''}`;
    if (part.type === 'tool-call') return `调用工具：${part.name ?? ''}\n${typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments ?? {})}`;
    if (part.type === 'image') return '[图片附件]';
    if (part.type === 'file' || part.type === 'document') return `[文件附件${part.name ? `：${part.name}` : ''}]`;
    return part.text ?? `[${part.type ?? '结构化内容'}，详见原始事件]`;
  }).join('\n');
}

export function formatEvent(event) {
  const data = event.data ?? {};
  switch (event.type) {
    case 'user/message': return { role: '员工', text: contentText(data.content ?? data.message?.content) };
    case 'assistant/message': return { role: '助手', text: contentText(data.message?.content ?? data.content) };
    case 'tool/call': return { role: `工具调用 · ${data.name ?? ''}`, text: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {}, null, 2) };
    case 'tool/result': return { role: `工具结果${data.isError || data.message?.isError ? ' · 错误' : ''}`, text: contentText(data.message?.content ?? data.content) || (typeof data.result === 'string' ? data.result : '') };
    case 'system/message': return { role: '系统', text: contentText(data.message?.content ?? data.content) };
    case 'session/title': return { role: '会话标题', text: data.title ?? '' };
    default: return { role: '系统事件', text: event.type ?? '未知事件' };
  }
}
