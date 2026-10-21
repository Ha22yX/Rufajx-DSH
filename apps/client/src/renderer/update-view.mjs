function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.floor(value)} B`;
}
export function updatePresentation(update) {
  if (!update || !['checking', 'downloading', 'verifying', 'installing', 'error'].includes(update.phase)) return null;
  const messages = { checking: '正在检查客户端更新…', downloading: '正在下载客户端更新…', verifying: '正在校验更新文件…',
    installing: '正在安装更新，即将自动重新启动…', error: '更新暂未完成' };
  const transferred = Number.isFinite(update.transferred) ? Math.max(0, update.transferred) : 0;
  const total = Number.isFinite(update.total) ? Math.max(0, update.total) : 0;
  const verified = Number.isFinite(update.verified) ? Math.max(0, update.verified) : 0;
  const version = /^\d+\.\d+\.\d+$/.test(update.targetVersion ?? '') ? `新版 ${update.targetVersion}` : '';
  const versionText = `当前版本 ${update.currentVersion ?? ''}${version ? ` · ${version}` : ''}`;
  const progress = ['downloading', 'verifying'].includes(update.phase) && total > 0;
  const completed = update.phase === 'verifying' ? verified : transferred;
  let detail = versionText;
  if (progress) detail += `\n${bytes(Math.min(completed, total))} / ${bytes(total)}${update.phase === 'downloading' && update.bytesPerSecond > 0 ? ` · ${bytes(update.bytesPerSecond)}/s` : ''}`;
  if (update.phase === 'error') detail += `\n${update.message || '请重试，或继续使用当前版本。'}`;
  return { message: messages[update.phase], detail, progress, percent: progress ? Math.min(100, completed / total * 100) : 0,
    failed: update.phase === 'error', retry: update.phase === 'error' && update.canRetry === true,
    continueCurrent: update.phase === 'error' && update.canContinue === true };
}
