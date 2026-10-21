import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { AdminApproval, AdminInteraction } from './admin-tools.js';

/** Only the current runtime's human question answer can settle this one-use request. */
export function confirmInChat(child: ChildProcess | null, approval: AdminApproval, interaction?: AdminInteraction): Promise<boolean> {
  if (!child?.connected || !interaction || !/^[a-f0-9-]{36}$/.test(interaction.id) || interaction.signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const requestId = randomUUID();
    let settled = false;
    const finish = (approved = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); child.off('message', onMessage); child.off('exit', cancel);
      interaction.signal.removeEventListener('abort', cancel);
      if (child.connected) child.send({ type: 'rufa:admin-confirm-close', requestId }, () => {});
      resolve(approved);
    };
    const cancel = () => finish(false);
    const onMessage = (message: unknown) => {
      const value = message as { type?: string; requestId?: string; approved?: boolean };
      if (value?.type === 'rufa:admin-confirm-answer' && value.requestId === requestId) finish(value.approved === true);
    };
    const timer = setTimeout(cancel, 10 * 60_000);
    child.on('message', onMessage); child.once('exit', cancel); interaction.signal.addEventListener('abort', cancel, { once: true });
    child.send({ type: 'rufa:admin-confirm', requestId, interactionId: interaction.id, approval }, error => { if (error) cancel(); });
  });
}
