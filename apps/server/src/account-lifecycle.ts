/** Seven elapsed days; restoring never revives any previously issued login. */
export const ACCOUNT_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNT_CLEANUP_INTERVAL_MS = 60_000;
export const purgeDeadline = (deletedAt: string) => new Date(Date.parse(deletedAt) + ACCOUNT_RECOVERY_MS).toISOString();
export const ARCHIVED_DISPLAY_NAME = '已归档账号';
