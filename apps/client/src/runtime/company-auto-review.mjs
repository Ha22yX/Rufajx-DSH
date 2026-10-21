// Keep the pinned native reviewer and its deny/ask behavior; only deployment selection is managed here.
import { importUpstream } from './import-upstream.mjs';
const native = await importUpstream('@deepseek-ai/dsh-experimental-auto-review');
const { setApprovalPolicy } = await importUpstream('@deepseek-ai/dsh-user-approval');
export const name = 'rufa-auto-review';
export const inject = native.inject;

export function installAutomaticReview(service, sessions) {
  if (!service.names.includes('auto')) throw new Error('公司自动审查尚未就绪。');
  const originals = new Map();
  const replace = (key, descriptor) => {
    originals.set(key, Object.getOwnPropertyDescriptor(service, key));
    Object.defineProperty(service, key, { configurable: true, ...descriptor });
  };
  // These two native methods are pinned to the bundled Harness revision.
  const apply = service.apply, pin = service.pinInitialPermission;
  if (typeof apply !== 'function' || typeof pin !== 'function') throw new Error('Harness权限接口已变化，需要更新公司适配。');
  replace('defaultPreset', { get: () => 'auto' });
  replace('names', { get: () => ['auto'] });
  replace('catalog', { value: function() {
    return { options: [this.optionOf('auto')], defaultOptions: [], defaultPreset: 'auto' };
  } });
  replace('apply', { value: function(session, preset, setApproval) {
    if (preset !== 'auto') throw new Error('公司统一使用自动审查，不能切换审查模式。');
    return apply.call(this, session, preset, setApproval);
  } });
  const select = session => {
    if (service.current(session) === 'auto') return;
    const childNever = session.header.origin === 'subagent' && service.permissionState(session).approval === 'never';
    service.set(session, 'auto');
    if (childNever) setApprovalPolicy(session, 'never');
  };
  replace('pinInitialPermission', { value: function(session) {
    pin.call(this, session);
    // Restored sessions retain their history; append the new company choice before publication.
    select(session);
  } });
  for (const session of sessions.list()) select(session);
  return () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(service, key, descriptor);
      else delete service[key];
    }
  };
}

export function apply(ctx) {
  native.apply(ctx);
  const service = ctx.permissionPresets[Symbol.for('cordis.original')] ?? ctx.permissionPresets;
  ctx.effect(() => installAutomaticReview(service, ctx.sessions));
  const readiness = { active: true };
  ctx.effect(() => () => { readiness.active = false; });
  ctx.provide('rufaAutoReviewReady', readiness);
}
