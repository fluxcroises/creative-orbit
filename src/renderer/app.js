'use strict';

/* Interface de Creative Orbit. Aucune dépendance : l'état vient du processus
   principal (window.orbit), chaque changement redessine la vue. */
(() => {
  const api = window.orbit;
  const ui = { view: 'all', query: '', menuFor: null, detailId: null, confirm: null, returnFocus: null };
  let P = null; // dernier état reçu
  let sentTheme = null;
  let knownErrors = new Set();

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- langue et formats ----------

  function lang() {
    const s = (P && P.settings.language) || 'auto';
    if (s !== 'auto') return s;
    return (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  }
  function t(key, vars = {}) {
    const dict = window.I18N[lang()] || window.I18N.en;
    let s = dict[key] ?? window.I18N.en[key] ?? key;
    if (typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
    return s;
  }
  const tx = (o) => (o ? o[lang()] || o.fr || o.en || '' : '');
  const osName = (k) => t('os.' + (k || P.state.platform));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function fmtSize(n) {
    if (!n) return '';
    const units = t('units');
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return new Intl.NumberFormat(lang(), { maximumFractionDigits: i >= 2 ? 1 : 0 }).format(v) + ' ' + units[i];
  }
  function fmtDate(iso) {
    try {
      return new Intl.DateTimeFormat(lang(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
    } catch {
      return iso;
    }
  }
  function initials(name) {
    const w = name.split(/\s+/).filter(Boolean);
    return ((w[0] ? w[0][0] : '') + (w[1] ? w[1][0] : w[0] ? w[0][1] || '' : '')).toUpperCase();
  }

  // ---------- icônes ----------

  const svg = (d, extra = '') => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"${extra}>${d}</svg>`;
  const I = {
    grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
    installed: svg('<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/><path d="M9 10.2l2.1 2.1L15.2 8"/>'),
    updates: svg('<path d="M12 20V9"/><path d="M7.5 13.5L12 9l4.5 4.5"/><path d="M5 4h14"/>'),
    settings: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>'),
    more: svg('<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>'),
    x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    external: svg('<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
    alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.3v.2"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.7v.2"/>'),
    trash: svg('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>'),
    details: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.7v.2"/>'),
    notes: svg('<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5M9 12.5h7M9 16h5"/>'),
  };

  // ---------- thème ----------

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  function effectiveTheme() {
    const th = P ? P.settings.theme : 'dark';
    return th === 'system' ? (mq.matches ? 'dark' : 'light') : th;
  }
  function applyTheme() {
    const e = effectiveTheme();
    document.documentElement.dataset.theme = e;
    if (e !== sentTheme) {
      sentTheme = e;
      api.setEffectiveTheme(e);
    }
  }
  mq.addEventListener('change', () => P && render());

  // ---------- éléments communs ----------

  function tile(a, size = '') {
    const inner = a.icon
      ? `<img src="${esc(a.icon)}" alt="" data-fallback="${esc(initials(a.name))}">`
      : esc(initials(a.name));
    return `<div class="tile ${size}" style="--c:${esc(a.color)}" aria-hidden="true">${inner}</div>`;
  }

  function progress(a) {
    const op = a.op;
    if (!op) return '';
    let label;
    let pct = null;
    if (op.phase === 'downloading') {
      if (op.total) {
        pct = Math.min(100, Math.round((op.received / op.total) * 100));
        label = t('phase.downloading', { p: pct, received: fmtSize(op.received) || '0', total: fmtSize(op.total) });
      } else label = t('phase.downloadingNoTotal', { received: fmtSize(op.received) || '0' });
    } else if (op.phase === 'queued') label = t('phase.queued');
    else if (op.phase === 'installing') label = t(op.type === 'update' ? 'phase.updating' : 'phase.installing');
    else label = t('phase.uninstalling');
    const indet = pct === null;
    return `<div class="progress-wrap">
      <div class="progress${indet ? ' indeterminate' : ''}" role="progressbar" aria-label="${esc(a.name)}"
        ${indet ? '' : `aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"`}>
        <div class="bar" style="width:${indet ? 35 : pct}%"></div>
      </div>
      <div class="progress-label">${esc(label)}</div>
    </div>`;
  }

  function errorText(err) {
    const d = err.details || {};
    const exit = d.exitCode !== undefined ? t('error.exitCode', { code: d.exitCode }) : '';
    return t('error.' + err.code, { status: d.status || '', exit });
  }

  function messages(a, { retry: showRetry = true } = {}) {
    let html = '';
    if (a.error) {
      const head = t('error.' + (a.error.op || 'install'));
      const retry = a.error.op === 'launch' ? 'open' : a.error.op === 'uninstall' ? 'uninstall' : 'install';
      html += `<div class="message error" role="alert">${I.alert}
        <div class="text"><strong>${esc(head)}</strong> ${esc(errorText(a.error))}</div>
        ${a.error.code === 'NOT_SUPPORTED' || !showRetry ? '' : `<button class="btn btn-ghost" data-action="${retry}" data-id="${a.id}" data-fk="retry:${a.id}">${esc(t('btn.retry'))}</button>`}
        <button class="btn btn-ghost btn-icon" data-action="dismiss" data-id="${a.id}" aria-label="${esc(t('btn.dismiss'))}" title="${esc(t('btn.dismiss'))}">${I.x}</button>
      </div>`;
    }
    if (a.notice === 'reboot') {
      html += `<div class="message info" role="status">${I.info}
        <div class="text">${esc(t('notice.reboot'))}</div>
        <button class="btn btn-ghost btn-icon" data-action="dismiss" data-id="${a.id}" aria-label="${esc(t('btn.dismiss'))}">${I.x}</button>
      </div>`;
    }
    return html;
  }

  function cancelButton(a) {
    const cancellable = a.op && (a.op.phase === 'downloading' || a.op.phase === 'queued');
    return cancellable
      ? `<button class="btn btn-secondary" data-action="cancel" data-id="${a.id}" data-fk="cancel:${a.id}">${esc(t('btn.cancel'))}</button>`
      : '';
  }

  function menu(a) {
    if (ui.menuFor !== a.id) return '';
    return `<div class="menu" role="menu">
      <button role="menuitem" data-action="details" data-id="${a.id}">${I.details}${esc(t('menu.details'))}</button>
      ${a.releaseNotesUrl ? `<button role="menuitem" data-action="link" data-url="${esc(a.releaseNotesUrl)}">${I.notes}${esc(t('menu.releaseNotes'))}</button>` : ''}
      ${a.homepage ? `<button role="menuitem" data-action="link" data-url="${esc(a.homepage)}">${I.external}${esc(t('menu.homepage'))}</button>` : ''}
      <hr>
      <button role="menuitem" class="danger" data-action="uninstall" data-id="${a.id}">${I.trash}${esc(t('btn.uninstall'))}</button>
    </div>`;
  }

  function mainButtons(a) {
    if (a.op) return cancelButton(a);
    if (!a.available) return '';
    if (!a.installed) {
      return `<button class="btn btn-primary" data-action="install" data-id="${a.id}" data-fk="install:${a.id}">${esc(t('btn.install'))}</button>`;
    }
    let html = '';
    if (a.updateAvailable) {
      html += `<button class="btn btn-primary" data-action="install" data-id="${a.id}" data-fk="update:${a.id}">${esc(t('btn.update'))}</button>`;
    }
    html += `<button class="btn btn-secondary" data-action="open" data-id="${a.id}" data-fk="open:${a.id}">${esc(t('btn.open'))}</button>`;
    return html;
  }

  function statusLine(a) {
    if (a.op) return '';
    if (!a.installed) return '';
    if (a.updateAvailable) {
      return `<p class="meta update">${esc(t('status.updateTo', { v: a.installed.version, latest: a.latestVersion }))}</p>`;
    }
    return `<p class="meta">${esc(t('status.upToDate', { v: a.installed.version }))}</p>`;
  }

  function row(a) {
    const moreLabel = t('btn.more', { name: a.name });
    return `<div class="row" data-id="${a.id}">
      ${tile(a)}
      <div class="info">
        <div class="name"><button class="name-btn" data-action="details" data-id="${a.id}" data-fk="name:${a.id}"
          aria-label="${esc(t('btn.details', { name: a.name }))}">${esc(a.name)}</button></div>
        ${statusLine(a)}
        ${progress(a)}
        ${messages(a)}
      </div>
      <div class="actions">
        ${mainButtons(a)}
        ${a.op ? '' : `<button class="btn btn-icon" data-action="menu" data-id="${a.id}" data-fk="menu:${a.id}"
          aria-haspopup="menu" aria-expanded="${ui.menuFor === a.id}" aria-label="${esc(moreLabel)}" title="${esc(moreLabel)}">${I.more}</button>`}
        ${menu(a)}
      </div>
    </div>`;
  }

  function card(a) {
    const cat = tx(a.category);
    const meta = [cat, a.latestVersion ? t('status.version', { v: a.latestVersion }) : ''].filter(Boolean).join(' · ');
    let foot;
    if (a.op) foot = progress(a) + cancelButton(a);
    else if (!a.available) foot = '';
    else foot = mainButtons(a);
    return `<article class="card${a.available ? '' : ' muted'}" data-id="${a.id}">
      <div class="card-head">
        ${tile(a, 'tile-md')}
        <div class="titles">
          <h3><button class="name-btn" data-action="details" data-id="${a.id}" data-fk="name:${a.id}"
            aria-label="${esc(t('btn.details', { name: a.name }))}">${esc(a.name)}</button></h3>
          <p class="meta">${esc(meta)}</p>
        </div>
      </div>
      <p class="summary">${esc(tx(a.summary))}</p>
      ${messages(a, { retry: false })}
      <div class="card-foot">${foot}</div>
    </article>`;
  }

  function empty(title, body, action = '') {
    return `<div class="empty">
      <img class="brand-dark" src="assets/brand/creative-orbit-symbole-sombre.svg" alt="">
      <img class="brand-light" src="assets/brand/creative-orbit-symbole-clair.svg" alt="">
      <h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;
  }

  function pageHead(title, subtitle = '', right = '') {
    return `<div class="page-head"><div class="titles"><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>${right}</div>`;
  }

  function banners() {
    const c = P.state.catalog;
    let html = '';
    if (P.state.simulated) {
      html += `<div class="message info banner">${I.info}<div class="text">${esc(t('demo.banner'))}</div></div>`;
    }
    if (c.source === 'cache') {
      html += `<div class="message info banner">${I.info}<div class="text">${esc(t('catalog.offline', { date: fmtDate(c.fetchedAt) }))}</div>
        <button class="btn btn-ghost" data-action="refresh">${esc(t('btn.retry'))}</button></div>`;
    }
    return html;
  }

  function skeleton() {
    const c = `<div class="card"><div class="card-head"><div class="tile tile-md skeleton"></div>
      <div style="flex:1"><div class="skeleton" style="height:14px;width:60%"></div>
      <div class="skeleton" style="height:12px;width:40%;margin-top:8px"></div></div></div>
      <div class="skeleton" style="height:12px;margin-top:18px"></div><div class="skeleton" style="height:12px;width:80%;margin-top:8px"></div></div>`;
    return `<div class="grid" aria-busy="true">${c.repeat(6)}</div>`;
  }

  /** Renvoie un état « catalogue indisponible / vide » si nécessaire. */
  function catalogProblem() {
    const s = P.state;
    if (!s.loadedOnce) return skeleton();
    if (s.catalog.source === 'none') {
      return empty(t('catalog.error.title'), t('catalog.error.body'),
        `<button class="btn btn-primary" data-action="refresh" data-fk="retry-catalog">${esc(t('btn.retry'))}</button>`);
    }
    if (!s.apps.length) return empty(t('catalog.empty.title'), t('catalog.empty.body'));
    return null;
  }

  // ---------- pages ----------

  function pageAll() {
    const apps = P.state.apps;
    const problem = catalogProblem();
    let html = pageHead(t('all.title'), t('all.subtitle')) + banners();
    if (problem) return html + problem;
    const installed = apps.filter((a) => a.installed);
    const available = apps.filter((a) => !a.installed && a.available);
    const unavailable = apps.filter((a) => !a.installed && !a.available);
    if (installed.length) {
      html += `<section class="section"><h2>${esc(t('section.installed'))}</h2><div class="list">${installed.map(row).join('')}</div></section>`;
    }
    if (available.length) {
      html += `<section class="section"><h2>${esc(t('section.available'))}</h2><div class="grid">${available.map(card).join('')}</div></section>`;
    }
    if (unavailable.length) {
      html += `<section class="section"><h2>${esc(t('section.unavailable', { os: osName() }))}</h2><div class="grid">${unavailable.map(card).join('')}</div></section>`;
    }
    return html;
  }

  function pageInstalled() {
    const problem = catalogProblem();
    let html = pageHead(t('installed.title')) + banners();
    if (problem) return html + problem;
    const installed = P.state.apps.filter((a) => a.installed);
    if (!installed.length) {
      return html + empty(t('installed.empty.title'), t('installed.empty.body'),
        `<button class="btn btn-primary" data-action="nav" data-view="all" data-fk="browse">${esc(t('btn.browse'))}</button>`);
    }
    return html + `<div class="list">${installed.map(row).join('')}</div>`;
  }

  function pageUpdates() {
    const problem = catalogProblem();
    const list = P.state.apps.filter((a) => a.updateAvailable || (a.op && a.op.type === 'update'));
    const pending = list.filter((a) => a.updateAvailable && !a.op);
    const subtitle = list.length === 1 ? t('updates.subtitle.one') : list.length ? t('updates.subtitle.many', { n: list.length }) : '';
    const right = pending.length > 1
      ? `<button class="btn btn-primary" data-action="update-all" data-fk="update-all">${esc(t('btn.updateAll'))}</button>`
      : '';
    let html = pageHead(t('updates.title'), subtitle, right) + banners();
    if (problem) return html + problem;
    if (!list.length) return html + empty(t('updates.empty.title'), t('updates.empty.body'));
    return html + `<div class="list">${list.map(row).join('')}</div>`;
  }

  function pageCategory(name) {
    const apps = P.state.apps.filter((a) => tx(a.category) === name);
    const sub = apps.length === 1 ? t('category.subtitle.one') : t('category.subtitle.many', { n: apps.length });
    return pageHead(name, sub) + banners() + `<div class="grid">${apps.map(card).join('')}</div>`;
  }

  function pageSearch() {
    const q = norm(ui.query.trim());
    const apps = P.state.apps.filter((a) =>
      [a.name, tx(a.summary), tx(a.category), tx(a.description)].some((s) => norm(s).includes(q)));
    let html = pageHead(t('search.results', { q: ui.query.trim() }));
    if (!apps.length) return html + `<div class="empty"><p>${esc(t('search.empty', { q: ui.query.trim() }))}</p></div>`;
    return html + `<div class="grid">${apps.map(card).join('')}</div>`;
  }

  function sw(key, label, desc) {
    const id = 'set-' + key;
    return `<div class="setting"><div class="text"><label class="label" for="${id}">${esc(label)}</label>
      ${desc ? `<p class="desc">${esc(desc)}</p>` : ''}</div>
      <span class="switch"><input type="checkbox" role="switch" id="${id}" data-setting="${key}" data-fk="${id}" ${P.settings[key] ? 'checked' : ''}><span class="track"></span></span></div>`;
  }

  function launcherStatus() {
    const l = P.launcher;
    if (!l.packaged) return t('settings.launcher.dev');
    const u = l.update;
    switch (u.status) {
      case 'checking': return t('settings.launcher.checking');
      case 'none': return t('settings.launcher.none');
      case 'downloading': return t('settings.launcher.downloading', { v: u.version || '', p: u.percent || 0 });
      case 'ready': return t('launcher.ready', { v: u.version });
      case 'error': return t('settings.launcher.error');
      default: return '';
    }
  }

  function pageSettings() {
    const s = P.settings;
    const seg = (key, opts) => `<div class="segmented" role="radiogroup" aria-label="${esc(t('settings.' + key))}">${opts
      .map((o) => `<button role="radio" aria-checked="${s[key] === o}" data-action="set" data-key="${key}" data-value="${o}" data-fk="seg-${key}-${o}">${esc(t(`settings.${key}.${o}`))}</button>`)
      .join('')}</div>`;
    const os = P.state.platform;
    return pageHead(t('settings.title')) + `
      <section class="settings-group"><h2>${esc(t('settings.general'))}</h2><div class="settings-card">
        <div class="setting"><div class="text"><label class="label" for="set-language">${esc(t('settings.language'))}</label>
          <p class="desc">${esc(t('settings.language.desc'))}</p></div>
          <select id="set-language" data-setting="language" data-fk="set-language">
            <option value="auto" ${s.language === 'auto' ? 'selected' : ''}>${esc(t('settings.language.auto'))}</option>
            <option value="fr" ${s.language === 'fr' ? 'selected' : ''}>Français</option>
            <option value="en" ${s.language === 'en' ? 'selected' : ''}>English</option>
          </select></div>
        <div class="setting"><div class="text"><span class="label">${esc(t('settings.theme'))}</span>
          <p class="desc">${esc(t('settings.theme.desc'))}</p></div>${seg('theme', ['dark', 'light', 'system'])}</div>
      </div></section>

      <section class="settings-group"><h2>${esc(t('settings.startup'))}</h2><div class="settings-card">
        ${sw('launchAtLogin', t('settings.launchAtLogin'), t('settings.launchAtLogin.desc'))}
        ${sw('runInBackground', t('settings.runInBackground'), t('settings.runInBackground.desc.' + os))}
      </div></section>

      <section class="settings-group"><h2>${esc(t('settings.updates'))}</h2><div class="settings-card">
        ${sw('autoCheck', t('settings.autoCheck'), t('settings.autoCheck.desc'))}
        <div class="setting"><div class="text"><span class="label">${esc(t('settings.launcherVersion'))} ${esc(P.launcher.version)}</span>
          <p class="desc" role="status">${esc(launcherStatus())}</p></div>
          ${P.launcher.update.status === 'ready'
            ? `<button class="btn btn-primary" data-action="launcher-install">${esc(t('launcher.restart'))}</button>`
            : `<button class="btn btn-secondary" data-action="launcher-check" data-fk="launcher-check" ${P.launcher.packaged ? '' : 'disabled'}>${esc(t('settings.launcherCheck'))}</button>`}
        </div>
      </div></section>

      <section class="settings-group"><h2>${esc(t('settings.advanced'))}</h2><div class="settings-card">
        <div class="setting"><div class="text"><span class="label">${esc(t('settings.catalog'))}</span>
          <p class="desc"><code>${esc(P.state.catalog.url)}</code></p></div></div>
        <div class="setting"><div class="text"><span class="label">${esc(t('settings.logs'))}</span>
          <p class="desc">${esc(t('settings.logs.desc'))}</p></div>
          <button class="btn btn-secondary" data-action="open-logs" data-fk="open-logs">${esc(t('settings.logs.open'))}</button></div>
      </div></section>

      <section class="settings-group"><h2>${esc(t('settings.about'))}</h2><div class="settings-card about">
        <img class="brand-dark" src="assets/brand/creative-orbit-logo-empile-sombre.svg" alt="Creative Orbit">
        <img class="brand-light" src="assets/brand/creative-orbit-logo-empile-clair.svg" alt="Creative Orbit">
        <div><p>${esc(t('settings.about.body'))}</p><p class="version">Creative Orbit ${esc(P.launcher.version)}</p></div>
      </div>
      <div class="settings-card about-assoc">
        <div class="assoc-mark">${assocLogo()}</div>
        <div><p>${esc(t('settings.about.assoc'))}</p>
          <div class="links">
            <button class="btn btn-link" data-action="link" data-url="${ASSOC_URL}">flux-croises.fr ${I.external}</button>
            <button class="btn btn-link" data-action="ob-reset" data-fk="ob-reset">${esc(t('settings.onboarding'))}</button>
          </div></div>
      </div></section>`;
  }

  // ---------- barre latérale ----------

  function renderSidebar() {
    const apps = P.state.apps;
    const updates = apps.filter((a) => a.updateAvailable).length;
    const cats = [...new Set(apps.map((a) => tx(a.category)).filter(Boolean))].sort((a, b) => a.localeCompare(b, lang()));
    const searching = !!ui.query.trim();
    const item = (view, icon, label, extra = '') =>
      `<button class="nav-item" data-action="nav" data-view="${esc(view)}" data-fk="nav:${esc(view)}"
        ${ui.view === view && !searching ? 'aria-current="page"' : ''}>${icon}<span class="label">${esc(label)}</span>${extra}</button>`;
    const catColor = (name) => (apps.find((a) => tx(a.category) === name) || {}).color || '#7b6cff';
    const lu = P.launcher.update;
    $('#sidebar').setAttribute('aria-label', t('nav.main'));
    $('#sidebar').innerHTML = `
      ${item('all', I.grid, t('nav.all'))}
      ${item('installed', I.installed, t('nav.installed'))}
      ${item('updates', I.updates, t('nav.updates'), updates ? `<span class="badge" aria-label="${updates}">${updates}</span>` : '')}
      ${cats.length ? `<div class="nav-heading">${esc(t('nav.categories'))}</div>` : ''}
      ${cats.map((c) => item('cat:' + c, `<span class="dot" style="background:${esc(catColor(c))}"></span>`, c)).join('')}
      <div class="sidebar-spacer"></div>
      ${lu.status === 'ready' ? `<div class="launcher-card">${esc(t('launcher.ready', { v: lu.version }))}
        <button class="btn btn-primary" data-action="launcher-install">${esc(t('launcher.restart'))}</button></div>` : ''}
      ${item('settings', I.settings, t('nav.settings'))}
      <button class="assoc-link" data-action="link" data-url="${ASSOC_URL}" title="${esc(t('assoc.link'))}" aria-label="${esc(t('assoc.link'))}">
        ${assocLogo()}
      </button>`;
  }

  // ---------- logo de l'association ----------

  const ASSOC_URL = 'https://flux-croises.fr';
  function assocLogo() {
    return `<img class="assoc-dark" src="assets/association/flux-croises-horizontal-blanc.png" alt="Flux Croisés">
      <img class="assoc-light" src="assets/association/flux-croises-horizontal-noir.png" alt="Flux Croisés">`;
  }

  // ---------- écran d'accueil (premier lancement) ----------

  const ob = { step: 0, selected: new Set(), launchAtLogin: true, started: 0 };
  const onboardingVisible = () => !!P && !P.settings.onboarded;

  function obAppRow(a) {
    const installed = !!a.installed;
    const checked = installed || ob.selected.has(a.id);
    const meta = installed ? t('ob.apps.installed') : [tx(a.category), fmtSize(a.size)].filter(Boolean).join(' · ');
    return `<label class="ob-app${installed ? ' disabled' : ''}">
      <input type="checkbox" data-ob-app="${a.id}" data-fk="ob-app:${a.id}" ${checked ? 'checked' : ''} ${installed ? 'disabled' : ''}>
      ${tile(a)}
      <span class="info"><span class="name">${esc(a.name)}</span><span class="meta">${esc(tx(a.summary))}</span></span>
      <span class="meta size">${esc(meta)}</span>
    </label>`;
  }

  function onboardingStep() {
    const dots = `<div class="ob-dots" aria-hidden="true">${[0, 1, 2].map((i) => `<span class="${i <= ob.step ? 'on' : ''}"></span>`).join('')}</div>`;
    const eyebrow = `<p class="ob-eyebrow">${esc(t('ob.step', { n: ob.step + 1, total: 3 }))}</p>`;
    if (ob.step === 0) {
      const l = lang();
      const opt = (code, label) => `<button class="ob-choice" role="radio" aria-checked="${l === code}" data-action="set"
        data-key="language" data-value="${code}" data-fk="ob-lang-${code}"><span class="radio" aria-hidden="true"></span>${label}</button>`;
      return `${dots}${eyebrow}
        <h1 id="ob-title">${esc(t('ob.welcome.title'))}</h1>
        <p class="lead" id="ob-lang">${esc(t('ob.welcome.body'))}</p>
        <div class="ob-rule"></div>
        <div class="ob-choices" role="radiogroup" aria-labelledby="ob-lang">${opt('fr', 'Français')}${opt('en', 'English')}</div>
        <div class="ob-actions"><button class="btn btn-primary btn-lg" data-action="ob-next" data-fk="ob-start">${esc(t('ob.start'))}</button></div>`;
    }
    if (ob.step === 1) {
      const s = P.state;
      const apps = s.apps.filter((a) => a.available);
      let list;
      if (!s.loadedOnce) list = `<div class="ob-apps" aria-busy="true">${'<div class="ob-app skeleton" style="height:62px"></div>'.repeat(2)}</div>`;
      else if (!apps.length) list = `<p class="lead">${esc(t('ob.apps.none'))}</p>`;
      else list = `<div class="ob-apps">${apps.map(obAppRow).join('')}</div>`;
      const n = [...ob.selected].filter((id) => apps.some((a) => a.id === id && !a.installed)).length;
      return `${dots}${eyebrow}
        <h1 id="ob-title">${esc(t('ob.apps.title'))}</h1>
        <p class="lead">${esc(t('ob.apps.body'))}</p>
        <div class="ob-rule"></div>
        ${list}
        <div class="ob-actions">
          <button class="btn btn-ghost btn-lg" data-action="ob-back" data-fk="ob-back">${esc(t('ob.back'))}</button>
          <span class="spacer"></span>
          <button class="btn btn-primary btn-lg" data-action="ob-install" data-fk="ob-install">${esc(n ? t('ob.install', { n }) : t('ob.continue'))}</button>
        </div>`;
    }
    const body = ob.started === 1 ? t('ob.done.started.one') : ob.started > 1 ? t('ob.done.started.many', { n: ob.started }) : t('ob.done.body');
    return `${dots}${eyebrow}
      <h1 id="ob-title">${esc(t('ob.done.title'))}</h1>
      <p class="lead">${esc(body)}</p>
      <div class="ob-rule"></div>
      <div class="ob-option">
        <div class="text"><label class="label" for="ob-login">${esc(t('settings.launchAtLogin'))}</label>
          <p class="desc">${esc(t('ob.login.desc'))}</p></div>
        <span class="switch"><input type="checkbox" role="switch" id="ob-login" data-ob-login data-fk="ob-login" ${ob.launchAtLogin ? 'checked' : ''}><span class="track"></span></span>
      </div>
      <div class="ob-actions"><button class="btn btn-primary btn-lg" data-action="ob-finish" data-fk="ob-finish">${esc(t('ob.finish'))}</button></div>`;
  }

  function renderOnboarding() {
    const root = $('#onboarding-root');
    const visible = onboardingVisible();
    $('.shell').inert = visible;
    if (!visible) {
      root.innerHTML = '';
      delete root.dataset.key;
      return;
    }
    const firstShow = !root.firstElementChild;
    const html = `<div class="onboarding${firstShow ? ' enter' : ''}" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div class="ob-drag"></div>
      <div class="ob-visual">
        <img class="ob-logo" src="assets/brand/creative-orbit-logo-empile-sombre.svg" alt="Creative Orbit">
        <p class="ob-tagline">${esc(t('ob.tagline'))}</p>
        <div class="ob-assoc"><img src="assets/association/flux-croises-horizontal-blanc.png" alt="Flux Croisés"></div>
      </div>
      <div class="ob-panel"><div class="ob-card">${onboardingStep()}</div></div>
    </div>`;
    // Redessiné seulement si le contenu change (sinon les mises à jour de
    // progression le feraient clignoter et perdre le focus).
    const key = html.replace(' enter', '');
    if (root.dataset.key === key) return;
    root.dataset.key = key;
    root.innerHTML = html;
    if (firstShow) focusFirst('.ob-card [data-fk="ob-start"]');
  }

  // ---------- fenêtres modales ----------

  function renderOverlay() {
    const root = $('#overlay-root');
    let html = '';
    if (ui.confirm) {
      const a = P.state.apps.find((x) => x.id === ui.confirm.id);
      if (a) {
        html = `<div class="scrim" data-action="scrim"><div class="dialog small" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-body">
          <h1 id="dlg-title">${esc(t('confirm.uninstall.title', { name: a.name }))}</h1>
          <p class="body" id="dlg-body">${esc(t('confirm.uninstall.body', { name: a.name }))}</p>
          <div class="dialog-actions">
            <button class="btn btn-secondary" data-action="close-overlay" data-fk="dlg-cancel">${esc(t('btn.cancel'))}</button>
            <button class="btn btn-danger" data-action="confirm-uninstall" data-id="${a.id}" data-fk="dlg-confirm">${esc(t('btn.uninstall'))}</button>
          </div></div></div>`;
      }
    } else if (ui.detailId) {
      const a = P.state.apps.find((x) => x.id === ui.detailId);
      if (a) {
        const platforms = [a.available ? P.state.platform : null, ...a.otherPlatforms].filter(Boolean).map(osName).join(', ');
        const desc = tx(a.description) || tx(a.summary);
        html = `<div class="scrim" data-action="scrim"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
          <div class="dialog-head">${tile(a, 'tile-lg')}
            <div class="titles"><h1 id="dlg-title">${esc(a.name)}</h1><p class="meta">${esc(tx(a.category))}</p></div>
            <button class="btn btn-icon close" data-action="close-overlay" data-fk="dlg-close" aria-label="${esc(t('btn.close'))}" title="${esc(t('btn.close'))}">${I.x}</button>
          </div>
          <p class="body">${esc(desc)}</p>
          ${progress(a)}${messages(a)}
          <dl class="facts">
            <div><dt>${esc(t('detail.latest'))}</dt><dd>${esc(a.latestVersion || '–')}</dd></div>
            <div><dt>${esc(t('detail.installed'))}</dt><dd>${esc(a.installed ? a.installed.version : t('detail.notInstalled'))}</dd></div>
            <div><dt>${esc(t('detail.size'))}</dt><dd>${esc(fmtSize(a.size) || '–')}</dd></div>
            <div><dt>${esc(t('detail.platforms'))}</dt><dd>${esc(platforms || '–')}</dd></div>
          </dl>
          ${a.releaseNotesUrl || a.homepage ? `<div class="links">
            ${a.releaseNotesUrl ? `<button class="btn btn-link" data-action="link" data-url="${esc(a.releaseNotesUrl)}">${esc(t('menu.releaseNotes'))} ${I.external}</button>` : ''}
            ${a.homepage ? `<button class="btn btn-link" data-action="link" data-url="${esc(a.homepage)}">${esc(t('menu.homepage'))} ${I.external}</button>` : ''}
          </div>` : ''}
          <div class="dialog-actions">
            ${a.installed && !a.op ? `<button class="btn btn-ghost" data-action="uninstall" data-id="${a.id}" data-fk="dlg-uninstall">${esc(t('btn.uninstall'))}</button>` : ''}
            ${mainButtons(a)}
          </div></div></div>`;
      }
    }
    root.innerHTML = html;
  }

  // ---------- rendu principal ----------

  function renderContent() {
    let html;
    if (ui.query.trim() && ui.view !== 'settings') html = pageSearch();
    else if (ui.view === 'installed') html = pageInstalled();
    else if (ui.view === 'updates') html = pageUpdates();
    else if (ui.view === 'settings') html = pageSettings();
    else if (ui.view.startsWith('cat:')) html = pageCategory(ui.view.slice(4));
    else html = pageAll();
    $('#content').innerHTML = `<div class="content-inner">${html}</div>`;
  }

  function announceErrors() {
    const now = new Set();
    for (const a of P.state.apps) {
      if (!a.error) continue;
      const key = `${a.id}:${a.error.code}:${a.error.op}`;
      now.add(key);
      if (!knownErrors.has(key)) $('#live').textContent = `${a.name} : ${t('error.' + a.error.op)} ${errorText(a.error)}`;
    }
    knownErrors = now;
  }

  function render() {
    if (!P) return;
    const active = document.activeElement;
    const fk = active && active.dataset ? active.dataset.fk : null;
    const scrollTop = $('#content').scrollTop;

    applyTheme();
    document.documentElement.lang = lang();
    document.body.className = 'platform-' + (P.system.os === 'darwin' ? 'macos' : P.system.os === 'win32' ? 'windows' : 'other');
    const search = $('#search');
    search.placeholder = t('search.placeholder');
    search.setAttribute('aria-label', t('search.label'));
    const refresh = $('#refresh');
    refresh.setAttribute('aria-label', t('refresh'));
    refresh.title = t('refresh');
    refresh.classList.toggle('spin', P.state.status === 'loading');
    refresh.dataset.action = 'refresh';
    const pill = $('#demo-pill');
    pill.hidden = !P.state.simulated;
    pill.textContent = t('demo');

    renderSidebar();
    renderContent();
    renderOverlay();
    renderOnboarding();
    announceErrors();

    $('#content').scrollTop = scrollTop;
    if (fk && (document.activeElement === document.body || !document.contains(active))) {
      const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
      if (el) el.focus();
    }
  }

  function focusFirst(selector) {
    requestAnimationFrame(() => {
      const el = document.querySelector(selector);
      if (el) el.focus();
    });
  }

  function closeOverlay() {
    ui.detailId = null;
    ui.confirm = null;
    render();
    if (ui.returnFocus) {
      const el = document.querySelector(`[data-fk="${CSS.escape(ui.returnFocus)}"]`);
      if (el) el.focus();
      ui.returnFocus = null;
    }
  }

  // ---------- interactions ----------

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) {
      if (ui.menuFor) {
        ui.menuFor = null;
        render();
      }
      return;
    }
    const id = el.dataset.id;
    const action = el.dataset.action;
    if (action !== 'menu') ui.menuFor = null;
    switch (action) {
      case 'scrim':
        if (e.target === el) closeOverlay();
        return;
      case 'nav':
        ui.view = el.dataset.view;
        ui.query = '';
        $('#search').value = '';
        render();
        $('#content').scrollTop = 0;
        return;
      case 'details':
        ui.returnFocus = `name:${id}`;
        ui.detailId = id;
        render();
        focusFirst('.dialog [data-fk="dlg-close"]');
        return;
      case 'menu':
        ui.menuFor = ui.menuFor === id ? null : id;
        render();
        if (ui.menuFor) focusFirst('.menu [role="menuitem"]');
        return;
      case 'install': api.install(id); break;
      case 'open': api.launch(id); break;
      case 'cancel': api.cancel(id); break;
      case 'dismiss': api.dismiss(id); break;
      case 'update-all': api.updateAll(); break;
      case 'refresh': api.refresh(); break;
      case 'link': api.openExternal(el.dataset.url); break;
      case 'open-logs': api.openLogs(); break;
      case 'launcher-check': api.checkLauncherUpdate(); break;
      case 'launcher-install': api.installLauncherUpdate(); break;
      case 'set': api.setSettings({ [el.dataset.key]: el.dataset.value }); break;
      case 'uninstall':
        ui.returnFocus = ui.returnFocus || `menu:${id}`;
        ui.detailId = null;
        ui.confirm = { id };
        render();
        focusFirst('[data-fk="dlg-cancel"]');
        return;
      case 'confirm-uninstall':
        api.uninstall(id);
        closeOverlay();
        return;
      case 'close-overlay':
        closeOverlay();
        return;
      case 'ob-next':
      case 'ob-back':
        ob.step = Math.max(0, Math.min(2, ob.step + (action === 'ob-next' ? 1 : -1)));
        render();
        focusFirst('.ob-card h1');
        return;
      case 'ob-install': {
        const ids = [...ob.selected].filter((x) => P.state.apps.some((a) => a.id === x && a.available && !a.installed));
        ids.forEach((x) => api.install(x));
        ob.started = ids.length;
        ob.step = 2;
        render();
        focusFirst('.ob-card h1');
        return;
      }
      case 'ob-finish':
        api.setSettings({ onboarded: true, launchAtLogin: ob.launchAtLogin });
        ui.view = 'all';
        return;
      case 'ob-reset':
        Object.assign(ob, { step: 0, started: 0 });
        ob.selected.clear();
        api.setSettings({ onboarded: false });
        return;
    }
    render();
  });

  document.addEventListener('change', (e) => {
    if (e.target.dataset.obApp) {
      if (e.target.checked) ob.selected.add(e.target.dataset.obApp);
      else ob.selected.delete(e.target.dataset.obApp);
      return render();
    }
    if (e.target.dataset.obLogin !== undefined) {
      ob.launchAtLogin = e.target.checked;
      return;
    }
    const el = e.target.closest('[data-setting]');
    if (!el) return;
    const value = el.type === 'checkbox' ? el.checked : el.value;
    api.setSettings({ [el.dataset.setting]: value });
  });

  // Icône distante introuvable : on revient aux initiales.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.fallback !== undefined) img.replaceWith(document.createTextNode(img.dataset.fallback));
  }, true);

  $('#search').addEventListener('input', (e) => {
    ui.query = e.target.value;
    ui.menuFor = null;
    renderSidebar();
    renderContent();
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f' && !onboardingVisible()) {
      e.preventDefault();
      $('#search').focus();
      $('#search').select();
    } else if (mod && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      api.refresh();
    } else if (e.key === 'Escape') {
      if (onboardingVisible()) return;
      if (ui.menuFor) {
        const fk = `menu:${ui.menuFor}`;
        ui.menuFor = null;
        render();
        const el = document.querySelector(`[data-fk="${fk}"]`);
        if (el) el.focus();
      } else if (ui.detailId || ui.confirm) closeOverlay();
      else if (document.activeElement === $('#search') && ui.query) {
        $('#search').value = '';
        ui.query = '';
        render();
      }
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest('.menu')) {
      e.preventDefault();
      const items = [...document.querySelectorAll('.menu [role="menuitem"]')];
      const i = items.indexOf(document.activeElement);
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) next.focus();
    } else if (e.key === 'Tab' && (ui.detailId || ui.confirm || onboardingVisible())) {
      // Garde le focus dans la fenêtre modale (ou l'écran d'accueil).
      const scope = onboardingVisible() ? '.onboarding' : '.dialog';
      const f = [...document.querySelectorAll(`${scope} button, ${scope} [href], ${scope} input`)].filter((x) => !x.disabled);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  api.onNavigate((view) => {
    ui.view = view;
    ui.query = '';
    $('#search').value = '';
    render();
  });

  api.onState((payload) => {
    P = payload;
    render();
  });

  api.getState().then((payload) => {
    P = payload;
    render();
  });
})();
