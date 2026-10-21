const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const rawText = value => typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);

function contentParts(content) {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ kind: 'detail', title: '结构化内容', text: rawText(content) }];
  return content.flatMap(part => {
    if (typeof part === 'string') return [{ kind: 'text', text: part }];
    if (!part || typeof part !== 'object') return [{ kind: 'detail', title: '内容', text: rawText(part) }];
    if (part.type === 'text' || part.type === 'reasoning') return [{ kind: part.type, title: part.type === 'reasoning' ? '思考过程' : '', text: typeof part.text === 'string' ? part.text : rawText(part) }];
    if (part.type === 'tool-call') return [{ kind: 'tool', title: '工具请求 · ' + (part.name || '未命名工具'), text: rawText(part.arguments), callId: part.id, name: part.name }];
    if (['image','file','document','audio','video'].includes(part.type)) {
      const ref = object(part.attachment), label = ref.name || ref.filename || part.name || part.filename || ({ image: '图片', file: '文件', audio: '音频', video: '视频' }[part.type]) || '附件';
      return [{ kind: 'attachment', title: String(label), text: rawText(part), mime: ref.mimeType || ref.mediaType || part.mimeType, size: ref.bytes ?? ref.size ?? ref.byteLength }];
    }
    return [{ kind: 'detail', title: '内容 · ' + (part.type || '未知类型'), text: rawText(part) }];
  });
}

function attemptParts(stream) {
  if (!Array.isArray(stream)) return [];
  const parts = [];
  for (const record of stream) {
    if (record?.type === 'text-chunks' || record?.type === 'reasoning-chunks') parts.push({ kind: record.type === 'text-chunks' ? 'text' : 'reasoning', title: '未完成的思考', text: Array.isArray(record.texts) ? record.texts.join('') : rawText(record) });
    else if (record?.type === 'tool-call-chunks') parts.push({ kind: 'tool', title: '工具请求片段 · ' + (record.name || '未命名'), text: Array.isArray(record.args) ? record.args.join('') : rawText(record) });
    else if (record?.type === 'chunk' && record.chunk?.type === 'finish') parts.push({ kind: 'detail', title: '本次尝试结束原因', text: rawText(record.chunk.reason) });
  }
  return parts;
}

/** Display projection only. Never replay an event, load a plugin or dereference a path. */
export function projectEvent(event, tools = new Map()) {
  event = object(event); const data = object(event.data), message = object(data.message), type = event.type;
  const result = { kind: 'system', role: '系统记录', parts: [], folded: true, raw: rawText(event), time: event.time, type: type || '未知事件', notes: [] };
  if (type === 'user/message') {
    const source = object(data.source ?? message.source), human = source.kind === 'user' && source.principal == null;
    result.kind = human ? 'user' : 'context'; result.role = human ? '员工' : '注入上下文'; result.folded = !human;
    result.parts = contentParts(data.content ?? message.content);
    if (!human) result.notes.push(source.kind ? '来源：' + source.kind : '来源未记录，不视为员工直接发言');
  } else if (type === 'assistant/message') {
    result.kind = 'assistant'; result.role = '助手'; result.folded = false; result.parts = contentParts(message.content ?? data.content);
    if (data.interrupted) result.notes.push('生成已中断 · 以下为实际保存的部分内容');
  } else if (type === 'assistant/attempt') {
    result.kind = 'attempt'; result.role = '未完成的模型尝试'; result.parts = attemptParts(data.stream);
    result.notes.push('此尝试未形成正式助手消息；完整过程可在原始记录中查看');
  } else if (type === 'tool/call') {
    const name = data.name || '未命名工具'; if (data.callId) tools.set(data.callId, name);
    result.kind = 'tool'; result.role = '调用工具 · ' + name; result.parts = [{ kind: 'code', text: rawText(data.arguments) }];
  } else if (type === 'tool/result') {
    const callId = message.toolCallId || message.source?.callId || data.callId;
    result.kind = data.isError || message.isError || data.error ? 'error' : 'tool';
    result.role = (result.kind === 'error' ? '工具执行失败' : '工具结果') + ' · ' + (tools.get(callId) || data.name || '调用名称未记录');
    result.parts = contentParts(message.content ?? data.content);
    if (!result.parts.length && data.result != null) result.parts.push({ kind: 'code', text: rawText(data.result) });
    if (data.error) result.parts.push({ kind: 'detail', title: '错误详情', text: rawText(data.error) });
    if (data.meta != null) result.parts.push({ kind: 'detail', title: '工具附加信息', text: rawText(data.meta) });
  } else if (type === 'turn/end') {
    const reason = typeof data.reason === 'string' ? data.reason : data.reason?.kind;
    result.role = ({ completed: '本轮完成', aborted: '任务已停止', interrupted: '任务中断', failed: '任务失败', error: '任务错误', rejected: '操作被拒绝' }[reason]) || '本轮结束';
    result.kind = ['failed','error','aborted','interrupted','rejected'].includes(reason) ? 'error' : 'system';
    result.parts = [{ kind: 'code', text: rawText(data.reason ?? data) }];
  } else if (type === 'system/message' || type === 'developer/message') {
    result.role = type === 'system/message' ? '系统上下文' : '工具与上下文调整'; result.parts = contentParts(message.content ?? data.content);
  } else if (type === 'session/title') { result.role = '会话标题更新'; result.parts = [{ kind: 'text', text: data.title || rawText(data) }]; }
  else {
    result.role = ({ 'turn/start': '本轮开始', 'step/start': '步骤开始', 'step/end': '步骤完成', 'request/header': '请求配置', 'request/context': '请求上下文', 'session/restore': '会话恢复' }[type]) || '其他记录 · ' + (type || '未知类型');
    result.parts = [{ kind: 'code', text: rawText(data) }];
  }
  for (const part of result.parts) if (part.kind === 'tool' && part.callId && part.name) tools.set(part.callId, part.name);
  if (event.surfaceOp?.op === 'replace') {
    result.role = '上下文调整 · ' + result.role; result.kind = 'context'; result.folded = true;
    result.notes.push('替换显示范围：记录 ' + event.surfaceOp.startSeq + '–' + event.surfaceOp.endSeq + '；此处保留原始时间线，不重复归为员工发言');
  }
  if (Array.isArray(event.sourceEventSeqs)) result.notes.push('来源记录：' + event.sourceEventSeqs.join('、'));
  if (!result.parts.length) result.parts.push({ kind: 'detail', title: '此记录没有正文，查看完整数据', text: rawText(data) });
  result.text = result.parts.map(part => [part.title, part.text].filter(Boolean).join('\n')).join('\n');
  return result;
}

