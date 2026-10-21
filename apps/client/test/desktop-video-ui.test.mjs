import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

for (const scenario of [{ role: 'admin', existing: false }, { role: 'employee', existing: true }]) {
  test(`real Electron desktop settings are shipped for ${scenario.existing ? 'existing' : 'new'} ${scenario.role} and remain editable`,
    { skip: process.env.RUFA_DESKTOP_E2E !== '1', timeout: 180000 }, async t => {
      const { startWorkbenchFixture, until } = await import('../../../tests/fixtures/desktop-workbench.mjs');
      const yaml = createRequire(join(process.env.RUFA_TEST_RUNTIME_ROOT, 'package.json'))('yaml');
      const fixture = await startWorkbenchFixture(t, {
        prefix: 'rufa-desktop-video-ui-', role: scenario.role,
        async seed({ account }) {
          if (!scenario.existing) return;
          await mkdir(account.profileRoot, { recursive: true });
          await writeFile(join(account.profileRoot, 'package.json'), JSON.stringify({ name: 'existing-synthetic-account', private: true,
            dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
          await writeFile(join(account.profileRoot, 'cordis.yml'), '[]\n'); await writeFile(join(account.profileRoot, 'cordis.patch.yml'), '[]\n');
          await writeFile(join(account.companyHome, 'unrelated.txt'), 'preserve me');
        },
      });
      const evaluate = expression => fixture.harness.evaluate(expression);
      const configuration = async () => yaml.parse(await readFile(join(fixture.account.profileRoot, 'cordis.patch.yml'), 'utf8')).find(row => row.id === 'mcp-dsh-computer-use-win').config;
      async function open() {
        await evaluate('document.querySelector(".rufa-more-trigger").click()');
        await until(() => evaluate('[...document.querySelectorAll("[role=menuitem]")].some(e=>e.textContent.includes("设置"))'), 'settings menu');
        await evaluate('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("设置")).click()');
        await until(() => evaluate('[...document.querySelectorAll("[data-shortcut-modal=settings] button")].some(e=>e.textContent.trim()==="Computer Use")'), 'Computer Use setting section');
        await evaluate('[...document.querySelectorAll("[data-shortcut-modal=settings] button")].find(e=>e.textContent.trim()==="Computer Use").click()');
        await until(() => evaluate('Boolean(document.querySelector("#wincu-page-toolPreset-full"))'), 'native desktop settings');
      }
      await open();
      const shown = await evaluate(`({ full: document.querySelector('#wincu-page-toolPreset-full').checked,
        indicator: document.querySelector('#wincu-page-indicatorEnabled').checked,
        cursor: document.querySelector('#wincu-page-cursorIndicatorEnabled').checked,
        text: document.querySelector('#wincu-page-text').value,
        delay: document.querySelector('#wincu-page-delay').value,
        switches: [...document.querySelectorAll('[data-wincu-settings] input[role=switch]')].map(e=>({id:e.id,checked:e.checked})),
        body: document.querySelector('[data-wincu-settings]').innerText })`);
      assert.equal(shown.full, true); assert.equal(shown.indicator, true); assert.equal(shown.cursor, false);
      assert.equal(shown.text, 'Rufa智能体正在控制电脑'); assert.equal(shown.delay, '800'); assert.match(shown.body, /24\s*\/\s*24/);
      assert.equal(shown.switches.find(row => row.id.endsWith('-remoteIndicatorVisible'))?.checked, true);
      assert.equal((await configuration()).indicatorPosition, 'top'); assert.equal((await configuration()).stopShortcut, '');
      await fixture.capture('computer-use-settings');
      // Toggle only a configuration checkbox; do not preview, resume or operate the user's desktop.
      await evaluate('document.querySelector("#wincu-page-cursorIndicatorEnabled").click()');
      await evaluate('document.querySelector("[data-wincu-settings] button.wcu-primary").click()');
      await until(async () => (await configuration()).cursorIndicatorEnabled === true, 'native settings saved');
      await fixture.restart(); await open();
      assert.equal(await evaluate('document.querySelector("#wincu-page-cursorIndicatorEnabled").checked'), true);
      if (scenario.existing) assert.equal(await readFile(join(fixture.account.companyHome, 'unrelated.txt'), 'utf8'), 'preserve me');
      for (const marker of ['.rufa-computer-use-defaults-v1', '.rufa-remotion-defaults-v1']) assert.equal((await readFile(join(fixture.account.profileRoot, marker), 'utf8')).trim(), '1');
      const overlay = JSON.parse(await readFile(join(fixture.account.companyHome, 'enterprise-overlay.json'), 'utf8'));
      assert.equal(overlay.flatMap(row => row.insert ?? []).some(row => row.id === 'rufa-admin-tools'), scenario.role === 'admin');
      assert.equal((await fixture.api.json('GET', '/sessions')).sessions.length, 0); assert.equal(fixture.gatewayCalls, 0);
      t.diagnostic(`Native Electron settings: ${fixture.temporary}; no desktop input or model calls.`);
    });
}
