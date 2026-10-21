import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startWorkbenchFixture, until, pause } from './fixtures/desktop-workbench.mjs';
import { seedAdminPanel, adminFixture, historyFingerprint } from './fixtures/admin-panel-data.mjs';

test('management panel: complete native history, discovery, account editing, safe read-only navigation',
  { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 240000 }, async t => {
    let data, failEventPage = false, delayedSession, releaseDelayed, delayedRequestId, delayedResponseDone = false;
    const visual = process.env.RUFA_ADMIN_VISUAL === '1';
    const managementWrites = [], requests = [];
    const f = await startWorkbenchFixture(t, { prefix: 'admin-panel-', visibleWindow: visual,
      seed: async input => { data = await seedAdminPanel(input); },
      configureServer(server) {
        server.addHook('onRequest', async (request, reply) => {
          if (request.url.includes('/admin/')) requests.push({ method: request.method, path: request.url.split('?')[0] });
          if (request.method !== 'GET' && /^\/api\/v1\/sessions(?:\/|$|\?)/.test(request.url)) managementWrites.push(request.url);
          if (failEventPage && request.url.includes('/admin/sessions/') && request.url.includes('/events?') && !request.url.includes('afterSeq=-1')) {
            failEventPage = false;
            reply.code(503).send({ error: { code: 'FIXTURE_RETRY', message: 'Synthetic transient failure' } });
          }
        });
        server.addHook('preSerialization', async (request, reply, payload) => {
          if (delayedSession && !releaseDelayed && reply.statusCode === 200 && request.url.includes(`/admin/sessions/${delayedSession}/events`)) {
            delayedRequestId = request.id; delayedResponseDone = false;
            // Hold an already-authorized payload, not the authorization step.
            await new Promise(resolve => { releaseDelayed = resolve; });
          }
          return payload;
        });
        server.addHook('onResponse', async request => { if (request.id === delayedRequestId) delayedResponseDone = true; });
      },
    });
    managementWrites.length = 0;
    const ui = f.shell;
    const click = selector => ui.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const input = (selector, value) => ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const text = selector => ui.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
    const exists = selector => ui.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    const visible = selector => ui.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return Boolean(e&&!e.hidden&&e.getBoundingClientRect().height);})()`);
    async function capture(name) {
      // A hidden Windows compositor can time out or return an empty frame.
      // Visual acceptance explicitly presents this independent test window.
      if (!visual) return;
      await pause(150);
      let result;
      try { result = await ui.call('Page.captureScreenshot', { format: 'png' }); }
      catch (error) {
        if (!/CDP timeout Page.captureScreenshot/.test(error.message)) throw error;
        await pause(250);
        result = await ui.call('Page.captureScreenshot', { format: 'png' });
      }
      await writeFile(join(f.temporary, `${name}.png`), Buffer.from(result.data, 'base64'));
    }
    const query = async ({ owner = '', q = '' } = {}) => {
      await input('#chat-owner', owner); await input('#chat-query', q);
      await ui.evaluate('document.querySelector("#chat-filters").requestSubmit()');
    };
    const select = async id => {
      await until(() => exists(`.session-row[data-session-id="${id}"]`), 'listed session ' + id);
      await click(`.session-row[data-session-id="${id}"]`);
      await until(() => exists('#events article[data-event-seq]'), 'first event page');
      await until(() => text('#events').then(s => s.includes(id === adminFixture.other ? '装配图资料完整' : '采购建议')), 'selected session content');
    };
    try {
      await ui.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      await ui.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
      await click('#open-admin');
      await until(() => text('#overview-stats').then(s => s.includes('106')), 'real aggregate session total');
      assert.match(await text('#overview-users'), /陈晓/);
      await capture('admin-overview');
      await click('#admin-nav [data-section="chat"]');
      await query({ owner: data.users['admin-read-a'].id });
      await until(() => text('#sessions-status').then(s => s.includes('105')), 'all sessions discoverable beyond old first 100');
      let listGuard = 0;
      while (await visible('#sessions-more') && listGuard++ < 5) {
        const count = await ui.evaluate('document.querySelectorAll(".session-row[data-session-id]").length');
        await click('#sessions-more');
        await until(() => ui.evaluate(`document.querySelectorAll('.session-row[data-session-id]').length>${count}`), 'next session page');
      }
      assert.equal(await ui.evaluate('document.querySelectorAll(".session-row[data-session-id]").length'), 105);
      // The server query finds a keyword stored after the first two event pages.
      await query({ q: adminFixture.tail });
      await until(() => ui.evaluate('document.querySelectorAll(".session-row[data-session-id]").length===1'), 'full saved content search');
      await select(adminFixture.conversation);
      assert.match(await text('#reader-owner'), /陈晓/);
      await until(() => text('#events').then(s => s.includes(adminFixture.longEnd)), 'long message remains fully accessible');
      assert.ok(await exists('#events table'), 'Markdown table is readable as a table');
      assert.ok(await exists('#events pre'), 'Code and raw records have a preformatted presentation');
      assert.match(await text('#events'), /设备报价对比.xlsx/);
      assert.match(await text('#events'), /设备铭牌.png/);
      assert.equal(await exists('#events img[src^="file:"],#events img[src^="http"],#events a[href^="javascript:"],#events a[href^="file:"]'), false);
      await capture('admin-conversation');
      await ui.evaluate('document.querySelector("#events .record-assistant").scrollIntoView({block:"start"})');
      await capture('admin-readable-reply');
      const firstCount = await ui.evaluate('document.querySelectorAll("#events article[data-event-seq]").length');
      failEventPage = true;
      await click('#more-events');
      await until(() => visible('#events-error'), 'page failure has a readable retry state');
      assert.equal(await ui.evaluate('document.querySelectorAll("#events article[data-event-seq]").length'), firstCount, 'A failure retains already loaded history');
      await click('#more-events');
      await until(() => ui.evaluate(`document.querySelectorAll('#events article[data-event-seq]').length>${firstCount}`), 'retry resumes at the missing page');
      await click('#all-events');
      await until(() => exists(`#events article[data-event-seq="${data.eventCount - 1}"]`), 'complete saved event tail');
      const sequences = await ui.evaluate('[...document.querySelectorAll("#events article[data-event-seq]")].map(e=>Number(e.dataset.eventSeq))');
      assert.deepEqual(sequences, Array.from({ length: data.eventCount }, (_, i) => i), 'Every original event remains inspectable in order, exactly once');
      assert.match(await text('#events'), new RegExp(adminFixture.tail));
      assert.equal(await ui.evaluate('Boolean(window.__adminXss)'), false, 'User content cannot run HTML or JS');
      assert.equal(await ui.evaluate('document.querySelectorAll("#events details[data-raw-event]").length'), data.eventCount);
      await input('#event-find', adminFixture.tail);
      await until(() => text('#event-find-count').then(s => /[1-9]/.test(s)), 'search locates loaded content');
      await capture('admin-history-search');
      // Race: hold the old session response while switching to another user.
      await query(); await until(() => exists(`.session-row[data-session-id="${adminFixture.other}"]`), 'other employee listed');
      await select(adminFixture.other);
      delayedSession = adminFixture.conversation;
      await click(`.session-row[data-session-id="${adminFixture.conversation}"]`);
      await until(() => Boolean(releaseDelayed), 'old session request held');
      delayedSession = undefined;
      await select(adminFixture.other);
      await until(() => text('#reader-owner').then(s => s.includes('林然')), 'new employee selected');
      releaseDelayed(); await until(() => delayedResponseDone, 'old response sent'); releaseDelayed = undefined;
      await pause(500);
      assert.match(await text('#events'), /装配图资料完整/);
      assert.doesNotMatch(await text('#events'), /设备报价对比|采购建议/);
      // A real profile edit from the new account detail dialog.
      await click('#admin-nav [data-section="accounts"]');
      await input('#user-search', '林然');
      await until(() => text('#users').then(s => s.includes('林然') && !s.includes('陈晓')), 'account search');
      await capture('admin-accounts');
      // UI action hooks remain semantic instead of reaching into implementation state.
      await ui.evaluate(`(()=>{const b=[...document.querySelectorAll('#users button')].find(b=>/编辑/.test(b.textContent)||/编辑/.test(b.getAttribute('aria-label')||''));if(!b)throw Error('No account edit action');b.click();})()`);
      await until(() => visible('#account-dialog'), 'edit dialog');
      await input('#account-job-title', '机械设计工程师'); await click('#account-submit');
      await until(async () => (await f.api.json('GET', '/admin/users')).users.find(u => u.id === data.users['admin-read-b'].id)?.jobTitle === '机械设计工程师', 'profile edit persists');
      await click('#admin-nav [data-section="settings"]');
      await until(() => visible('#key-form'), 'service settings separate');
      await capture('admin-settings');
      await click('#admin-nav [data-section="chat"]');
      await ui.call('Emulation.setDeviceMetricsOverride', { width: 920, height: 760, deviceScaleFactor: 1, mobile: false });
      await capture('admin-narrow');
      assert.equal(await ui.evaluate('document.documentElement.scrollWidth>window.innerWidth+2'), false, 'Narrow layout does not overflow horizontally');
      assert.equal(f.gatewayCalls, 0, 'Read-only history never calls a model');
      assert.deepEqual(managementWrites, [], 'Management never writes history or acquires a session lease');
      const db = new DatabaseSync(join(f.temporary, 'company.sqlite'), { readOnly: true });
      try {
        assert.equal(historyFingerprint(db), data.fingerprint, 'History reads and account profile edits preserve every original event byte');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rufa_sessions WHERE owner_id IN (?,?) AND lease_id IS NOT NULL').get(data.users['admin-read-a'].id, data.users['admin-read-b'].id).n, 0, 'No employee write lease is acquired');
      } finally { db.close(); }
      await query(); await until(() => exists(`.session-row[data-session-id="${adminFixture.conversation}"]`), 'session before downgrade');
      delayedSession = adminFixture.conversation;
      await click(`.session-row[data-session-id="${adminFixture.conversation}"]`);
      await until(() => Boolean(releaseDelayed), 'authorized response held before downgrade');
      delayedSession = undefined;
      await f.api.json('POST', '/admin/users', { username: 'backup-admin-e2e', displayName: '验收备用管理员', role: 'admin', password: 'Synthetic-backup-2026' });
      await f.api.json('PATCH', `/admin/users/${f.user.id}`, { role: 'employee' });
      const denied = await ui.evaluate('window.rufa.call("admin.querySessions",{})');
      assert.equal(denied.ok, false, 'A downgraded administrator cannot query history');
      assert.ok(['FORBIDDEN','UNAUTHORIZED'].includes(denied.error?.code), 'Denial is specifically an identity/permission failure');
      await until(() => visible('#admin-view').then(value => !value), 'management content hidden after downgrade');
      releaseDelayed(); await until(() => delayedResponseDone, 'old authorized response sent after downgrade'); releaseDelayed = undefined;
      await pause(500);
      assert.equal(await ui.evaluate('document.querySelector("#events").textContent.length'), 0, 'Previous employee history is removed after authority changes');
      await writeFile(join(f.temporary, 'verification.json'), JSON.stringify({ eventCount: data.eventCount, sessions: 106, gatewayCalls: f.gatewayCalls, originalHistoryUnchanged: true, screenshots: visual ? ['admin-overview', 'admin-conversation', 'admin-readable-reply', 'admin-history-search', 'admin-accounts', 'admin-settings', 'admin-narrow'] : [], managementRequests: requests.length }, null, 2));
      t.diagnostic(`Management panel evidence: ${f.temporary}`);
    } catch (error) {
      releaseDelayed?.();
      await capture('failure').catch(() => {});
      await writeFile(join(f.temporary, 'failure.txt'), await ui.evaluate('document.body.innerText').catch(() => 'shell unavailable'));
      t.diagnostic(`Management panel failure evidence: ${f.temporary}`); throw error;
    }
  });
