import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import type { DeepSeekSettings } from './deepseek-settings.js';
import type { Store } from './store.js';
import { AppError, invalid, notFound, type AuthContext, type Usage } from './types.js';

// This scanner observes upstream usage only. It does not rewrite tool-call or thinking frames.
class UsageReader {
  inputTokens: number | null = null; outputTokens: number | null = null; totalTokens: number | null = null;
  private pending = '';
  accept(value: unknown) {
    const usage = (value as any)?.usage ?? (value as any)?.message?.usage;
    const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (usage && typeof usage === 'object') {
      this.inputTokens = count(usage.prompt_tokens ?? usage.input_tokens) ?? this.inputTokens;
      this.outputTokens = count(usage.completion_tokens ?? usage.output_tokens) ?? this.outputTokens;
      this.totalTokens = count(usage.total_tokens) ?? (this.inputTokens !== null && this.outputTokens !== null ? this.inputTokens + this.outputTokens : null);
    }
  }
  push(text: string) {
    this.pending += text;
    let lineEnd: number;
    while ((lineEnd = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, lineEnd).trimEnd();
      this.pending = this.pending.slice(lineEnd + 1);
      if (line.startsWith('data:')) { try { this.accept(JSON.parse(line.slice(5).trim())); } catch { /* [DONE] and non-JSON frames */ } }
    }
    // Never retain unbounded streamed tool content just to collect usage.
    if (this.pending.length > 1024 * 1024) this.pending = '';
  }
}
function redact(value: string, secrets: string[]) { return secrets.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text, value); }

export class Gateway {
  private readonly base: string;
  constructor(private store: Store, private config: ServerConfig, private settings: DeepSeekSettings) {
    const url = new URL(config.upstreamBaseUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(config.allowInsecureUpstream && url.protocol === 'http:'))) throw new Error('Invalid upstream URL: HTTPS without credentials/query/fragment required');
    this.base = url.href.replace(/\/$/, '');
  }
  async completion(request: FastifyRequest, reply: FastifyReply, auth: AuthContext, kind: 'chat' | 'messages' | 'search' | 'fetch' = 'chat') {
    const upstreamKey = this.settings.currentKey();
    const body = request.body as Record<string, unknown>;
    const isModel = kind === 'chat' || kind === 'messages';
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
    const model = isModel ? this.config.models.find(model => model.id === body.model) : undefined;
    if (isModel && (typeof body.model !== 'string' || !model)) throw invalid('请选择已授权的模型');
    const outputLimit = Math.min(model?.maxOutputTokens ?? this.config.maxOutputTokens, this.config.maxOutputTokens);
    if (isModel && (!Array.isArray(body.messages) || body.messages.length === 0)) throw invalid('messages 必须为非空数组');
    if (!isModel && body.stream) throw invalid('此接口不支持stream');
    await this.checkFileReferences(body, auth.user.id);
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw invalid('stream 必须为布尔值');
    for (const key of ['max_tokens', 'max_completion_tokens']) {
      if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || (body[key] as number) < 1 || (body[key] as number) > outputLimit)) throw invalid(`输出上限须为 1 至 ${outputLimit} 的整数`);
    }
    if (!upstreamKey) throw new AppError(503, 'UPSTREAM_NOT_CONFIGURED', '管理员尚未配置模型服务');
    const controller = new AbortController();
    const now = this.config.now ?? Date.now;
    const usage = new UsageReader();
    let status: Usage['status'] = 'failed';
    let finished = false;
    const timeout = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
    // Revocation applies to long-running streams as well as newly admitted calls.
    let checking = false;
    const revocation = setInterval(() => {
      if (checking) return;
      checking = true;
      this.store.resolveLogin(auth.login.id, new Date(now()).toISOString()).then(value => { if (!value) controller.abort(); }).catch(() => controller.abort()).finally(() => { checking = false; });
    }, 1000);
    timeout.unref(); revocation.unref();
    const disconnected = () => { if (!reply.raw.writableEnded) { status = 'cancelled'; controller.abort(); } };
    reply.raw.on('close', disconnected);
    const finalize = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout); clearInterval(revocation);
      reply.raw.off('close', disconnected);
      await this.store.recordUsage({ id: randomUUID(), userId: auth.user.id, loginId: auth.login.id, model: isModel ? body.model as string : `web-${kind}`, requestId: request.id, createdAt: new Date(now()).toISOString(), status, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens });
    };
    const secrets = [upstreamKey, request.headers.authorization?.replace(/^Bearer /i, '') ?? ''].filter(Boolean);
    try {
      const upstreamBody = { ...body };
      if (isModel && upstreamBody.max_tokens === undefined && upstreamBody.max_completion_tokens === undefined) upstreamBody.max_tokens = outputLimit;
      // Attribute the request to a verified company account, never a supplied user id.
      if (kind === 'chat') upstreamBody.user = auth.user.id;
      if (kind === 'messages') upstreamBody.metadata = { ...(typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : {}), user_id: auth.user.id };
      const path = { chat: '/chat/completions', messages: '/anthropic/v1/messages', search: '/v1/tools/search', fetch: '/v1/tools/fetch' }[kind];
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: body.stream ? 'text/event-stream' : 'application/json' };
      if (kind === 'messages') {
        headers['x-api-key'] = upstreamKey;
        for (const name of ['anthropic-version', 'anthropic-beta']) {
          const value = request.headers[name];
          if (typeof value === 'string' && value.length <= 1024) headers[name] = value;
        }
        headers['anthropic-version'] ??= '2023-06-01';
      } else headers.Authorization = `Bearer ${upstreamKey}`;
      const upstream = await fetch(`${this.base}${path}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers,
        body: JSON.stringify(upstreamBody),
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        throw new AppError(upstream.status === 429 ? 429 : 502, 'UPSTREAM_ERROR', '模型服务暂时不可用，请稍后重试');
      }
      if (!body.stream) {
        const reader = upstream.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > this.config.bodyLimitBytes) { controller.abort(); throw new AppError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '模型响应超过服务端大小限制'); }
          chunks.push(value);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        let value: unknown;
        try { value = JSON.parse(raw); } catch { throw new AppError(502, 'UPSTREAM_PROTOCOL_ERROR', '模型响应格式无效'); }
        usage.accept(value); status = 'completed';
        await finalize();
        return reply.type('application/json').send(redact(raw, secrets));
      }
      if (!upstream.headers.get('content-type')?.includes('text/event-stream')) {
        await upstream.body.cancel();
        throw new AppError(502, 'UPSTREAM_PROTOCOL_ERROR', '模型未返回流式响应');
      }
      const source = upstream.body;
      const reserve = Math.max(...secrets.map(secret => secret.length), 1) - 1;
      const stream = Readable.from((async function* () {
        const reader = source.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
            usage.push(text); pending += text;
            let cut = done ? pending.length : Math.max(0, pending.length - reserve);
            // Do not cut through a secret when a provider accidentally echoes it.
            for (const secret of secrets) {
              const index = pending.lastIndexOf(secret, cut);
              if (index >= 0 && index < cut && index + secret.length > cut) cut = index;
            }
            if (cut) { yield redact(pending.slice(0, cut), secrets); pending = pending.slice(cut); }
            if (done) { if (pending) yield redact(pending, secrets); status = 'completed'; break; }
          }
        } catch {
          status = controller.signal.aborted ? 'cancelled' : 'failed';
          yield 'data: {"error":{"code":"UPSTREAM_STREAM_INTERRUPTED","message":"模型连接中断，请检查任务状态后重试"}}\n\n';
        } finally {
          await reader.cancel().catch(() => {});
          await finalize();
        }
      })());
      reply.header('Cache-Control', 'no-store').header('X-Accel-Buffering', 'no');
      return reply.type('text/event-stream').send(stream);
    } catch (error) {
      if (controller.signal.aborted) status = 'cancelled';
      await finalize();
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'UPSTREAM_UNAVAILABLE', '模型服务连接失败，请稍后重试');
    }
  }
  private async checkFileReferences(body: unknown, userId: string): Promise<void> {
    const messages = (body as { messages?: unknown })?.messages;
    const stack: unknown[] = [];
    if (Array.isArray(messages)) for (const message of messages) {
      if (message && typeof message === 'object' && Array.isArray(message.content)) for (const block of message.content) stack.push(block);
    }
    const ids = new Set<string>();
    while (stack.length) {
      const block = stack.pop() as Record<string, any> | undefined;
      if (!block || typeof block !== 'object') continue;
      // Only protocol content blocks carry provider file references. Tool inputs,
      // tool schemas and application metadata may legitimately use a file_id key.
      if ((block.type === 'image' || block.type === 'document') && block.source?.type === 'file') {
        if (typeof block.source.file_id !== 'string') throw invalid('文件引用格式无效');
        ids.add(block.source.file_id);
      }
      if (block.type === 'file' && typeof block.file?.file_id === 'string') ids.add(block.file.file_id);
      if (block.type === 'tool_result' && Array.isArray(block.content)) for (const child of block.content) stack.push(child);
    }
    if (ids.size > 1000) throw invalid('引用的文件过多');
    for (const id of ids) { const file = await this.store.getFile(id); if (!file || file.ownerId !== userId || file.deletedAt) throw notFound(); }
  }
  async files(request: FastifyRequest, reply: FastifyReply, auth: AuthContext, fileId?: string) {
    const upstreamKey = this.settings.currentKey();
    if (request.method === 'GET' && !fileId) {
      const query = request.query as Record<string, unknown>;
      const limit = Number(query.limit ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || (query.after_id !== undefined && typeof query.after_id !== 'string')) throw invalid('文件分页参数无效');
      const files = await this.store.listFiles(auth.user.id, limit + 1, query.after_id as string | undefined);
      const data = files.slice(0, limit).map(file => file.metadata);
      return { data, has_more: files.length > limit, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
    }
    if (fileId) {
      if (!/^[a-zA-Z0-9_.-]{1,200}$/.test(fileId)) throw notFound();
      const file = await this.store.getFile(fileId);
      if (!file || file.ownerId !== auth.user.id || file.deletedAt) throw notFound();
    }
    if (!upstreamKey) throw new AppError(503, 'UPSTREAM_NOT_CONFIGURED', '管理员尚未配置模型服务');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs); timeout.unref();
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', disconnected);
    try {
      let form: FormData | undefined;
      let bytes: Buffer | undefined;
      if (request.method === 'POST') {
        if (!Buffer.isBuffer(request.body)) throw invalid('文件上传须为multipart/form-data');
        try {
          form = await new Request('http://localhost/upload', { method: 'POST', headers: { 'Content-Type': request.headers['content-type'] ?? '' }, body: Uint8Array.from(request.body) }).formData();
        } catch { throw invalid('文件上传格式无效'); }
        const file = form.get('file');
        if (!file || typeof file === 'string' || file.size === 0 || form.getAll('file').length !== 1) throw invalid('须上传一个非空文件');
        if (file.size > 128 * 1024 * 1024) throw new AppError(413, 'PAYLOAD_TOO_LARGE', '单个文件不得超过128MiB');
        bytes = Buffer.from(await file.arrayBuffer());
      }
      const upstream = await fetch(`${this.base}/anthropic/v1/files${fileId ? `/${encodeURIComponent(fileId)}` : ''}`, {
        method: request.method, body: form, redirect: 'error', signal: controller.signal,
        headers: { 'x-api-key': upstreamKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'files-api-2025-04-14' },
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        if (upstream.status === 404 && fileId) { await this.store.markFileDeleted(fileId); throw notFound(); }
        throw new AppError(upstream.status === 429 ? 429 : 502, 'UPSTREAM_FILE_ERROR', '文件服务暂时不可用');
      }
      const reader = upstream.body?.getReader();
      if (!reader) throw new AppError(502, 'UPSTREAM_PROTOCOL_ERROR', '文件响应格式无效');
      const chunks: Uint8Array[] = []; let responseBytes = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        responseBytes += value.length;
        if (responseBytes > 1024 * 1024) { controller.abort(); throw new AppError(502, 'UPSTREAM_PROTOCOL_ERROR', '文件元数据响应过大'); }
        chunks.push(value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(502, 'UPSTREAM_PROTOCOL_ERROR', '文件响应格式无效');
      const metadata = value as Record<string, unknown>;
      if (typeof metadata.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/.test(metadata.id) || (fileId && metadata.id !== fileId)) throw new AppError(502, 'UPSTREAM_PROTOCOL_ERROR', '文件响应格式无效');
      const safe = JSON.parse(redact(JSON.stringify(metadata), [upstreamKey, request.headers.authorization?.replace(/^Bearer /i, '') ?? '']));
      if (request.method === 'POST') {
        if (metadata.type !== 'file') throw new AppError(502, 'UPSTREAM_PROTOCOL_ERROR', '文件响应格式无效');
        await this.store.saveFile({ id: metadata.id, ownerId: auth.user.id, metadata: safe, createdAt: new Date((this.config.now ?? Date.now)()).toISOString(), deletedAt: null }, bytes!);
      }
      if (request.method === 'DELETE') {
        if (metadata.type !== 'file_deleted') throw new AppError(502, 'UPSTREAM_PROTOCOL_ERROR', '文件删除响应格式无效');
        await this.store.markFileDeleted(fileId!);
      }
      await this.store.audit({ id: randomUUID(), actorId: auth.user.id, action: `gateway.file.${request.method.toLowerCase()}`, targetId: metadata.id, requestId: request.id, createdAt: new Date((this.config.now ?? Date.now)()).toISOString() });
      return safe;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'UPSTREAM_FILE_ERROR', '文件服务连接失败');
    } finally {
      clearTimeout(timeout); reply.raw.off('close', disconnected);
    }
  }
}
