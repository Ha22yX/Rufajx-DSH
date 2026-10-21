import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';
import { createRemotionProvider } from './provider.mjs';

export const name = 'skill-remotion';
export const inject = ['skills'];
export function apply(ctx) {
  const runtimeRoot = process.env.RUFA_RUNTIME_ROOT;
  if (!runtimeRoot) throw new Error('Remotion技能需要公司客户端的固定运行环境。');
  ctx.skills.registerProvider(() => createRemotionProvider({ runtimeRoot, rank: BUNDLED_SKILL_RANK }));
}
