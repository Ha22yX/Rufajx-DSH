// The pinned Harness browser module protocol; no upstream rebuild is needed.
window.__ModuleLoader__.load({
  id: '@rufa/dsh-client-brand',
  factory(require) {
    const { createElement, useEffect, useRef, useState } = require('react');
    const { Menu, Input, Button, IconEllipsisOutlineMedium, IconUserOutlineMedium, IconSettingsOutlineMedium } = require('@deepseek-ai/dsh-client-ui-primitives');
    let companyUser = window.__RUFA_COMPANY_USER__;
    const validAccount = user => user && typeof user.username === 'string' && ['employee', 'admin'].includes(user.role);
    const profileListeners = new Set();
    function acceptProfile(user) {
      if (!validAccount(user)) return;
      companyUser = { username: user.username, displayName: typeof user.displayName === 'string' ? user.displayName : user.username,
        jobTitle: typeof user.jobTitle === 'string' ? user.jobTitle : '', role: user.role };
      for (const listener of profileListeners) listener(companyUser);
    }
    function useCompanyUser() {
      const [user, setUser] = useState(companyUser);
      useEffect(() => { profileListeners.add(setUser); setUser(companyUser); return () => { profileListeners.delete(setUser); }; }, []);
      return user;
    }
    const mark = window.__RUFA_COMPANY_MARK__;
    const mask = typeof mark === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(mark) ? `url("${mark}")` : undefined;
    function BrandMark({ size = 24, className }) {
      return createElement('span', {
        className, 'data-rufa-brand': 'mark', 'aria-hidden': true,
        style: { display: 'inline-block', flexShrink: 0, width: size, height: size, backgroundColor: 'currentColor',
          maskImage: mask, maskSize: 'contain', maskPosition: 'center', maskRepeat: 'no-repeat',
          WebkitMaskImage: mask, WebkitMaskSize: 'contain', WebkitMaskPosition: 'center', WebkitMaskRepeat: 'no-repeat' },
      });
    }
    function BrandName() {
      return createElement('span', {
        'data-rufa-brand': 'name',
        style: { fontSize: '14px', fontWeight: 600, letterSpacing: '-0.2px' },
      }, 'Rufajx-DSH');
    }
    function CompanyOnboarding({ complete }) {
      // Complete the original coordinator step; do not hide a live blocking dialog.
      useEffect(() => { complete(); }, [complete]);
      return null;
    }
    function CompanySettingsDocumentAction() { return null; }
    function CompanyManagedPermissionControl() { return null; }
    function CompanyHiddenSessionHeaderAction() { return null; }
    function CompanyHiddenNavigationEntry() { return null; }
    function CompanyHiddenTerminalGuide() { return createElement('span', { hidden: true, 'data-rufa-hidden-terminal-guide': '' }); }
    function installStartupGate(scope) {
      const startup = window.__RUFA_STARTUP__;
      if (!startup) return;
      const current = scope.uiSession.adapter.current;
      let sessionSource, offSession, done = false;
      const disposers = [];
      const cleanup = () => { done = true; offSession?.(); for (const off of disposers.splice(0)) off(); observer.disconnect(); };
      const check = () => {
        if (done) return;
        const workspaces = scope.workspaces.list.getSnapshot();
        const sessions = scope.sessions.list.getSnapshot();
        const binding = current.getSnapshot();
        if (sessionSource !== binding.hooks.session) {
          offSession?.(); sessionSource = binding.hooks.session;
          offSession = sessionSource?.subscribe(check);
        }
        const session = sessionSource?.getSnapshot();
        if (workspaces.error || session?.openState === 'error') { startup.stall(); return; }
        if (workspaces.phase !== 'ready' || workspaces.state !== 'idle' || sessions.phase !== 'ready') {
          startup.status('正在加载项目和会话…'); return;
        }
        if (!binding.key || !session || session.openState !== 'open' || session.removed) {
          startup.status('正在恢复上次的会话…'); return;
        }
        // Native navigation selects before the workspace membership echo can arrive.
        // Wait for that echo for a new blank session; saved orphan chats/subagents remain valid.
        const expectedWorkspace = !session.subagent && session.blank && workspaces.items.some(item => item.path === sessions.byId[binding.key]?.cwd);
        if (expectedWorkspace && !workspaces.items.some(item => item.sessionIds.includes(binding.key))) {
          startup.status('正在准备会话…'); return;
        }
        if (!document.querySelector('#root [class$="_centerCol"] [data-composer-card]')) return;
        cleanup(); startup.ready();
      };
      const observer = new MutationObserver(check);
      const root = document.getElementById('root');
      if (root) observer.observe(root, { childList: true, subtree: true });
      for (const source of [scope.workspaces.list, scope.sessions.list, current]) disposers.push(source.subscribe(check));
      check();
      return cleanup;
    }
    function CompanyAccount({ wide, openSettings, settingsShortcut }) {
      const user = useCompanyUser();
      const [open, setOpen] = useState(false);
      const trigger = useRef(null);
      const identity = validAccount(user) ? `${user.username} · 已登录` : '公司账号信息不可用';
      // Preserve the pinned AccountMenu's More launcher and geometry.
      // Keep settings and replace the original sign-in item with company identity.
      const anchor = createElement('button', {
        ref: trigger, type: 'button', className: 'rufa-more-trigger', 'data-collapsed': !wide, 'aria-label': '更多',
        'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value),
      }, createElement(IconEllipsisOutlineMedium, { size: 14 }), wide && createElement('span', { className: 'rufa-more-label' }, '更多'));
      return createElement('div', { className: 'rufa-more-root' },
        createElement('style', null, `
          .rufa-more-root { flex: 1; min-width: 0; }
          .rufa-more-anchor { width: 100%; }
          .rufa-more-trigger { user-select: none; display: flex; align-items: center; width: 100%; height: 32px; gap: 8px; padding: 6px 2px 6px 6px; border: 0; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 20px; cursor: pointer; }
          .rufa-more-trigger[data-collapsed='true'] { box-sizing: border-box; width: 36px; height: 36px; justify-content: center; gap: 0; padding: 0; }
          .rufa-more-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
          .rufa-more-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .rufa-more-menu[role='menu'] { min-width: 124px; max-width: 280px; padding: 4px; }
          .rufa-more-menu [role='menuitem'] { min-height: 40px; gap: 8px; padding: 8px 10px; border-radius: var(--dsw-radius-md); font-size: 14px; line-height: 22px; }
          .rufa-more-menu [role='menuitem'] > span:first-child:not(:last-child) { width: 16px; height: 16px; color: var(--dsw-alias-menu-icon); }
          .rufa-more-menu [role='menuitem'] > span:first-child:not(:last-child) svg { width: 16px; height: 16px; }
        `),
        createElement(Menu, {
          open, side: 'top', portal: true, autoFocus: true, anchor, className: 'rufa-more-anchor', listClassName: 'rufa-more-menu',
          items: [{
            id: 'settings', label: '设置', icon: createElement(IconSettingsOutlineMedium, { size: 16 }),
            ...(settingsShortcut ? { shortcut: settingsShortcut } : {}),
          }, {
            id: 'company-identity', disabled: true, icon: createElement(IconUserOutlineMedium, { size: 16 }),
            label: createElement('span', { 'data-rufa-account': validAccount(user) ? 'signed-in' : 'unavailable' }, identity),
          }],
          onClose: () => setOpen(false), onSelect: id => {
            if (id === 'settings') { setOpen(false); trigger.current?.focus(); openSettings(); }
          },
        }));
    }
    function CompanyAccountSection() {
      const user = useCompanyUser();
      const [pending, setPending] = useState(false), [message, setMessage] = useState('');
      const [profileSaving, setProfileSaving] = useState(false), [profileMessage, setProfileMessage] = useState('');
      const [displayName, setDisplayName] = useState(user?.displayName || ''), [jobTitle, setJobTitle] = useState(user?.jobTitle || '');
      const savingProfile = useRef(false);
      const form = useRef(null), working = useRef(false), mounted = useRef(false);
      useEffect(() => { setDisplayName(user?.displayName || ''); setJobTitle(user?.jobTitle || ''); }, [user?.displayName, user?.jobTitle]);
      useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; form.current?.reset(); };
      }, []);
      if (!validAccount(user)) return null;
      const role = user.role === 'admin' ? '管理' : '员工';
      const busy = pending || profileSaving;
      const bridgeAvailable = typeof window.rufaAccount?.changePassword === 'function';
      const canSaveProfile = typeof window.rufaAccount?.updateProfile === 'function';
      const saveProfile = async event => {
        event.preventDefault(); if (working.current || savingProfile.current || !canSaveProfile) return;
        if (!displayName.trim() || displayName.length > 128 || jobTitle.length > 100) { setProfileMessage('姓名须为 1–128 位，职位最多 100 位。'); return; }
        savingProfile.current = true; setProfileSaving(true); setProfileMessage('');
        try {
          const result = await window.rufaAccount.updateProfile({ displayName, jobTitle });
          if (result.ok) acceptProfile(result.value);
          if (mounted.current) setProfileMessage(result.ok ? '资料已保存。' : result.error?.message || '资料保存失败，请稍后重试。');
        } catch { if (mounted.current) setProfileMessage('资料保存失败，请检查连接后重试。'); }
        finally { savingProfile.current = false; if (mounted.current) setProfileSaving(false); }
      };
      const submit = async event => {
        event.preventDefault(); if (working.current || savingProfile.current || !bridgeAvailable) return;
        const elements = event.currentTarget.elements;
        const input = { currentPassword: elements.currentPassword.value, newPassword: elements.newPassword.value };
        let confirmation = elements.confirmPassword.value;
        event.currentTarget.reset(); setMessage('');
        if (input.newPassword !== confirmation) {
          input.currentPassword = ''; input.newPassword = ''; confirmation = '';
          setMessage('两次新密码不一致，请重新输入。'); return;
        }
        confirmation = ''; working.current = true; setPending(true);
        try {
          const result = await window.rufaAccount.changePassword(input);
          if (!mounted.current) return;
          setMessage(result.ok ? '密码已修改，正在返回登录页…' : result.error?.message || '密码修改未完成，请稍后重试。');
        } catch { if (mounted.current) setMessage('密码修改未完成，请检查连接后重试。'); }
        finally {
          input.currentPassword = ''; input.newPassword = ''; working.current = false;
          if (mounted.current) { form.current?.reset(); setPending(false); }
        }
      };
      const infoRow = (label, value) => createElement('div', { className: 'rufa-account-row', key: label },
        createElement('dt', null, label), createElement('dd', null, value));
      const passwordField = (name, label, placeholder, minLength) => createElement('label', { className: 'rufa-account-field', htmlFor: `rufa-${name}` },
        createElement('span', null, label), createElement(Input, { id: `rufa-${name}`, name, type: 'password', required: true,
          autoComplete: name === 'currentPassword' ? 'current-password' : 'new-password', minLength, maxLength: 128,
          placeholder, disabled: busy, className: 'rufa-account-input' }));
      return createElement('section', { 'data-rufa-account-details': '', className: 'rufa-account-section' },
        createElement('style', null, `
          .rufa-account-section { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
          .rufa-account-section h2 { font-size: 18px; line-height: 26px; font-weight: 600; margin: 0 0 20px; }
          .rufa-account-profile { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
          .rufa-account-avatar { display: grid; place-items: center; width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%; background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
          .rufa-account-name { font-weight: 500; overflow-wrap: anywhere; }
          .rufa-account-subtitle { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
          .rufa-account-details { margin: 0 0 24px; }
          .rufa-account-row { display: flex; gap: 16px; justify-content: space-between; padding: 8px 0; }
          .rufa-account-row dt { color: var(--dsw-alias-label-secondary); flex-shrink: 0; }
          .rufa-account-row dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
          .rufa-account-password { padding-top: 20px; border-top: 0.5px solid var(--dsw-alias-border-l4); }
          .rufa-account-password h3 { font-size: 14px; line-height: 22px; font-weight: 600; margin: 0 0 6px; }
          .rufa-account-help { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; margin: 0 0 18px; }
          .rufa-account-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
          .rufa-account-input { width: 100%; }
          .rufa-account-actions { display: flex; justify-content: flex-end; padding-top: 2px; }
          .rufa-account-message { margin: 14px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
        `),
        createElement('h2', null, '账号信息'),
        createElement('div', { className: 'rufa-account-profile' },
          createElement('div', { className: 'rufa-account-avatar', 'aria-hidden': true }, createElement(IconUserOutlineMedium, { size: 24 })),
          createElement('div', null, createElement('div', { className: 'rufa-account-name' }, user.displayName || user.username),
            createElement('div', { className: 'rufa-account-subtitle' }, '如发机械有限公司'))),
        createElement('dl', { className: 'rufa-account-details' }, infoRow('账号', user.username), infoRow('角色', role), infoRow('状态', '已登录')),
        createElement('form', { onSubmit: saveProfile, className: 'rufa-account-details', 'aria-busy': profileSaving },
          createElement('label', { className: 'rufa-account-field', htmlFor: 'rufa-display-name' }, createElement('span', null, '姓名'),
            createElement(Input, { id: 'rufa-display-name', name: 'displayName', value: displayName, onChange: event => setDisplayName(event.target.value),
              required: true, maxLength: 128, disabled: busy, autoComplete: 'name', className: 'rufa-account-input' })),
          createElement('label', { className: 'rufa-account-field', htmlFor: 'rufa-job-title' }, createElement('span', null, '职位'),
            createElement(Input, { id: 'rufa-job-title', name: 'jobTitle', value: jobTitle, onChange: event => setJobTitle(event.target.value),
              maxLength: 100, disabled: busy, placeholder: '选填，可留空', autoComplete: 'organization-title', className: 'rufa-account-input' })),
          createElement('div', { className: 'rufa-account-actions' }, createElement(Button, { type: 'submit', variant: 'primary', disabled: busy || !canSaveProfile }, profileSaving ? '正在保存…' : '保存资料')),
          createElement('p', { className: 'rufa-account-message', role: 'status', 'aria-live': 'polite', hidden: !profileMessage }, profileMessage)),
        createElement('form', { ref: form, className: 'rufa-account-password', onSubmit: submit, 'aria-busy': pending },
          createElement('h3', null, '修改密码'),
          createElement('p', { className: 'rufa-account-help' }, '修改后所有设备都需重新登录。请先结束运行中的任务；未同步会话将在下次登录同一账号时尝试恢复。'),
          passwordField('currentPassword', '原密码', '请输入原密码'),
          passwordField('newPassword', '新密码', '12–128 位', 12),
          passwordField('confirmPassword', '确认新密码', '再次输入新密码', 12),
          createElement('div', { className: 'rufa-account-actions' }, createElement(Button, { type: 'submit', variant: 'primary', disabled: busy || !bridgeAvailable }, pending ? '正在修改…' : '修改密码')),
          !bridgeAvailable && createElement('p', { className: 'rufa-account-message' }, '请在 Rufajx-DSH 桌面客户端中修改密码。'),
          createElement('p', { className: 'rufa-account-message', role: 'status', 'aria-live': 'polite', hidden: !message }, message)));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.inject(['slots'], scope => scope.effect(() => {
          const slots = scope.slots[Symbol.for('cordis.original')] ?? scope.slots;
          const hidden = new Map([['sidebar.panellist', 'plugins'], ['settings.section', 'better-sidebar']]);
          const restores = [];
          let active = true;
          if (['entries', 'entriesOfSlot'].some(name => typeof slots[name] !== 'function')) {
            throw new Error('Harness导航接口已变化，需要更新公司适配。');
          }
          // Navigation reads the metadata, not the rendered icon. Remove the
          // exact rows before layout/keyboard selection, keeping all providers.
          for (const name of ['entries', 'entriesOfSlot']) {
            const descriptor = Object.getOwnPropertyDescriptor(slots, name), original = slots[name];
            const cache = new WeakMap();
            const filtered = function(key) {
              const rows = original.call(this, key), id = active && hidden.get(key);
              if (!id) return rows;
              let value = cache.get(rows);
              if (!value) {
                value = rows.some(row => row.options.id === id) ? rows.filter(row => row.options.id !== id) : rows;
                cache.set(rows, value);
              }
              return value;
            };
            Object.defineProperty(slots, name, { configurable: true, writable: true, value: filtered });
            restores.push(() => {
              if (slots[name] !== filtered) return;
              if (descriptor) Object.defineProperty(slots, name, descriptor);
              else delete slots[name];
            });
          }
          return () => { active = false; for (const restore of restores.reverse()) restore(); };
        }));
        window.__RUFA_FILE_VERSIONS_UI__?.(ctx, { createElement, useEffect, useRef, useState });
        window.__RUFA_PREFERENCES_UI__?.(ctx, { createElement, useEffect, useRef, useState, Input, Button });
        ctx.inject(['layout'], scope => scope.effect(() => {
          let frame, timer;
          const clear = () => { clearTimeout(timer); frame?.removeAttribute('data-rufa-sidebar-motion'); };
          const prepare = event => {
            const clickedToggle = event.type === 'click' && event.target instanceof Element
              && event.target.closest('[class$="_sidebarCol"] button[class$="_toggle"]');
            const keyboardToggle = event.type === 'keydown' && event.code === 'KeyB' && event.altKey && (event.ctrlKey || event.metaKey);
            if (!clickedToggle && !keyboardToggle) return;
            clear(); frame = document.querySelector('#root [class$="_frame"]');
            if (!frame || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            // Arm the transition before React changes the tracks, including the first toggle.
            frame.setAttribute('data-rufa-sidebar-motion', '');
            void getComputedStyle(frame).gridTemplateColumns;
            timer = setTimeout(clear, 350);
          };
          document.addEventListener('click', prepare, true);
          document.addEventListener('keydown', prepare, true);
          window.addEventListener('resize', clear);
          return () => { clear(); document.removeEventListener('click', prepare, true); document.removeEventListener('keydown', prepare, true); window.removeEventListener('resize', clear); };
        }));
        ctx.inject(['workspaces', 'sessions', 'uiSession'], scope => scope.effect(() => installStartupGate(scope)));
        ctx.inject(['sessions', 'uiSession', 'uiWorkspace', 'layout', 'conversation'], scope => scope.effect(() =>
          window.__RUFA_UNUSED_SESSION_UI__?.(scope, window.rufaAccount, window.__RUFA_EMPTY_POLICY__)));
        ctx.inject(['commandUi'], scope => {
          const service = scope.commandUi[Symbol.for('cordis.original')] ?? scope.commandUi;
          scope.effect(() => {
            // Pinned Harness uses this candidate source for both + and / menus.
            // Filter before keyboard selection, preserving the native file/goal/plan actions.
            // Command execution and background compaction are not changed by this UI policy.
            const original = Object.getOwnPropertyDescriptor(service, 'candidates');
            const candidates = service.candidates;
            if (typeof candidates !== 'function') throw new Error('Harness菜单接口已变化，需要更新公司适配。');
            const visible = new Set(['file', 'goal', 'plan']);
            Object.defineProperty(service, 'candidates', {
              configurable: true,
              value: async function(session, request) {
                const rows = await candidates.call(this, session, request);
                return rows.filter(row => visible.has(row.name));
              },
            });
            return () => {
              if (original) Object.defineProperty(service, 'candidates', original);
              else delete service.candidates;
            };
          });
        });
        ctx.effect(() => {
          let active = true;
          const off = window.rufaAccount?.onProfileChanged?.(user => { if (active) acceptProfile(user); });
          void window.rufaAccount?.profile?.().then(result => { if (active && result.ok) acceptProfile(result.value); }).catch(() => {});
          return () => { active = false; off?.(); };
        });
        ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
          name: 'sidebar.brand.mark', priority: -100,
        }, BrandMark));
        ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
          name: 'conversation.hero.brand.mark', priority: -100,
        }, BrandMark));
        ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
          name: 'sidebar.brand.name', priority: -100,
        }, BrandName));
        ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher', priority: -100 }, CompanyAccount));
        // Replace only the native open-document cell; SettingsRoot owns its separate Close button.
        ctx.slots.inject('settings.action', () => ctx.slots.register({
          name: 'settings.action', id: 'open-document', order: 0, priority: -100,
        }, CompanySettingsDocumentAction));
        // Replace exactly these native header cells. The separate corner expand
        // control, schedule catalog and extension utilities retain their slots.
        ctx.slots.inject('conversation.session.header.utilities', function* () {
          for (const [id, order] of [['open-in-app', -10], ['session-log-download', 0]]) {
            yield ctx.slots.register({
              name: 'conversation.session.header.utilities', id, order, priority: -100,
            }, CompanyHiddenSessionHeaderAction);
          }
        });
        // Hide only the terminal provider's Start-page card (including its shell
        // menu). Terminal tabs, shortcuts, services and Agent tools stay native.
        ctx.slots.inject('sidebar.right.tab.guide.entry', () => ctx.slots.register({
          name: 'sidebar.right.tab.guide.entry', key: '@deepseek-ai/dsh-client-ui-sidebar-terminal', priority: -100,
        }, CompanyHiddenTerminalGuide));
        // Company policy fixes the permission preset in the host. Remove only its selectors;
        // tool approvals, questions, and administrator confirmations retain their own surfaces.
        ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({
          name: 'conversation.input.permission', priority: -100,
        }, CompanyManagedPermissionControl));
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item', id: 'permission', order: -20, priority: -100,
        }, CompanyManagedPermissionControl));
        // The native settings shell maps id=account to its User icon; the official account plugin is disabled.
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'account', order: -10, label: () => '账号信息' }, CompanyAccountSection));
        // These lifecycle-owned cells notify native navigation/version caches
        // on load, unload and HMR. Their rows are filtered above, so no empty
        // button or spacer is rendered. Plugin pages and services stay live.
        for (const [name, id] of [['sidebar.panellist', 'plugins'], ['settings.section', 'better-sidebar']]) {
          ctx.slots.inject(name, () => ctx.slots.register({ name, id, priority: -100 }, CompanyHiddenNavigationEntry));
        }
        ctx.slots.inject('settings.onboarding', function* () {
          for (const [id, order] of [['welcome-notice', -100], ['deepseek-official', 0]]) {
            yield ctx.slots.register({
              name: 'settings.onboarding', id, order, priority: -100,
            }, CompanyOnboarding);
          }
        });
      },
    };
  },
});
