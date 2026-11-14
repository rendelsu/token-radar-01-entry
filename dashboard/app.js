// Token Radar dashboard: a static page, no framework, no network.
// Reads window.RADAR (written by main.ts from the same board) and renders the ranked board,
// the protocol detail view, the live-token view and the method. Hash routes the screenshots:
//   #detail=<slug>  opens one protocol's detail view
//   #cat=<category> filters the board to one category
//   #view=live      opens the live-token view
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) { document.getElementById('app').textContent = 'No radar data.'; return; }

  var state = { view: 'board', q: '', cat: '', chain: '', watch: false, sort: 'rank', detail: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) {
    if (n == null || !isFinite(n)) return '—';
    return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function pct(v) {
    if (v == null) return '<span class="dim">n/a</span>';
    var cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
    return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  }
  function age(v) { return v == null ? 'n/a' : v >= 365 ? (v / 365).toFixed(1) + 'y' : v + 'd'; }
  function chains(c) { return c && c.length ? esc(c.join(', ')) : '—'; }

  var cats = [], chainsList = [];
  D.rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    (r.chains || []).forEach(function (c) { if (chainsList.indexOf(c) < 0) chainsList.push(c); });
  });
  cats.sort(); chainsList.sort();

  function filtered() {
    var rows = D.rows.filter(function (r) {
      if (state.watch && !isWatch(r)) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if ((r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    var by = {
      rank: function (a, b) { return a.rank - b.rank; },
      implied: function (a, b) { return b.implied_value_usd - a.implied_value_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0); },
      name: function (a, b) { return a.name < b.name ? -1 : 1; },
    }[state.sort] || function (a, b) { return a.rank - b.rank; };
    return rows.slice().sort(by);
  }
  var watchSet = null;
  function isWatch(r) {
    if (!watchSet) { watchSet = {}; (D.watchlist || []).forEach(function (s) { watchSet[s] = true; }); }
    return !!watchSet[r.slug];
  }

  function rowHtml(r, maxImp) {
    var w = Math.max(2, Math.round((r.implied_value_usd / maxImp) * 100));
    return '<tr data-slug="' + esc(r.slug) + '"' + (state.detail === r.slug ? ' class="sel"' : '') + '>' +
      '<td class="num">' + r.rank + '</td>' +
      '<td><b>' + esc(r.name) + '</b><br><span class="slug">' + esc(r.slug) + '</span>' + (isWatch(r) ? ' <span class="slug">· watchlist</span>' : '') + '</td>' +
      '<td>' + esc(r.category || '—') + '</td>' +
      '<td>' + chains(r.chains) + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' +
      '<td class="num">' + pct(r.change_7d) + '</td>' +
      '<td class="num">' + age(r.age_days) + '</td>' +
      '<td class="num">' + r.multiple.toFixed(2) + '×</td>' +
      '<td class="num"><b>' + money(r.implied_value_usd) + '</b><div class="bar"><i style="width:' + w + '%"></i></div></td></tr>';
  }

  function detailHtml(r) {
    var m = r.multiple, base = r.tvl_usd * m;
    var comps = D.live.filter(function (l) { return l.category === r.category; }).slice(0, 5);
    var compRows = comps.map(function (l) {
      return '<tr><td>' + esc(l.name) + '</td><td class="num">' + money(l.tvl_usd) + '</td><td class="num">' + money(l.mcap_usd) + '</td><td class="num">' + (l.mcap_tvl == null ? '—' : l.mcap_tvl.toFixed(2) + '×') + '</td></tr>';
    }).join('');
    var steps = r.farm_steps.map(function (s, i) {
      var parts = s.split(' Cost: ');
      var body = parts[0], tail = parts[1] ? 'Cost: ' + parts[1] : '';
      return '<li><b>Step ' + (i + 1) + '.</b> ' + esc(body) + (tail ? ' <small>' + esc(tail) + '</small>' : '') + '</li>';
    }).join('');
    return '<section class="panel detail" id="detail"><h2>#' + r.rank + ' — ' + esc(r.name) + '</h2>' +
      '<p style="color:var(--mut);margin:0 0 6px">' + esc(r.slug) + ' · ' + esc(r.category || 'uncategorised') + ' · ' + chains(r.chains) +
      ' · tracked since ' + esc(r.listed_at || 'unknown') + ' · records no token.</p>' +
      '<div class="grid">' +
      '<div><b>' + moneyFull(r.implied_value_usd) + '</b><span>implied value</span></div>' +
      '<div><b>' + moneyFull(r.tvl_usd) + '</b><span>total value locked</span></div>' +
      '<div><b>' + (r.change_7d == null ? 'n/a' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b><span>TVL change, 7 days</span></div>' +
      '<div><b>' + age(r.age_days) + '</b><span>running with no token</span></div></div>' +
      '<h3 style="margin:0 0 6px;font-size:14px">Why this rank — the model, step by step</h3>' +
      '<p class="math">TVL ' + moneyFull(r.tvl_usd) + ' × multiple ' + m.toFixed(2) + ' (' + esc(r.multiple_source) + ') = base ' + moneyFull(base) +
      '<br>× growth ' + r.growth_multiplier.toFixed(2) + ' × maturity ' + r.maturity_multiplier.toFixed(2) +
      ' = implied ' + moneyFull(r.implied_value_usd) + '</p>' +
      '<h3 style="margin:0 0 6px;font-size:14px">How to farm it</h3><ol class="farm">' + steps + '</ol>' +
      (comps.length ? '<h3 style="margin:16px 0 6px;font-size:14px">Live comparables in ' + esc(r.category || 'this category') + ' — where the multiple comes from</h3>' +
      '<table class="mini"><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">mcap / TVL</th></tr></thead><tbody>' + compRows + '</tbody></table>' : '') +
      '</section>';
  }

  function multiplesHtml() {
    var used = D.multiples.filter(function (m) { return m.used && cats.indexOf(m.category) >= 0; }).sort(function (a, b) { return b.comps - a.comps; }).slice(0, 12);
    var rows = used.map(function (m) {
      return '<tr><td>' + esc(m.category) + '</td><td class="num">' + m.comps + '</td><td class="num">' + m.median.toFixed(3) + '×</td></tr>';
    }).join('');
    return '<table class="mini"><thead><tr><th>Category</th><th class="num">Live comps</th><th class="num">Median mcap / TVL</th></tr></thead><tbody>' + rows +
      '</tbody></table><p style="color:var(--dim);font-size:12px;margin:8px 0 0">Categories with fewer than ' + D.model.min_category_comps +
      ' live comparables use the snapshot-wide median, ' + D.global_multiple.toFixed(3) + '×. Multiples are clamped to ' +
      D.model.multiple_floor + '–' + D.model.multiple_cap.toFixed(2) + '×.</p>';
  }

  function render() {
    var maxImp = D.rows[0] ? D.rows[0].implied_value_usd : 1;
    var rows = filtered();
    var detail = state.detail ? D.rows.filter(function (r) { return r.slug === state.detail; })[0] : null;
    var top10 = D.rows.slice(0, 10).map(function (r) {
      var w = Math.max(2, Math.round((r.implied_value_usd / maxImp) * 100));
      return '<div class="row"><span>#' + r.rank + ' ' + esc(r.name) + '</span><div class="bar" style="margin:0"><i style="width:' + w + '%"></i></div><span class="amt">' + money(r.implied_value_usd) + '</span></div>';
    }).join('');

    var boardTable = '<table id="board"><thead><tr>' +
      '<th class="num"><button data-sort="rank">Rank</button></th><th>Protocol</th><th>Category</th><th>Chains</th>' +
      '<th class="num"><button data-sort="tvl">TVL</button></th><th class="num"><button data-sort="growth">7d</button></th>' +
      '<th class="num"><button data-sort="age">Age</button></th><th class="num">Multiple</th><th class="num"><button data-sort="implied">Implied value</button></th></tr></thead>' +
      '<tbody>' + rows.map(function (r) { return rowHtml(r, maxImp); }).join('') + '</tbody></table>';

    var liveTable = '<table><thead><tr><th>Protocol</th><th>Category</th><th>Chains</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">mcap / TVL</th><th class="num">7d</th></tr></thead><tbody>' +
      D.live.map(function (l) {
        return '<tr><td><b>' + esc(l.name) + '</b><br><span class="slug">' + esc(l.slug) + '</span></td><td>' + esc(l.category || '—') + '</td><td>' + chains(l.chains) + '</td><td class="num">' + money(l.tvl_usd) + '</td><td class="num">' + money(l.mcap_usd) + '</td><td class="num">' + (l.mcap_tvl == null ? '—' : l.mcap_tvl.toFixed(2) + '×') + '</td><td class="num">' + pct(l.change_7d) + '</td></tr>';
      }).join('') + '</tbody></table>';

    document.getElementById('app').innerHTML = '<div class="wrap">' +
      '<header class="hero"><div class="eyebrow">Token launch radar · snapshot ' + esc(D.as_of) + '</div>' +
      '<h1>The protocols most likely to be worth a token</h1>' +
      '<p class="lede">Every protocol that records no token, ranked by what its token would be worth if the market priced it like the protocols whose tokens already trade. The watchlist is the floor, never the ceiling: the board carries every qualifying protocol, not only the forty above it.</p></header>' +
      '<div class="stats">' +
      '<div class="stat"><b>' + D.rows.length + '</b><span>protocols ranked</span></div>' +
      '<div class="stat"><b>' + D.watchlist_size + '</b><span>on the watchlist</span></div>' +
      '<div class="stat"><b>' + D.early_size + '</b><span>early finds below the floor</span></div>' +
      '<div class="stat"><b>' + money(D.rows[0].implied_value_usd) + '</b><span>top implied value</span></div>' +
      '<div class="stat"><b>' + D.global_multiple.toFixed(2) + '×</b><span>median mcap / TVL</span></div></div>' +
      '<div class="tabs"><button data-view="board" aria-pressed="' + (state.view === 'board') + '">Ranked board</button>' +
      '<button data-view="live" aria-pressed="' + (state.view === 'live') + '">Live tokens — the comparables</button></div>' +
      '<section class="method"><h2>How the value is built</h2>' +
      '<p class="formula">implied = TVL × category multiple × growth × maturity</p>' +
      '<p>One number per protocol, from the snapshot alone. The multiple is the median market-cap-to-TVL of the live-token protocols in the same category — the market&rsquo;s own pricing, not a flat rate. Growth is the seven-day TVL change, clamped to −30%…+60%. Maturity rewards a protocol that has run longer with no token, and saturates: it never pays to simply be old.</p>' +
      '<div class="steps4"><div><b>1 · Multiple</b>Median mcap / TVL of live tokens in the category.</div><div><b>2 · Growth</b>Seven-day TVL change, clamped, half weight.</div><div><b>3 · Maturity</b>Age with no token, saturating at about eighteen months.</div><div><b>4 · Farm plan</b>Seven concrete steps, cost and time on each.</div></div>' +
      '<div style="margin-top:14px">' + multiplesHtml() + '</div></section>' +
      (state.view === 'board'
        ? '<section class="panel"><h2>Top 10 by implied value</h2><div class="top10">' + top10 + '</div></section>' +
          (detail ? detailHtml(detail) : '') +
          '<div class="controls" id="controls"><input type="search" id="q" placeholder="Search name or slug…" value="' + esc(state.q) + '">' +
          '<select id="cat"><option value="">All categories</option>' + cats.map(function (c) { return '<option' + (state.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
          '<select id="chain"><option value="">All chains</option>' + chainsList.map(function (c) { return '<option' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
          '<select id="sort">' + [['rank', 'Sort: rank'], ['implied', 'Sort: implied value'], ['tvl', 'Sort: TVL'], ['growth', 'Sort: 7d growth'], ['age', 'Sort: age'], ['name', 'Sort: name']].map(function (o) { return '<option value="' + o[0] + '"' + (state.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
          '<label><input type="checkbox" id="watch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label></div>' +
          '<p class="count">' + rows.length + ' of ' + D.rows.length + ' protocols · click a row for its detail view and farm plan</p>' +
          boardTable
        : '<section class="panel"><h2>Live tokens — the market&rsquo;s own values</h2>' +
          '<p style="color:var(--mut)">These protocols already have a token, so the board shows their market capitalisation, not a model&rsquo;s guess. Their mcap-to-TVL ratios are the comparables the ranked board&rsquo;s multiples are built from.</p>' + liveTable + '</section>') +
      '<footer class="note"><p><b>Read this before you farm.</b> &ldquo;Records no token&rdquo; is what the snapshot says — a protocol on this board may still have a token its record does not carry. An implied value is this entry&rsquo;s claim, never the market&rsquo;s: it says what a token would be worth if the protocol&rsquo;s record stayed as it is, not whether or when a token is issued.</p>' +
      '<p>Data: DefiLlama public API, snapshot ' + esc(D.as_of) + ' · ' + D.rows.length + ' rows · model ' + esc(D.model_version) + ' · farm steps carry their cost and time.</p></footer>' +
      '</div>';

    bind();
  }

  function bind() {
    var app = document.getElementById('app');
    app.querySelectorAll('tbody tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        state.detail = state.detail === tr.getAttribute('data-slug') ? null : tr.getAttribute('data-slug');
        render();
        if (state.detail) { var d = document.getElementById('detail'); if (d) d.scrollIntoView(); }
      });
    });
    app.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { state.view = b.getAttribute('data-view'); state.detail = null; render(); });
    });
    app.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () { state.sort = b.getAttribute('data-sort'); render(); });
    });
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; render(); var nq = document.getElementById('q'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { state.cat = cat.value; state.detail = null; render(); });
    var chain = document.getElementById('chain');
    if (chain) chain.addEventListener('change', function () { state.chain = chain.value; state.detail = null; render(); });
    var sort = document.getElementById('sort');
    if (sort) sort.addEventListener('change', function () { state.sort = sort.value; render(); });
    var watch = document.getElementById('watch');
    if (watch) watch.addEventListener('change', function () { state.watch = watch.checked; state.detail = null; render(); });
  }

  // Hash routes for the screenshots and for sharing a view.
  var h = location.hash || '';
  var m = h.match(/detail=([A-Za-z0-9._-]+)/);
  if (m) state.detail = m[1];
  var c = h.match(/cat=([^&]+)/);
  if (c) state.cat = decodeURIComponent(c[1]);
  if (/#view=live/.test(h)) state.view = 'live';
  var shot = (h.match(/shot=(\w+)/) || [])[1] || '';

  document.getElementById('app').setAttribute('aria-busy', 'false');
  render();
  // Screenshot states scroll the subject into the viewport.
  if (shot === 'board') { var b = document.getElementById('board'); if (b) b.scrollIntoView(); }
  if (shot === 'filter') { var f = document.getElementById('controls'); if (f) f.scrollIntoView(); }
  if (shot === 'detail') { var d = document.getElementById('detail'); if (d) d.scrollIntoView(); }
})();
