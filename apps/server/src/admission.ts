import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServerConfig } from './config.js';
import { AppError } from './types.js';

// Count requests before Fastify buffers their bodies, through the entire response.
// IncomingMessage 'close' also fires after a normal body: it must not release SSE.
export class GatewayAdmission {
  private active = 0;
  private uploads = 0;
  private readonly perUser = new Map<string, number>();

  constructor(private readonly config: ServerConfig) {}

  enter(request: FastifyRequest, reply: FastifyReply, userId: string, upload: boolean) {
    if (request.raw.aborted || reply.raw.destroyed) throw new AppError(400, 'REQUEST_ABORTED', '请求已中断');
    if (this.active >= this.config.maxConcurrent || (this.perUser.get(userId) ?? 0) >= this.config.maxUserConcurrent || (upload && this.uploads >= this.config.maxConcurrentUploads)) {
      throw new AppError(429, 'CONCURRENCY_LIMIT', '当前运行任务较多，请稍后重试');
    }
    this.active++;
    if (upload) this.uploads++;
    this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      request.raw.off('aborted', release);
      reply.raw.off('finish', release);
      reply.raw.off('close', release);
      this.active--;
      if (upload) this.uploads--;
      const count = this.perUser.get(userId)! - 1;
      if (count) this.perUser.set(userId, count); else this.perUser.delete(userId);
    };
    // Includes parser failures, normal completion, body abort and response abort.
    request.raw.once('aborted', release);
    reply.raw.once('finish', release);
    reply.raw.once('close', release);
  }
}
