'use strict';

const { buildSettingsSectionScript } = require('./settings-jump');
const {
  PAGE_HELPERS,
  sleep,
  waitUntil,
  pageEval,
  pageScript,
  clickNamed,
  pressEnter,
  makeRecorder,
  connectConfiguredWorkspace,
} = require('./workspace-connect');

const QA_REQUIRED_STEPS = [
  'workspace.picker',
  'workspace.connected',
  'frame.fourColumn',
  'composer.card',
  'composer.textarea',
  'composer.commands',
  'composer.send',
  'composer.access',
  'composer.skillMenuAbsent',
  'composer.pathSourceAbsent',
  'remote.unavailable',
  'remote.notListening',
  'titlebar.sessionLog',
  'titlebar.branch',
  'titlebar.commit',
  'titlebar.git',
  'titlebar.terminal',
  'titlebar.surfaces',
  'titlebar.branchMenu',
  'titlebar.gitMenu',
  'terminal.drawer',
  'terminal.new',
  'surfaces.open',
  'files.panel',
  'files.search',
  'files.readme',
  'files.note',
  'files.mentionVisible',
  'files.mentionAppended',
  'agents.panel',
  'agents.empty',
  'diff.panel',
  'browser.panel',
  'browser.url',
  'terminal.surface',
  'settings.trigger',
  'appearance.choose',
  'appearance.browse',
  'appearance.noSourceDump',
  'gallery.dialog',
  'gallery.sources',
  'gallery.addSource',
  'mcp.heading',
  'mcp.search',
  'mcp.add',
  'skills.heading',
  'skills.add',
  'plugins.heading',
  'market.section',
  'market.discover',
  'market.installed',
  'plugin.rlhbot.tab',
  'plugin.rlhbot.page',
];

/**
 * Drive one assembled-desktop UI walk against a live harness webContents.
 * Callers must attach the CDP debugger when they need Escape via pressEscape.
 *
 * @param {Electron.WebContents} wc - harness page (BrowserView), not the boot shell.
 * @param {{ pressEscape: Function, clickTitlebarButton: Function, surfacesPattern: string, terminalPattern: string }} helpers
 * @returns {Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, optional?: boolean, detail: string }> }>}
 */
async function runReleaseUiWalk(wc, helpers) {
  const steps = [];
  const rec = makeRecorder(steps);

  const dismiss = async () => {
    for (let i = 0; i < 4; i += 1) {
      await helpers.pressEscape(wc);
      await sleep(120);
    }
  };

  const openSurface = async (kind) => {
    await pageScript(wc, `
      window.dispatchEvent(new CustomEvent('rlhd-open-surface', { detail: { kind: args.kind } }));
      return true;
    `, { kind });
  };

  const openSettings = async (section) => {
    const opened = await wc.executeJavaScript(buildSettingsSectionScript(section));
    await sleep(400);
    return opened;
  };

  try {
  await dismiss();
  if (helpers.skipWorkspaceConnect) {
    rec('workspace.picker', true, 'connected before titlebar hits');
    rec('workspace.connected', true, helpers.workspacePath || '');
  } else {
    await connectConfiguredWorkspace(wc, helpers, rec);
  }

  const frame = await pageEval(wc, () => {
    const el = document.querySelector('[class*="frame"]');
    const grid = el ? getComputedStyle(el).gridTemplateColumns.trim() : '';
    return {
      present: Boolean(el),
      columns: grid ? grid.split(/\s+/).length : 0,
      grid,
      collapsed: el ? el.getAttribute('data-surfaces-collapsed') : null,
    };
  });
  rec('frame.fourColumn', frame?.columns === 4, frame?.grid || 'missing frame');

  const composer = await pageEval(wc, () => {
    const card = document.querySelector('[data-composer-card]');
    return {
      card: rlhShown(card),
      textarea: Boolean(card && rlhShown(card.querySelector('textarea'))),
      commands: Boolean(rlhFind('^commands$|^命令$')),
      send: Boolean(rlhFind('send message|发送消息')),
      access: Boolean(rlhFind('access mode|访问模式')),
    };
  });
  rec('composer.card', composer?.card, '');
  rec('composer.textarea', composer?.textarea, '');
  rec('composer.commands', composer?.commands, '');
  rec('composer.send', composer?.send, '');
  rec('composer.access', composer?.access, '');

  await pageEval(wc, () => {
    const ta = document.querySelector('[data-composer-card] textarea');
    if (!ta) return false;
    ta.focus();
    return rlhSetValue(ta, '$fo');
  });
  await sleep(500);
  const skillMenu = await pageEval(wc, () => ({
    foo: Boolean(rlhFind('foo-skill')),
    menuitem: Boolean(document.querySelector('[role="menuitem"]') && rlhShown(document.querySelector('[role="menuitem"]'))),
    typed: (document.querySelector('[data-composer-card] textarea') || {}).value || '',
  }));
  rec(
    'composer.skillMenuAbsent',
    !skillMenu?.foo && skillMenu?.typed === '$fo',
    skillMenu?.foo
      ? 'foo-skill menu opened'
      : `typed=${skillMenu?.typed || ''}; menuitem=${Boolean(skillMenu?.menuitem)}`,
  );

  await pageEval(wc, () => {
    const ta = document.querySelector('[data-composer-card] textarea');
    if (!ta) return false;
    ta.focus();
    return rlhSetValue(ta, '@');
  });
  await sleep(700);
  const pathSource = await pageEval(wc, () => ({
    pathRows: document.querySelectorAll('[data-source="path"]').length,
    typed: (document.querySelector('[data-composer-card] textarea') || {}).value || '',
  }));
  rec(
    'composer.pathSourceAbsent',
    pathSource?.pathRows === 0,
    pathSource?.pathRows
      ? `desktop path source rows=${pathSource.pathRows}`
      : `typed=${pathSource?.typed || ''}`,
  );
  await pageEval(wc, () => {
    const ta = document.querySelector('[data-composer-card] textarea');
    return ta ? rlhSetValue(ta, '') : false;
  });

  const remoteSnap = typeof helpers.probeRemote === 'function'
    ? await helpers.probeRemote()
    : null;
  rec(
    'remote.unavailable',
    remoteSnap != null && remoteSnap.available === false && remoteSnap.enabled === false,
    remoteSnap ? JSON.stringify(remoteSnap).slice(0, 200) : 'helpers.probeRemote missing',
  );
  rec(
    'remote.notListening',
    remoteSnap != null && remoteSnap.listening !== true,
    remoteSnap ? `listening=${remoteSnap.listening}` : 'helpers.probeRemote missing',
  );
  const remoteFooter = await pageEval(wc, () => {
    const trigger = document.querySelector('[data-rlh-remote-trigger], [data-sidebar-action="remote"]');
    if (trigger && rlhShown(trigger)) return 'trigger';
    return rlhFind('^remote$|^远程$') ? 'label' : null;
  });
  rec('remote.footerAbsent', remoteFooter == null, remoteFooter || 'no remote footer', true);

  const commandsClicked = await clickNamed(wc, '^commands$|^命令$');
  if (commandsClicked) {
    const menu = await waitUntil(() => pageEval(wc, () =>
      Boolean(document.querySelector('[role="listbox"], [role="menu"]'))), 3_000);
    rec('composer.commandsMenu', Boolean(menu), menu ? 'opened' : 'no menu', true);
    await dismiss();
  } else {
    rec('composer.commandsMenu', true, 'commands disabled or missing', true);
  }

  const titlebar = await pageEval(wc, () => {
    const bar = document.querySelector('#rlhd-shell-titlebar-trailing');
    return {
      sessionLog: Boolean(rlhFind('session log|会话日志', bar)),
      branch: Boolean(rlhFind('switch branch|切换分支', bar)),
      commit: Boolean(rlhFind('^commit|提交', bar)),
      git: Boolean(rlhFind('git actions|git 操作', bar)),
      terminal: Boolean(rlhFind('terminal|终端', bar)),
      surfaces: Boolean(rlhFind('right panel|surfaces|右侧栏', bar)),
    };
  });
  rec('titlebar.sessionLog', titlebar?.sessionLog, '');
  rec('titlebar.branch', titlebar?.branch, '');
  rec('titlebar.commit', titlebar?.commit, '');
  rec('titlebar.git', titlebar?.git, '');
  rec('titlebar.terminal', titlebar?.terminal, '');
  rec('titlebar.surfaces', titlebar?.surfaces, '');

  await helpers.clickTitlebarButton(wc, 'switch branch|切换分支');
  const branchMenu = await waitUntil(() => pageEval(wc, () => {
    const bar = document.querySelector('#rlhd-shell-titlebar-trailing');
    const btn = bar && rlhFind('switch branch|切换分支', bar);
    return Boolean((btn && btn.getAttribute('aria-expanded') === 'true') || document.querySelector('[role="menu"]'));
  }), 5_000);
  rec('titlebar.branchMenu', Boolean(branchMenu), branchMenu ? 'opened' : 'did not open');
  await dismiss();

  await helpers.clickTitlebarButton(wc, 'git actions|git 操作');
  const gitMenu = await waitUntil(() => pageEval(wc, () => Boolean(document.querySelector('[role="menu"]'))), 5_000);
  rec('titlebar.gitMenu', Boolean(gitMenu), gitMenu ? 'opened' : 'did not open');
  await dismiss();
  const drawerOpen = await pageEval(wc, () => {
    const root = document.querySelector('[data-terminal-owner="drawer"]');
    return Boolean(root && rlhShown(root) && root.getBoundingClientRect().height > 8);
  });
  if (!drawerOpen) {
    await helpers.clickTitlebarButton(wc, helpers.terminalPattern);
  }
  const drawer = await waitUntil(() => pageEval(wc, () => {
    const root = document.querySelector('[data-terminal-owner="drawer"]');
    if (!root || !rlhShown(root) || root.getBoundingClientRect().height < 8) return null;
    return {
      newTerminal: Boolean(rlhFind('new terminal|新建终端', root)),
    };
  }), 10_000);
  rec('terminal.drawer', Boolean(drawer), drawer ? '' : 'drawer did not open');
  rec('terminal.new', Boolean(drawer?.newTerminal), '');
  if (drawer) {
    await helpers.clickTitlebarButton(wc, helpers.terminalPattern);
    await sleep(250);
  }

  const surfacesOpen = await pageEval(wc, () => {
    const frameEl = document.querySelector('[class*="frame"]');
    return Boolean(frameEl && frameEl.getAttribute('data-surfaces-collapsed') !== 'true');
  });
  if (!surfacesOpen) {
    await helpers.clickTitlebarButton(wc, helpers.surfacesPattern);
  }
  const surfaces = await waitUntil(() => pageEval(wc, () => {
    const frameEl = document.querySelector('[class*="frame"]');
    if (!frameEl || frameEl.getAttribute('data-surfaces-collapsed') === 'true') return null;
    const empty = document.querySelector('[data-surfaces-empty]');
    const cards = empty && rlhShown(empty)
      ? Array.from(empty.querySelectorAll('button')).map((el) => ({
        label: rlhLabel(el).slice(0, 60),
        disabled: el.disabled,
      }))
      : [];
    return { empty: Boolean(empty && rlhShown(empty)), cards };
  }), 10_000);
  rec('surfaces.open', Boolean(surfaces), surfaces ? '' : 'surfaces column stayed collapsed');

  if (surfaces?.empty) {
    const labels = (surfaces.cards || []).map((c) => c.label).join(' | ');
    const enabled = (re) => (surfaces.cards || []).some((c) => re.test(c.label) && !c.disabled);
    rec('surfaces.emptyCards', (surfaces.cards || []).length >= 5, labels, true);
    rec('surfaces.browserEnabled', enabled(/browser|浏览器/i), '', true);
    rec('surfaces.diffEnabled', enabled(/diff|差异/i), '', true);
    const clickedFiles = await pageEval(wc, () => {
      const empty = document.querySelector('[data-surfaces-empty]');
      const btn = empty && Array.from(empty.querySelectorAll('button')).find((el) =>
        /^(files|文件)(\s|$)/i.test(rlhLabel(el)) && !el.disabled);
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clickedFiles) await openSurface('files');
  } else {
    rec('surfaces.emptyCards', true, 'already occupied', true);
    rec('surfaces.browserEnabled', true, 'already occupied', true);
    rec('surfaces.diffEnabled', true, 'already occupied', true);
    await openSurface('files');
  }

  const files = await waitUntil(() => pageEval(wc, () => {
    const panel = document.querySelector('[data-files-panel]');
    if (!panel || !rlhShown(panel)) return null;
    const text = panel.innerText || '';
    const readme = /README\.md/i.test(text);
    const note = /note\.md/i.test(text);
    if (!readme && !note) return null;
    return {
      search: Boolean(rlhFind('search files|搜索文件', panel)),
      readme,
      note,
      text: text.slice(0, 160),
    };
  }), 20_000);
  const filesSnap = files || await pageEval(wc, () => {
    const panel = document.querySelector('[data-files-panel]');
    if (!panel) return null;
    const text = panel.innerText || '';
    return {
      search: Boolean(rlhFind('search files|搜索文件', panel)),
      readme: /README\.md/i.test(text),
      note: /note\.md/i.test(text),
      text: text.slice(0, 160),
    };
  });
  rec('files.panel', Boolean(filesSnap), filesSnap ? '' : 'files panel missing');
  rec('files.search', Boolean(filesSnap?.search), '');
  rec('files.readme', Boolean(filesSnap?.readme), filesSnap?.readme ? '' : (filesSnap?.text || 'README.md not listed'));
  rec('files.note', Boolean(filesSnap?.note), filesSnap?.note ? '' : (filesSnap?.text || 'note.md not listed'));
  const mention = filesSnap
    ? await waitUntil(() => pageEval(wc, () => {
      const panel = document.querySelector('[data-files-panel]');
      return panel && rlhFind('mention in composer|引用到输入框', panel);
    }), 10_000)
    : null;
  rec('files.mentionVisible', Boolean(mention), mention ? 'visible' : 'mention control missing');
  if (mention) {
    await pageEval(wc, () => {
      const panel = document.querySelector('[data-files-panel]');
      if (!panel) return false;
      const row = Array.from(panel.querySelectorAll('li')).find((el) =>
        rlhShown(el) && /^note\.md$/i.test((el.querySelector('span') && el.querySelector('span').textContent) || rlhLabel(el)));
      const btn = (row && rlhFind('mention in composer|引用到输入框', row))
        || rlhFind('mention in composer|引用到输入框', panel);
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    });
    const draft = await waitUntil(() => pageEval(wc, () => {
      const ta = document.querySelector('[data-composer-card] textarea');
      const value = (ta && ta.value) || '';
      return /\[note\.md\]\(note\.md\)/.test(value) ? value : null;
    }), 5_000);
    rec('files.mentionAppended', Boolean(draft), draft || 'composer draft missing markdown link');
  } else {
    rec('files.mentionAppended', false, 'mention control missing');
  }

  if (filesSnap?.search) {
    await pageEval(wc, () => {
      const panel = document.querySelector('[data-files-panel]');
      const input = panel && (rlhFind('search files|搜索文件', panel) || panel.querySelector('input'));
      if (!input) return false;
      input.focus();
      return rlhSetValue(input, 'note');
    });
    const filtered = await waitUntil(() => pageEval(wc, () => {
      const panel = document.querySelector('[data-files-panel]');
      return Boolean(panel && /note\.md/i.test(panel.innerText || ''));
    }), 8_000);
    rec('files.searchFilter', Boolean(filtered), filtered ? 'note.md' : 'filter missed note.md', true);
  }

  await openSurface('agents');
  const agents = await waitUntil(() => pageEval(wc, () => {
    const panel = document.querySelector('[data-agents-panel]');
    if (!panel || !rlhShown(panel)) return null;
    const text = panel.innerText || '';
    return { empty: /no agents yet|还没有子代理/i.test(text) };
  }), 10_000);
  rec('agents.panel', Boolean(agents), '');
  rec('agents.empty', Boolean(agents?.empty), agents?.empty ? '' : 'empty copy missing');

  await openSurface('diff');
  const diff = await waitUntil(() => pageEval(wc, () => {
    const panel = document.querySelector('[data-diff-panel]');
    if (!panel || !rlhShown(panel)) return null;
    const text = panel.innerText || '';
    if (/差异仅适用于|only available in Git/i.test(text)) return null;
    return { text: text.slice(0, 120) };
  }), 12_000);
  const diffSnap = diff || await pageEval(wc, () => {
    const panel = document.querySelector('[data-diff-panel]');
    return panel && rlhShown(panel) ? { text: (panel.innerText || '').slice(0, 120) } : null;
  });
  rec('diff.panel', Boolean(diffSnap) && !/差异仅适用于|only available in Git/i.test(diffSnap?.text || ''), diffSnap?.text || '');

  await openSurface('preview');
  const browser = await waitUntil(() => pageEval(wc, () => {
    const panel = document.querySelector('[data-preview-panel]');
    if (!panel || !rlhShown(panel)) return null;
    const unavailable = panel.querySelector('[data-preview-unavailable]');
    const toolbar = panel.querySelector('[data-preview-toolbar]');
    const url = Boolean(
      rlhFind('search or enter url|搜索或输入 url', panel)
      || panel.querySelector('input'),
    );
    return {
      unavailable: Boolean(unavailable && rlhShown(unavailable)),
      toolbar: Boolean(toolbar && rlhShown(toolbar)),
      url,
    };
  }), 10_000);
  rec('browser.panel', Boolean(browser) && !browser.unavailable, browser?.unavailable ? 'preview unavailable' : '');
  rec('browser.url', Boolean(browser?.url || browser?.toolbar), '');

  await openSurface('terminal');
  const termSurface = await waitUntil(() => pageEval(wc, () => {
    const root = document.querySelector('[data-terminal-owner="surface"]');
    return Boolean(root && rlhShown(root) && root.getBoundingClientRect().height > 8);
  }), 10_000);
  rec('terminal.surface', Boolean(termSurface), '');

  await dismiss();
  const settingsTrigger = await pageEval(wc, () =>
    Boolean(document.querySelector('[data-rlh-settings-trigger]')));
  rec('settings.trigger', settingsTrigger, '');

  const appearanceOpened = await openSettings('appearance');
  const appearance = await waitUntil(() => pageEval(wc, () => {
    const dialog = rlhDialog();
    if (!dialog) return null;
    const nav = document.querySelector('[data-rlh-settings-section="appearance"]');
    const text = dialog.innerText || '';
    return {
      nav: Boolean(nav),
      heading: Boolean(rlhHeading('wallpaper|背景图', dialog)),
      choose: Boolean(rlhFind('choose image|选择图片', dialog)),
      browse: Boolean(rlhFind('browse gallery|浏览图库', dialog)),
      bingDaily: /Bing daily wallpapers|Bing 每日壁纸/.test(text),
      catalogUrls: /Wallpaper catalog URLs|壁纸目录地址/.test(text),
      placeholder: Boolean(dialog.querySelector('input[placeholder="https://example.com/wallpapers.json"]')),
    };
  }), 10_000);
  rec('appearance.choose', Boolean(appearanceOpened && appearance?.choose), appearanceOpened ? '' : 'settings did not open');
  rec('appearance.browse', Boolean(appearance?.browse), '');
  rec(
    'appearance.noSourceDump',
    Boolean(appearance) && !appearance.bingDaily && !appearance.catalogUrls && !appearance.placeholder,
    appearance?.bingDaily || appearance?.catalogUrls || appearance?.placeholder
      ? 'Appearance still lists gallery sources'
      : '',
  );

  if (appearance?.browse) {
    await clickNamed(wc, 'browse gallery|浏览图库');
  }
  const gallery = await waitUntil(() => pageEval(wc, () => {
    const galleryDialog = rlhDialogNamed('browse gallery|浏览图库');
    if (!galleryDialog) return null;
    return {
      sources: Boolean(rlhFind('^sources$|^图源$', galleryDialog)),
      items: (galleryDialog.innerText || '').slice(0, 80),
    };
  }), 15_000);
  rec('gallery.dialog', Boolean(gallery), gallery ? '' : 'browse gallery dialog missing');
  rec('gallery.sources', Boolean(gallery?.sources), gallery?.sources ? '' : 'Sources missing — wallpaper shell inject?');

  if (gallery?.sources) {
    await clickNamed(wc, '^sources$|^图源$');
    const sourcesPane = await waitUntil(() => pageEval(wc, () => {
      const galleryDialog = rlhDialogNamed('browse gallery|浏览图库');
      if (!galleryDialog) return null;
      return {
        addSource: Boolean(rlhFind('add source|新增图源', galleryDialog)),
        hint: /Categories come from here|分类来自这里/i.test(galleryDialog.innerText || ''),
      };
    }), 8_000);
    rec('gallery.addSource', Boolean(sourcesPane?.addSource), sourcesPane?.hint ? 'hint visible' : '');
  } else {
    rec('gallery.addSource', false, 'sources control missing');
  }

  await dismiss();
  await sleep(300);

  const mcpOpened = await openSettings('mcp');
  const mcp = await waitUntil(() => pageEval(wc, () => {
    const dialog = rlhDialog();
    if (!dialog) return null;
    return {
      heading: Boolean(rlhHeading('mcp servers|mcp 服务器', dialog)),
      search: Boolean(rlhFind('search name|搜索名称', dialog) || dialog.querySelector('input[type="search"], [role="searchbox"]')),
      add: Boolean(rlhFind('add server|添加服务器', dialog)),
    };
  }), 10_000);
  rec('mcp.heading', Boolean(mcpOpened && mcp?.heading), mcpOpened ? '' : 'mcp section missing');
  rec('mcp.search', Boolean(mcp?.search), '');
  rec('mcp.add', Boolean(mcp?.add), '');

  const skillsOpened = await openSettings('skills');
  const skills = await waitUntil(() => pageEval(wc, () => {
    const dialog = rlhDialog();
    if (!dialog) return null;
    return {
      heading: Boolean(rlhHeading('^skills$|^技能$', dialog)),
      add: Boolean(rlhFind('add skill|添加技能', dialog)),
    };
  }), 10_000);
  rec('skills.heading', Boolean(skillsOpened && skills?.heading), '');
  rec('skills.add', Boolean(skills?.add), '');

  const pluginsOpened = await openSettings('plugins');
  const plugins = await waitUntil(() => pageEval(wc, () => {
    const dialog = rlhDialog();
    const nav = document.querySelector('[data-rlh-settings-section="plugins"]');
    return {
      nav: Boolean(nav && nav.getAttribute('aria-current') === 'true'),
      heading: Boolean(dialog && rlhHeading('^plugins$|^插件$', dialog)),
    };
  }), 10_000);
  rec('plugins.heading', Boolean(pluginsOpened && (plugins?.heading || plugins?.nav)), '');

  const marketOpened = await openSettings('market');
  const market = await waitUntil(() => pageEval(wc, () => {
    const nav = document.querySelector('[data-rlh-settings-section="market"]');
    const dialog = rlhDialog();
    const text = dialog ? (dialog.innerText || '') : '';
    return {
      nav: Boolean(nav && (nav.getAttribute('aria-current') === 'true' || rlhShown(nav))),
      discover: /discover|发现/i.test(text),
    };
  }), 10_000);
  rec('market.section', Boolean(marketOpened && market?.nav), marketOpened ? '' : 'market section missing');
  rec('market.discover', Boolean(market?.discover), '');

  await clickNamed(wc, '^installed$|^已安装$');
  const installed = await waitUntil(() => pageEval(wc, () => {
    const dialog = rlhDialog();
    if (!dialog) return null;
    const tab = Array.from(dialog.querySelectorAll('[role="tab"]')).find((el) =>
      /installed|已安装/i.test(rlhLabel(el)));
    const selected = Boolean(tab && tab.getAttribute('aria-selected') === 'true');
    const text = dialog.innerText || '';
    if (!selected && !/installed|已安装/i.test(text)) return null;
    return {
      selected,
      rlhbot: /\bdshbot\b/i.test(text),
    };
  }), 8_000);
  rec('market.installed', Boolean(installed), installed ? '' : 'Installed tab missing');
  rec(
    'plugin.rlhbot.market',
    Boolean(installed?.rlhbot),
    installed?.rlhbot ? 'listed on Installed' : 'preset Cordis plugin, not a market catalog row',
    true,
  );

  await dismiss();
  await sleep(300);

  const botsClicked = await pageEval(wc, () => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) =>
      rlhShown(el) && /(bots|机器人)/i.test(rlhLabel(el)));
    if (!tab) return false;
    tab.click();
    return true;
  });
  const bots = await waitUntil(() => pageEval(wc, () => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) =>
      /(bots|机器人)/i.test(rlhLabel(el)));
    const selected = Boolean(tab && tab.getAttribute('aria-selected') === 'true');
    const text = document.body.innerText || '';
    const page = /no bots yet|还没有机器人|new bot|添加新 bot|add bot/i.test(text);
    return selected || page ? { selected, page } : null;
  }), 8_000);
  rec('plugin.rlhbot.tab', Boolean(botsClicked || bots), botsClicked ? 'plugin sidebar contribution' : 'rlhbot plugin tab missing');
  rec('plugin.rlhbot.page', Boolean(bots?.page || bots?.selected), '');
  } catch (error) {
    rec('walk.uncaught', false, error && error.stack ? error.stack : String(error));
  }

  const failed = steps.filter((s) => !s.ok && !s.optional).map((s) => s.name);
  return {
    ok: failed.length === 0,
    failed,
    steps,
  };
}

/**
 * Fail a QA run when required assembled-UI steps did not pass.
 *
 * @param {{ qa?: { ok?: boolean, failed?: string[], steps?: Array<{ name: string, ok: boolean, optional?: boolean, detail?: string }> } }} result
 */
function assertReleaseQaResult(result) {
  const qa = result?.qa;
  if (!qa || qa.ok !== true) {
    const failed = (qa?.failed && qa.failed.length > 0)
      ? qa.failed
      : (qa?.steps || []).filter((s) => !s.ok && !s.optional).map((s) => `${s.name}: ${s.detail || ''}`);
    throw new Error(`Release QA failed:\n${failed.join('\n')}\n${JSON.stringify(qa)}`);
  }
  const names = new Set((qa.steps || []).map((s) => s.name));
  const missing = QA_REQUIRED_STEPS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Release QA omitted required steps: ${missing.join(', ')}`);
  }
}

module.exports = {
  runReleaseUiWalk,
  connectConfiguredWorkspace,
  makeRecorder,
  assertReleaseQaResult,
  QA_REQUIRED_STEPS,
  PAGE_HELPERS,
};
