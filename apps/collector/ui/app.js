/* necter collector dashboard: polls the collector API and renders sessions, detail and install. */
(function () {
  'use strict';
  var CFG = window.__NECTER__ || {};
  var API = '/__necter/api';
  var THRESHOLD = 75;
  var state = {
    route: 'sessions',
    site: '',
    tab: 'all',
    query: '',
    sessions: [],
    overview: null,
    seen: new Set(),
    selected: null,
    detail: null,
    error: false,
    lastOk: 0,
  };

  var CLASS = {
    'human': 'Human',
    'human-assisted': 'Human with an AI assistant',
    'browser-agent': 'Browser agent',
    'computer-use-agent': 'Computer-use agent',
    'extension-agent': 'Extension agent',
    'fetch-agent': 'Fetch agent',
    'ai-crawler': 'AI crawler',
    'search-crawler': 'Search crawler',
    'utility-bot': 'Utility bot',
    'scripted-automation': 'Scripted automation',
    'unknown': 'Undetermined',
  };
  var WANTED = { 'search-crawler': 1, 'utility-bot': 1 };

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function bucket(s) {
    if (s.score >= THRESHOLD && s.actorClass !== 'human' && s.actorClass !== 'human-assisted') return 'agents';
    if ((s.actorClass === 'human' || s.actorClass === 'human-assisted') && s.score < THRESHOLD) return 'humans';
    if (s.score < 40) return 'humans';
    return 'unsure';
  }
  function classLabel(c) { return CLASS[c] || c; }
  function pillClass(s) {
    var b = bucket(s);
    if (b === 'agents') return WANTED[s.actorClass] ? 'wanted' : 'agent';
    if (b === 'humans') return 'human';
    return 'maybe';
  }
  function verdictLabel(s) {
    var b = bucket(s);
    if (b === 'humans') return s.actorClass === 'human-assisted' ? classLabel('human-assisted') : 'Human';
    if (b === 'unsure') return s.actorClass === 'unknown' || s.actorClass === 'human' ? 'Undetermined' : 'Possibly ' + classLabel(s.actorClass).toLowerCase();
    return classLabel(s.actorClass);
  }
  function ago(ts) {
    var d = Math.max(0, Date.now() - ts) / 1000;
    if (d < 5) return 'now';
    if (d < 60) return Math.floor(d) + ' s ago';
    if (d < 3600) return Math.floor(d / 60) + ' min ago';
    if (d < 86400) return Math.floor(d / 3600) + ' h ago';
    return Math.floor(d / 86400) + ' d ago';
  }
  function clock(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  function shortUa(ua) {
    if (!ua) return 'No user agent';
    var bot = /(ChatGPT-User|OAI-SearchBot|GPTBot|Claude-User|ClaudeBot|Claude-SearchBot|Perplexity-User|PerplexityBot|Google-Extended|Googlebot|bingbot|Applebot|Meta-ExternalAgent|Bytespider|CCBot|python-requests|python-httpx|aiohttp|curl|Wget|axios|node-fetch|undici|node|Go-http-client|okhttp|Java)\/?([\d.]*)/i.exec(ua);
    var os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
    var m;
    if (!/Mozilla/.test(ua) && bot) return bot[1] + (bot[2] ? ' ' + bot[2].split('.')[0] : '');
    if ((m = /HeadlessChrome\/(\d+)/.exec(ua))) return 'Headless Chrome ' + m[1] + (os ? ' · ' + os : '');
    if (bot && /bot|User|Extended|Agent/i.test(bot[1])) return bot[1];
    if ((m = /Edg\/(\d+)/.exec(ua))) return 'Edge ' + m[1] + (os ? ' · ' + os : '');
    if ((m = /Firefox\/(\d+)/.exec(ua))) return 'Firefox ' + m[1] + (os ? ' · ' + os : '');
    if ((m = /Chrome\/(\d+)/.exec(ua))) return 'Chrome ' + m[1] + (os ? ' · ' + os : '');
    if ((m = /Version\/(\d+).*Safari/.exec(ua))) return 'Safari ' + m[1] + (os ? ' · ' + os : '');
    return ua.slice(0, 48);
  }
  function hostOf(origin) {
    try { return new URL(origin).host; } catch (e) { return origin || ''; }
  }

  /* Data */
  function getJSON(path) {
    return fetch(API + path, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error(r.status + '');
      return r.json();
    });
  }
  function poll() {
    if (document.hidden) return schedule();
    var q = state.site ? '?site=' + encodeURIComponent(state.site) : '';
    Promise.all([getJSON('/overview'), getJSON('/sessions' + q)])
      .then(function (res) {
        state.overview = res[0];
        state.sessions = res[1];
        state.error = false;
        state.lastOk = Date.now();
        render();
        if (state.selected) loadDetail(state.selected, true);
      })
      .catch(function () {
        state.error = true;
        renderLive();
      })
      .then(schedule);
  }
  var timer;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(poll, 2000);
  }

  /* Rendering */
  function render() {
    renderLive();
    renderSites();
    renderMode();
    if (state.route === 'sessions') renderSessions();
    else renderInstall();
  }

  function renderLive() {
    var el = $('live');
    el.className = 'live ' + (state.error ? 'err' : state.lastOk ? 'ok' : '');
    $('live-text').textContent = state.error ? 'Collector unreachable' : state.lastOk ? 'Live · updated ' + clock(state.lastOk) : 'Connecting';
  }

  function renderSites() {
    var sel = $('site-select');
    var sites = (state.overview && state.overview.sites) || [];
    var want = [''].concat(sites.map(function (s) { return s.site; }));
    if (state.site && want.indexOf(state.site) === -1) want.push(state.site);
    var have = Array.prototype.map.call(sel.options, function (o) { return o.value; });
    if (want.join('|') === have.join('|')) return;
    sel.innerHTML = want.map(function (v) {
      var s = sites.find(function (x) { return x.site === v; });
      return '<option value="' + esc(v) + '">' + (v ? esc(v) + (s ? ' (' + s.sessions + ')' : '') : 'All sites') + '</option>';
    }).join('');
    sel.value = state.site;
  }

  function renderMode() {
    var o = state.overview;
    if (!o) return;
    var mode = o.mode === 'enforce' ? '<strong>Enforce mode</strong>Agents are blocked or challenged.' : '<strong>Monitor mode</strong>Records only. Nothing is blocked.';
    var up = o.upstream ? '<br>Proxying ' + esc(hostOf(o.upstream)) : '';
    $('mode-row').innerHTML = mode + up;
  }

  function filtered() {
    var q = state.query.trim().toLowerCase();
    return state.sessions.filter(function (s) {
      if (state.tab !== 'all' && bucket(s) !== state.tab) return false;
      if (!q) return true;
      return [s.id, s.ua, s.ip, s.lastPage, s.site, s.origin, s.provider, classLabel(s.actorClass)].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderSessions() {
    var all = state.sessions;
    var counts = { all: all.length, agents: 0, humans: 0, unsure: 0 };
    var classes = {};
    var interventions = 0;
    all.forEach(function (s) {
      var b = bucket(s);
      counts[b]++;
      if (b === 'agents') classes[s.actorClass] = (classes[s.actorClass] || 0) + 1;
      if (s.interventions.length) interventions++;
    });
    var sitesCount = state.overview ? state.overview.sites.length : 0;
    var topClass = Object.keys(classes).sort(function (a, b) { return classes[b] - classes[a]; })[0];
    var enforce = state.overview && state.overview.mode === 'enforce';

    // Finding
    var finding;
    if (!all.length) finding = 'Waiting for the first visitor. Install the script on a site, or open the test page.';
    else if (counts.agents) {
      var latest = all.find(function (s) { return bucket(s) === 'agents'; });
      finding = '<strong>' + counts.agents + ' of ' + all.length + ' sessions</strong> were automated. Latest: ' + esc(classLabel(latest.actorClass)) + (latest.provider ? ' from ' + esc(latest.provider) : '') + (latest.lastPage ? ' on ' + esc(latest.lastPage) : '') + ', ' + ago(latest.lastTs) + '.';
    } else finding = 'No agents among ' + all.length + ' session' + (all.length === 1 ? '' : 's') + ' so far.';
    $('finding').innerHTML = finding;

    $('kpis').innerHTML = [
      kpi('Sessions', all.length, state.site ? 'on ' + esc(state.site) : sitesCount ? 'across ' + sitesCount + ' site' + (sitesCount === 1 ? '' : 's') : '—'),
      kpi('Flagged as agents', counts.agents, topClass ? 'mostly ' + esc(classLabel(topClass).toLowerCase()) + (Object.keys(classes).length > 1 ? 's and others' : 's') : 'score ' + THRESHOLD + ' or more', counts.agents > 0),
      kpi('Read as human', counts.humans, counts.unsure ? counts.unsure + ' still undetermined' : 'none undetermined'),
      kpi('Sessions acted on', interventions, enforce ? 'blocked, challenged or slowed' : 'monitor mode acts on none'),
    ].join('');

    var tabs = [['all', 'All'], ['agents', 'Agents'], ['humans', 'Humans'], ['unsure', 'Undetermined']];
    $('tabs').innerHTML = tabs.map(function (t) {
      return '<button class="tab" role="tab" type="button" data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' + t[1] + '<span class="count">' + counts[t[0]] + '</span></button>';
    }).join('');

    var rows = filtered();
    var body = $('rows');
    if (!all.length) {
      body.innerHTML = '';
      $('table').hidden = true;
      $('empty').hidden = false;
      $('empty').innerHTML = emptyHtml();
      return;
    }
    $('table').hidden = false;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted" style="padding:24px 0">No sessions match ' + (state.query ? '“' + esc(state.query) + '”' : 'this tab') + '.</td></tr>';
      $('empty').hidden = true;
      return;
    }
    $('empty').hidden = true;
    var firstPaint = state.seen.size === 0;
    body.innerHTML = rows.map(function (s) {
      var fresh = !firstPaint && !state.seen.has(s.id);
      var ev = s.evidence.find(function (e) { return e.contribution > 0; }) || s.evidence[0];
      var page = s.lastPage || '—';
      var site = s.origin ? hostOf(s.origin) : s.site;
      var pct = Math.max(0, Math.min(100, s.score));
      var lvl = pct >= THRESHOLD ? 'hi' : pct >= 40 ? 'mid' : '';
      return '<tr tabindex="0" data-id="' + esc(s.id) + '"' + (fresh ? ' class="fresh"' : '') + (state.selected === s.id ? ' aria-selected="true"' : '') + '>' +
        '<td class="c-visitor"><span class="cell-main">' + esc(shortUa(s.ua)) + '</span><span class="cell-sub mono">' + esc(s.id.slice(0, 12)) + (s.ip ? ' · ' + esc(s.ip) : '') + '</span></td>' +
        '<td class="c-page"><span class="cell-main">' + esc(page) + '</span><span class="cell-sub">' + esc(site) + (s.pageCount > 1 ? ' · ' + s.pageCount + ' pages' : '') + '</span></td>' +
        '<td class="c-verdict"><span class="pill ' + pillClass(s) + '">' + esc(verdictLabel(s)) + '</span>' + (s.provider ? '<span class="cell-sub">' + esc(s.provider) + (s.providerVerified ? '<span class="verified">verified</span>' : '') + '</span>' : (s.interventions.length ? '<span class="cell-sub">' + esc(s.interventions.join(', ')) + '</span>' : '')) + '</td>' +
        '<td class="c-score num"><div class="meter"><div class="track" aria-hidden="true"><div class="fill ' + lvl + '" style="width:' + pct + '%"></div><div class="tick"></div></div><span class="val">' + Math.round(s.score) + '</span></div></td>' +
        '<td class="c-evidence"><span class="cell-main">' + (ev ? esc(ev.summary) : '<span class="muted">—</span>') + '</span>' + (s.deterministic ? '<span class="cell-sub">Proof, not a guess</span>' : '') + '</td>' +
        '<td class="c-seen num"><span class="cell-main">' + ago(s.lastTs) + '</span></td>' +
        '</tr>';
    }).join('');
    rows.forEach(function (s) { state.seen.add(s.id); });
    all.forEach(function (s) { state.seen.add(s.id); });
  }

  function kpi(label, value, sub, alert) {
    return '<div class="kpi"><div class="label">' + label + '</div><div class="value' + (alert ? ' alert' : '') + '">' + value.toLocaleString() + '</div><div class="sub">' + sub + '</div></div>';
  }

  function snippet(site, enforce, debug) {
    var src = location.origin + '/__necter/script.js?site=' + encodeURIComponent(site || 'my-site') + (enforce ? '&mode=enforce' : '') + (debug ? '&debug=1' : '');
    return '<script async src="' + src + '"></script>';
  }

  function emptyHtml() {
    return '<div><h2>No visitors yet</h2><p>Detection starts as soon as a page with the script loads. Three ways to see it work:</p>' +
      '<ol><li>Open the <a href="/test" target="_blank" rel="noopener">test page</a> yourself. You should appear as a human within a few seconds.</li>' +
      '<li>Point an agent at the test page: Claude in Chrome, ChatGPT agent, a Playwright script, or <code>curl</code>.</li>' +
      '<li>Add the script tag to your own site from <a href="#/install">Install</a>.</li></ol></div>' +
      '<div class="code"><pre><code>' + esc(snippet(state.site || 'my-site')) + '</code></pre></div>';
  }

  function renderInstall() {
    var site = $('site-name').value.trim() || 'my-site';
    $('snippet').textContent = snippet(site, $('opt-enforce').checked, $('opt-debug').checked);
    var local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
    $('local-note').hidden = !local;
    $('port').textContent = location.port || (location.protocol === 'https:' ? '443' : '80');
    var up = state.overview && state.overview.upstream;
    $('proxy-cmd').textContent = up ? 'Already running: this collector is proxying ' + up + '. Open ' + location.origin + '/' : 'corepack pnpm collector --upstream https://your-site.com';
    $('bookmarklet').href = "javascript:(function(){var s=document.createElement('script');s.src='" + location.origin + "/__necter/script.js?site=bookmarklet&debug=1';document.head.appendChild(s);})()";
    var sites = (state.overview && state.overview.sites) || [];
    var mine = sites.find(function (s) { return s.site === site; });
    var html = '';
    if (mine) html += '<div class="status-row ok"><span class="dot"></span><span><strong>' + esc(site) + '</strong> is sending data: ' + mine.sessions + ' session' + (mine.sessions === 1 ? '' : 's') + ', last ' + ago(mine.lastTs) + '.</span></div>';
    else html += '<div class="status-row"><span class="dot"></span><span>Waiting for the first visit to <strong>' + esc(site) + '</strong>. Load a page with the snippet and this turns green.</span></div>';
    sites.filter(function (s) { return s.site !== site; }).slice(0, 4).forEach(function (s) {
      html += '<div class="status-row ok"><span class="dot"></span><span>' + esc(s.site) + ': ' + s.sessions + ' session' + (s.sessions === 1 ? '' : 's') + ', last ' + ago(s.lastTs) + '</span></div>';
    });
    $('install-status').innerHTML = html;
  }

  /* Detail drawer */
  function openDetail(id) {
    state.selected = id;
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    $('d-body').innerHTML = '<p class="muted">Loading…</p>';
    loadDetail(id, false);
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr'), function (tr) { tr.setAttribute('aria-selected', String(tr.dataset.id === id)); });
  }
  function closeDetail() {
    state.selected = null;
    $('drawer').hidden = true;
    $('scrim').hidden = true;
    Array.prototype.forEach.call(document.querySelectorAll('#rows tr[aria-selected]'), function (tr) { tr.removeAttribute('aria-selected'); });
  }
  function loadDetail(id, quiet) {
    getJSON('/sessions/' + encodeURIComponent(id)).then(function (d) {
      if (state.selected !== id) return;
      renderDetail(d);
    }).catch(function () {
      if (!quiet) $('d-body').innerHTML = '<p class="muted">This session is no longer available.</p>';
    });
  }
  function eventSummary(e) {
    var d = e.data || {};
    switch (e.type) {
      case 'signal': return (d.signals || []).map(function (s) { return s.id; }).join(', ');
      case 'verdict': return Math.round(d.score) + ' · ' + classLabel(d.actorClass) + (d.provider ? ' · ' + d.provider : '') + ' (' + d.stage + ')';
      case 'request': return (d.method || 'GET') + ' ' + (d.path || '');
      case 'session': return (d.action || '') + (d.firstVisit ? ', first visit' : '');
      case 'intervention': return d.kind + (d.ok ? '' : ' (failed)');
      case 'decision': return d.decision ? d.decision.primary : '';
      case 'canary': return d.kind + ' ' + (d.detail && d.detail.phase === 'issued' ? 'planted' : 'triggered');
      case 'challenge': return d.outcome || '';
      case 'error': return d.message || '';
      default: return '';
    }
  }
  function renderDetail(d) {
    var s = d.summary;
    var v = d.verdict || d.clientVerdict;
    $('d-title').textContent = shortUa(s.ua);
    $('d-id').textContent = s.id;
    var evidence = (v && v.evidence) || [];
    var max = evidence.reduce(function (m, e) { return Math.max(m, Math.abs(e.contribution)); }, 0) || 1;
    var evHtml = evidence.length ? '<div class="evidence">' + evidence.slice(0, 14).map(function (e) {
      var w = Math.round((Math.abs(e.contribution) / max) * 50);
      return '<div class="ev"><div class="ev-text"><span class="ev-summary">' + esc(e.summary) + '</span><span class="ev-id">' + esc(e.signalId) + ' · ' + esc(e.layer) + ' · ' + esc(e.source) + '</span></div>' +
        '<div class="ev-bar" title="' + (e.contribution > 0 ? '+' : '') + e.contribution.toFixed(2) + ' log-odds"><span class="' + (e.contribution >= 0 ? 'pos' : 'neg') + '" style="width:' + w + '%"></span></div></div>';
    }).join('') + '<div class="ev-legend"><span>human</span><span>agent</span></div></div>' : '<p class="muted">No evidence recorded yet.</p>';

    var events = d.events.slice().reverse().slice(0, 80);
    var facts = [
      ['Site', esc(s.origin || s.site)],
      ['User agent', esc(s.ua || '—')],
      ['IP address', esc(s.ip || '—')],
      ['First seen', new Date(s.firstTs).toLocaleString()],
      ['Stage', esc(s.stage || '—') + (s.deterministic ? ' · proof (a deterministic signal fired)' : '')],
      ['Actions taken', s.interventions.length ? esc(s.interventions.join(', ')) : 'None'],
    ];
    if (v && v.classScores) {
      var top = Object.keys(v.classScores).sort(function (a, b) { return v.classScores[b] - v.classScores[a]; }).slice(0, 3);
      if (top.length) facts.splice(1, 0, ['Agent type odds', top.map(function (c) { return esc(classLabel(c)) + ' ' + Math.round(v.classScores[c] * 100) + '%'; }).join(', ')]);
    }
    $('d-body').innerHTML =
      '<div class="d-verdict"><div class="d-score">' + Math.round(s.score) + '<small>/100</small></div>' +
      '<div class="d-class"><span class="pill ' + pillClass(s) + '">' + esc(verdictLabel(s)) + '</span>' + (s.provider ? '<span>' + esc(s.provider) + (s.providerVerified ? '<span class="verified">verified</span>' : '') + '</span>' : '') + '</div>' +
      '<div class="d-meta">Agent score, from ' + (v ? v.signalCount : 0) + ' signals. ' + THRESHOLD + ' or more counts as automated.</div></div>' +
      '<section class="d-section"><h3>Why <span class="muted">· each signal’s pull toward agent or human</span></h3>' + evHtml + '</section>' +
      '<section class="d-section"><h3>Session</h3><dl class="facts">' + facts.map(function (f) { return '<dt>' + f[0] + '</dt><dd>' + f[1] + '</dd>'; }).join('') + '</dl></section>' +
      '<section class="d-section"><h3>Pages <span class="muted">· ' + d.pages.length + '</span></h3>' + (d.pages.length ? '<ol class="pages">' + d.pages.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ol>' : '<p class="muted">—</p>') + '</section>' +
      '<section class="d-section"><h3>Timeline <span class="muted">· latest ' + events.length + ' of ' + s.eventCount + ' events</span></h3><ul class="timeline">' + events.map(function (e) {
        return '<li><span class="t">' + clock(e.ts) + '</span><span class="k">' + esc(e.type) + (e.source === 'server' ? ' · srv' : '') + '</span><span class="s">' + esc(eventSummary(e)) + '</span></li>';
      }).join('') + '</ul></section>';
  }

  /* Routing and events */
  function route() {
    var r = (location.hash.replace(/^#\/?/, '') || 'sessions').split('?')[0];
    state.route = r === 'install' ? 'install' : 'sessions';
    $('view-sessions').hidden = state.route !== 'sessions';
    $('view-install').hidden = state.route !== 'install';
    document.title = 'necter · ' + (state.route === 'install' ? 'Install' : 'Sessions');
    Array.prototype.forEach.call(document.querySelectorAll('.nav a[data-route]'), function (a) {
      if (a.dataset.route === state.route) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    $('sidebar').classList.remove('open');
    render();
  }

  document.addEventListener('click', function (e) {
    var tab = e.target.closest('.tab');
    if (tab) { state.tab = tab.dataset.tab; renderSessions(); return; }
    var row = e.target.closest('#rows tr[data-id]');
    if (row) { openDetail(row.dataset.id); return; }
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      var text = $(copy.dataset.copy).textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () {
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = 'Copy'; }, 1400);
      }).catch(function () {
        var range = document.createRange();
        range.selectNodeContents($(copy.dataset.copy));
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      });
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('search').focus(); }
    if (e.key === 'Escape') closeDetail();
    if (e.key === 'Enter' && document.activeElement.matches('#rows tr[data-id]')) openDetail(document.activeElement.dataset.id);
  });
  $('search').addEventListener('input', function (e) { state.query = e.target.value; if (state.route !== 'sessions') location.hash = '#/sessions'; renderSessions(); });
  $('site-select').addEventListener('change', function (e) { state.site = e.target.value; state.seen = new Set(); poll(); });
  $('d-close').addEventListener('click', closeDetail);
  $('scrim').addEventListener('click', closeDetail);
  $('menu-btn').addEventListener('click', function () {
    var open = $('sidebar').classList.toggle('open');
    $('menu-btn').setAttribute('aria-expanded', String(open));
  });
  $('clear-btn').addEventListener('click', function () {
    fetch(API + '/reset', { method: 'POST', credentials: 'same-origin' }).then(function () { state.seen = new Set(); closeDetail(); poll(); });
  });
  ['site-name', 'opt-enforce', 'opt-debug'].forEach(function (id) { $(id).addEventListener('input', renderInstall); });
  $('bookmarklet').addEventListener('click', function (e) { e.preventDefault(); });
  if (CFG.upstream) $('nav-test').hidden = true;
  if (CFG.site && CFG.site !== 'default') $('site-name').value = CFG.site;
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  route();
  poll();
})();
