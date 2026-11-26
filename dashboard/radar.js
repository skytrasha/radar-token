// The radar page. It holds no network call: window.RADAR is the dataset main.ts wrote beside it, and
// every number shown is read from that object. The page also recomputes each row's implied value from
// the snapshot's own figures and flags any row where its arithmetic and the board's disagree.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) {
    document.getElementById('countline').textContent = 'The dataset did not load: data.js is missing beside this page.';
    return;
  }

  var MODEL = D.model;
  var state = { q: '', cat: 'all', chain: 'all', scope: 'all', minv: 0, sort: 'implied', dir: -1, open: null };

  // ---- formatting -----------------------------------------------------------------------------

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }

  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function years(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 730) return (days / 365).toFixed(1) + ' yrs';
    if (days >= 365) return '1 yr';
    if (days >= 60) return Math.round(days / 30) + ' mo';
    return Math.round(days) + ' d';
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---- the model, recomputed in the page -------------------------------------------------------

  // The same three multipliers the program applies, written from the constants data.js carries, so the
  // page can prove the board it shows is the board the snapshot implies.
  function revalue(row) {
    var growth = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var g = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, growth));
    var gm = 1 + (g / 100) * MODEL.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? MODEL.unknown_age_days : row.age_days;
    var capped = Math.min(Math.max(age, 0), MODEL.maturity_days);
    var mm = MODEL.maturity_floor + (capped / MODEL.maturity_days) * MODEL.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * MODEL.base_multiple * gm * mm));
  }

  // ---- the header -----------------------------------------------------------------------------

  function paintHeader() {
    document.getElementById('asof').textContent = D.as_of;
    document.getElementById('floor').textContent = money(D.floor_usd);
    document.getElementById('mname').textContent = D.model_name;
    document.getElementById('fsource').textContent = D.source;

    var ids = {
      'f-base': MODEL.base_multiple, 'f-gf': MODEL.growth_floor, 'f-gc': MODEL.growth_cap,
      'f-gw': MODEL.growth_weight, 'f-mf': MODEL.maturity_floor, 'f-md': MODEL.maturity_days,
      'f-md2': MODEL.maturity_days, 'f-mr': MODEL.maturity_range
    };
    Object.keys(ids).forEach(function (k) {
      var el = document.getElementById(k);
      if (el) el.textContent = (ids[k] < 0 ? '−' : '') + Math.abs(ids[k]);
    });

    var cells = [
      ['Protocols scored', D.counts.board],
      ['On the watchlist', D.counts.watchlist],
      ['Early tail below floor', D.counts.below_floor],
      ['Categories', D.counts.categories],
      ['Ranked value', money(D.totals.implied_usd)],
      ['Median row', money(D.totals.median_implied_usd)]
    ];
    document.getElementById('tally').innerHTML = cells.map(function (c) {
      return '<div><dt>' + esc(c[0]) + '</dt><dd>' + esc(c[1]) + '</dd></div>';
    }).join('');
  }

  // ---- the filters ----------------------------------------------------------------------------

  function fillSelects() {
    var cats = {}, chains = {};
    D.rows.forEach(function (r) {
      cats[r.category || 'Unknown'] = (cats[r.category || 'Unknown'] || 0) + 1;
      (r.chains.length ? r.chains : ['Unlisted']).forEach(function (c) { chains[c] = (chains[c] || 0) + 1; });
    });
    function opt(k, n) { return '<option value="' + esc(k) + '">' + esc(k) + ' (' + n + ')</option>'; }
    var cat = document.getElementById('cat');
    Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; })
      .forEach(function (k) { cat.insertAdjacentHTML('beforeend', opt(k, cats[k])); });
    var chain = document.getElementById('chain');
    Object.keys(chains).sort(function (a, b) { return chains[b] - chains[a]; }).slice(0, 40)
      .forEach(function (k) { chain.insertAdjacentHTML('beforeend', opt(k, chains[k])); });
  }

  function matches(r) {
    if (state.cat !== 'all' && (r.category || 'Unknown') !== state.cat) return false;
    if (state.chain !== 'all') {
      var list = r.chains.length ? r.chains : ['Unlisted'];
      if (list.indexOf(state.chain) < 0) return false;
    }
    if (state.scope === 'watch' && !r.on_watchlist) return false;
    if (state.scope === 'below' && r.on_watchlist) return false;
    if (r.implied_value_usd < state.minv) return false;
    if (state.q) {
      var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
      if (hay.indexOf(state.q.toLowerCase()) < 0) return false;
    }
    return true;
  }

  function keyFor(r) {
    switch (state.sort) {
      case 'rank': return r.rank;
      case 'name': return r.name.toLowerCase();
      case 'category': return (r.category || '').toLowerCase();
      case 'tvl': return r.tvl_usd;
      case 'change': return r.change_7d === null ? -Infinity : r.change_7d;
      case 'age': return r.age_days === null ? -1 : r.age_days;
      case 'ratio': return r.value_per_tvl;
      default: return r.implied_value_usd;
    }
  }

  function sortRows(list) {
    return list.slice().sort(function (a, b) {
      var ka = keyFor(a), kb = keyFor(b);
      if (ka < kb) return -state.dir;
      if (ka > kb) return state.dir;
      return a.rank - b.rank;
    });
  }

  // ---- the board ------------------------------------------------------------------------------

  function paintRows() {
    var list = sortRows(D.rows.filter(matches));
    var body = document.getElementById('rows');
    body.innerHTML = list.map(function (r) {
      var miss = revalue(r) === r.implied_value_usd ? '' : ' class="drift"';
      var up = r.change_7d === null ? 'flat' : r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : 'flat';
      return '<tr' + miss + ' data-slug="' + esc(r.slug) + '">' +
        '<td class="num rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' +
          (r.on_watchlist ? '<span class="tag watch">watchlist</span>' : '<span class="tag early">early</span>') +
          '<span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'Unknown') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + up + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + years(r.age_days) + '</td>' +
        '<td class="num strong">' + (r.implied_value_usd >= 1e12 ? '$' + (r.implied_value_usd / 1e12).toFixed(2) + 'T' : money(r.implied_value_usd)) + '</td>' +
        '<td class="num">' + (r.value_per_tvl ? r.value_per_tvl.toFixed(2) + '×' : '—') + '</td>' +
        '<td class="act"><button class="open" type="button" data-open="' + esc(r.slug) + '">Detail</button></td>' +
        '</tr>';
    }).join('');

    var empty = document.getElementById('empty');
    empty.hidden = list.length > 0;
    document.getElementById('countline').textContent =
      list.length + ' of ' + D.rows.length + ' rows shown' +
      (state.q ? ' · matching "' + state.q + '"' : '') +
      (state.cat !== 'all' ? ' · ' + state.cat : '') +
      (state.chain !== 'all' ? ' · on ' + state.chain : '') +
      (state.scope !== 'all' ? ' · ' + (state.scope === 'watch' ? 'watchlist only' : 'early tail only') : '') +
      (state.minv > 0 ? ' · implied ≥ ' + money(state.minv) : '') + '.';
  }

  // ---- the live view --------------------------------------------------------------------------

  function paintLive() {
    document.getElementById('live').innerHTML = D.live.map(function (p) {
      return '<tr><td>' + esc(p.name) + '<span class="pslug">' + esc(p.slug) + '</span></td>' +
        '<td class="cat">' + esc(p.category || 'Unknown') + '</td>' +
        '<td class="num">' + money(p.tvl_usd) + '</td>' +
        '<td class="num">' + money(p.mcap_usd) + '</td>' +
        '<td class="num">' + (p.tvl_to_mcap === null ? '—' : p.tvl_to_mcap.toFixed(2) + '×') + '</td>' +
        '<td class="num ' + (p.change_7d > 0 ? 'up' : p.change_7d < 0 ? 'down' : 'flat') + '">' + pct(p.change_7d) + '</td></tr>';
    }).join('');
  }

  // ---- the detail drawer ----------------------------------------------------------------------

  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) { r = D.rows[i]; break; }
    if (!r) return;
    state.open = slug;

    document.getElementById('d-rank').textContent = 'Rank ' + r.rank + ' of ' + D.rows.length + (r.on_watchlist ? ' · on the watchlist' : ' · early tail');
    document.getElementById('d-name').textContent = r.name;
    document.getElementById('d-meta').textContent = (r.category || 'Unknown') + ' · ' + (r.chains.length ? r.chains.join(', ') : 'chain not listed') + ' · listed ' + (r.age_days === null ? 'unknown' : r.age_days + ' days ago');

    var figs = [
      ['Implied launch value', money(r.implied_value_usd)],
      ['TVL today', money(r.tvl_usd)],
      ['Value per TVL dollar', r.value_per_tvl ? r.value_per_tvl.toFixed(2) + '×' : '—'],
      ['Seven-day growth', pct(r.change_7d)],
      ['Days without a token', r.age_days === null ? 'unknown' : String(r.age_days)]
    ];
    document.getElementById('d-figures').innerHTML = figs.map(function (f) {
      return '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>';
    }).join('');

    var age = r.age_days === null ? MODEL.unknown_age_days : r.age_days;
    var capped = Math.min(Math.max(age, 0), MODEL.maturity_days);
    document.getElementById('d-calc').innerHTML =
      '<p class="kicker">The arithmetic for this row</p>' +
      '<p class="eq">' + money(r.tvl_usd) + ' × ' + MODEL.base_multiple + ' × ' + r.growth_multiplier.toFixed(3) +
      ' × ' + r.maturity_multiplier.toFixed(3) + ' = <strong>' + money(r.implied_value_usd) + '</strong></p>' +
      '<p class="note">The growth multiplier comes from ' + pct(r.change_7d) + ' clamped to [' + MODEL.growth_floor + ', ' + MODEL.growth_cap + ']% at weight ' + MODEL.growth_weight +
      '. The maturity multiplier comes from ' + age + ' days' + (r.age_days === null ? ' (not listed, so the model takes ' + MODEL.unknown_age_days + ')' : '') +
      ', capped at ' + MODEL.maturity_days + ' days, between ' + MODEL.maturity_floor + ' and ' + (MODEL.maturity_floor + MODEL.maturity_range).toFixed(1) + '.</p>' +
      (capped === MODEL.maturity_days ? '<p class="note">This protocol has already reached full maturity: more time without a token no longer lifts its value.</p>' : '');

    document.getElementById('d-plan').innerHTML = r.plan.map(function (s) {
      return '<li>' + esc(s) + '</li>';
    }).join('');

    var drawer = document.getElementById('drawer');
    drawer.hidden = false;
    drawer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeDetail() {
    state.open = null;
    document.getElementById('drawer').hidden = true;
  }

  // ---- wiring ---------------------------------------------------------------------------------

  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value.trim(); paintRows(); });
  document.getElementById('cat').addEventListener('change', function (e) { state.cat = e.target.value; paintRows(); });
  document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; paintRows(); });
  document.getElementById('scope').addEventListener('change', function (e) { state.scope = e.target.value; paintRows(); });
  document.getElementById('minv').addEventListener('change', function (e) { state.minv = Number(e.target.value); paintRows(); });
  document.getElementById('reset').addEventListener('click', function () {
    state.q = ''; state.cat = 'all'; state.chain = 'all'; state.scope = 'all'; state.minv = 0;
    state.sort = 'implied'; state.dir = -1;
    document.getElementById('q').value = '';
    document.getElementById('cat').value = 'all';
    document.getElementById('chain').value = 'all';
    document.getElementById('scope').value = 'all';
    document.getElementById('minv').value = '0';
    paintRows();
  });

  document.querySelectorAll('th button[data-sort]').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-sort');
      if (state.sort === k) state.dir = -state.dir;
      else { state.sort = k; state.dir = k === 'name' || k === 'category' || k === 'rank' ? 1 : -1; }
      paintRows();
    });
  });

  document.getElementById('rows').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-open]');
    if (btn) { openDetail(btn.getAttribute('data-open')); return; }
    var tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.getAttribute('data-slug'));
  });
  document.getElementById('d-close').addEventListener('click', closeDetail);

  paintHeader();
  fillSelects();
  paintRows();
  paintLive();
  document.getElementById('grid').setAttribute('aria-busy', 'false');
})();