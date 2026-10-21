/** Presentation only; the server owns deletion deadlines and restore authorization. */
export function recycleStatus(user, now = Date.now()) {
  if (user.status !== 'deleted') return { group: 'accounts', recoverable: false, remaining: '' };
  if (user.purgedAt) return { group: 'archive', recoverable: false, remaining: '已到期归档' };
  const expires = typeof user.purgeAfter === 'string' ? Date.parse(user.purgeAfter) : NaN;
  if (!Number.isFinite(expires)) return { group: 'recycle', recoverable: false, remaining: '保留时间待服务器确认' };
  if (expires <= now) return { group: 'recycle', recoverable: false, remaining: '已到期，等待归档' };
  const minutes = Math.ceil((expires - now) / 60_000), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  const remaining = days ? `剩余 ${days} 天 ${hours} 小时` : hours ? `剩余 ${hours} 小时 ${minutes % 60} 分钟` : `剩余 ${minutes} 分钟`;
  return { group: 'recycle', recoverable: true, remaining };
}
