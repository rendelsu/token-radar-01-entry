// Token Radar dashboard: renders window.RADAR (board rows, live
// comparables, model summary) as a sortable, filterable board with a
// per-protocol detail view. No network: every byte comes from data.js.
(function () {
  var R = window.RADAR;
  var rows = R.rows;
  var state = { q: "", cat: "", chain: "", minTvl: 0, wl: false, sort: "rank", dir: 1 };
  var selected = null;

  function $(id) { return document.getElementById(id); }
  function money(v) {
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return "$" + Math.round(v);
  }
  function fullMoney(v) { return "$" + Math.round(v).toLocaleString("en-US"); }
  function pct(v) {
    if (v === null || v === undefined) return "—";
    var s = (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    return '<span class="' + (v >= 0 ? "up" : "down") + '">' + s + "</span>";
  }
  function age(v) { return v < 1 ? Math.round(v * 365) + "d" : v.toFixed(1) + "y"; }
  function chainsOf(r) {
    var shown = r.chains.slice(0, 2).join(", ");
    if (r.chain_count > 2) shown += " +" + (r.chain_count - 2);
    return shown;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---- header: headline, intro, KPIs, method --------------------------
  var top = rows[0];
  $("meta").textContent = "Snapshot " + R.as_of + "  ·  DeFiLlama protocol index  ·  radar-2 model";
  $("headline").textContent =
    top.name + " leads " + rows.length + " pre-token protocols by implied value";
  $("intro").innerHTML =
    "The watchlist is the floor: every protocol with at least $50M of TVL and no token on record. " +
    "The early radar adds " + (rows.length - 40) + " more pre-token protocols below that floor, " +
    "scored by the same model. Implied value is a model, not a promise — no row predicts " +
    "a token will launch, or when. <b>" + esc(top.name) + "</b> tops the board at <b>" + money(top.implied_value_usd) +
    "</b>, " + top.multiple.toFixed(2) + "x its $" + (top.tvl_usd / 1e9).toFixed(2) + "B of TVL.";
  var kpis = [
    [rows.filter(function (r) { return r.watchlist; }).length + " / 40", "Watchlist covered"],
    [String(rows.length), "Pre-token rows scored"],
    [money(R.total_implied), "Total implied value"],
    [R.median_multiple.toFixed(2) + "x", "Median multiple"],
    [String(R.live_n), "Live tokens priced as comps"],
  ];
  $("kpis").innerHTML = kpis.map(function (k) {
    return '<div class="kpi"><div class="v">' + k[0] + '</div><div class="l">' + k[1] + "</div></div>";
  }).join("");
  $("method").innerHTML =
    "Model — <b>implied = TVL x category multiple x 7d growth x age</b>. The multiple is the median " +
    "mcap/TVL of the live tokens in the protocol's category (" + R.live_n + " live tokens, winsorized, " +
    "shrunk toward the snapshot median " + R.global_median.toFixed(2) + "x when a category has few comps). " +
    "Wrapped, staked, bridged and exchange products are set aside, never ranked.";

  // ---- filters ---------------------------------------------------------
  var cats = [...new Set(rows.map(function (r) { return r.category; }))].sort();
  var chains = [...new Set(rows.flatMap(function (r) { return r.chains; }))].sort();
  cats.forEach(function (c) {
    var o = document.createElement("option"); o.value = c; o.textContent = c; $("cat").appendChild(o);
  });
  chains.forEach(function (c) {
    var o = document.createElement("option"); o.value = c; o.textContent = c; $("chain").appendChild(o);
  });
  function readControls() {
    state.q = $("q").value.trim().toLowerCase();
    state.cat = $("cat").value;
    state.chain = $("chain").value;
    state.minTvl = Number($("minTvl").value);
    state.wl = $("wlOnly").checked;
    state.sort = $("sort").value;
  }
  ["q", "cat", "chain", "minTvl", "wlOnly", "sort"].forEach(function (id) {
    $(id).addEventListener("input", function () { readControls(); render(); });
  });
  $("clearBtn").addEventListener("click", function () {
    $("q").value = ""; $("cat").value = ""; $("chain").value = "";
    $("minTvl").value = "0"; $("wlOnly").checked = false; $("sort").value = "rank";
    readControls(); render();
  });

  // ---- table -----------------------------------------------------------
  var maxImp = rows[0].implied_value_usd;
  function filtered() {
    var out = rows.filter(function (r) {
      if (state.wl && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (state.q) {
        var hay = (r.name + " " + r.slug + " " + r.category + " " + r.chains.join(" ")).toLowerCase();
        if (hay.indexOf(state.q) === -1) return false;
      }
      return true;
    });
    // dir 1 = largest first, -1 = smallest first; ties break by slug.
    function val(r) {
      if (state.sort === "tvl") return r.tvl_usd;
      if (state.sort === "change") return r.change_7d === null ? -999 : r.change_7d;
      if (state.sort === "age") return r.age_years;
      if (state.sort === "multiple") return r.multiple;
      return r.implied_value_usd;
    }
    out.sort(function (a, b) {
      var d = val(b) - val(a);
      if (d !== 0) return d * state.dir;
      return a.slug < b.slug ? -1 : 1;
    });
    return out;
  }
  function render() {
    var list = filtered();
    $("count").textContent = list.length + " of " + rows.length + " protocols — click a row for its model and farm plan";
    $("rows").innerHTML = list.map(function (r) {
      var w = Math.max(4, Math.round((r.implied_value_usd / maxImp) * 100));
      return '<tr data-slug="' + esc(r.slug) + '"' + (selected === r.slug ? ' class="sel"' : "") + ">" +
        '<td class="num">' + r.rank + "</td>" +
        '<td class="proto"><div class="nm">' + esc(r.name) + (r.watchlist ? '<span class="star">★</span>' : "") + "</div>" +
        '<div class="sub">' + esc(r.slug) + (r.watchlist ? " · watchlist" : "") + "</div></td>" +
        "<td>" + esc(r.category) + "</td>" +
        "<td>" + esc(chainsOf(r)) + "</td>" +
        '<td class="num">' + money(r.tvl_usd) + "</td>" +
        '<td class="num">' + pct(r.change_7d) + "</td>" +
        '<td class="num">' + age(r.age_years) + "</td>" +
        '<td class="num">' + r.multiple.toFixed(2) + "x</td>" +
        '<td><span class="bar" style="width:' + w + 'px"></span><span class="imp">' + money(r.implied_value_usd) + "</span></td></tr>";
    }).join("");
  }
  document.querySelectorAll("#board th[data-sort]").forEach(function (th) {
    th.addEventListener("click", function () {
      var key = th.getAttribute("data-sort");
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = 1; }
      $("sort").value = key;
      render();
    });
  });
  $("rows").addEventListener("click", function (e) {
    var tr = e.target.closest("tr");
    if (tr) openDetail(tr.getAttribute("data-slug"), true);
  });

  // ---- detail view -----------------------------------------------------
  function catMedianTvl(cat) {
    var vs = rows.filter(function (r) { return r.category === cat; }).map(function (r) { return r.tvl_usd; }).sort(function (a, b) { return a - b; });
    return vs[Math.floor(vs.length / 2)] || 0;
  }
  function openDetail(slug, scroll) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    selected = slug;
    var medTvl = catMedianTvl(r.category);
    var chg = r.change_7d === null ? "no 7d reading" : (r.change_7d >= 0 ? "+" : "") + r.change_7d.toFixed(2) + "%";
    var compLine = r.comps_n > 0
      ? r.category + " median " + r.cat_median.toFixed(2) + "x from " + r.comps_n + " live comparable" + (r.comps_n > 1 ? "s" : "") + ", shrunk toward the snapshot median " + R.global_median.toFixed(2) + "x"
      : "no live comparable in " + r.category + ", so the snapshot median " + R.global_median.toFixed(2) + "x";
    $("detail").hidden = false;
    $("detail").innerHTML =
      "<h2>#" + r.rank + " — " + esc(r.name) + "</h2>" +
      '<div class="dsub">' + esc(r.slug) + " · " + esc(r.category) + " · " + esc(r.chains.join(", ")) +
      " · listed " + age(r.age_years) + " ago · records no token.</div>" +
      '<div class="cards">' +
      '<div class="card"><div class="v">' + fullMoney(r.implied_value_usd) + '</div><div class="l">implied value</div></div>' +
      '<div class="card"><div class="v">' + fullMoney(r.tvl_usd) + '</div><div class="l">total value locked</div></div>' +
      '<div class="card"><div class="v">' + (r.change_7d === null ? "—" : (r.change_7d >= 0 ? "+" : "") + r.change_7d.toFixed(1) + "%") + '</div><div class="l">TVL change, 7 days</div></div>' +
      '<div class="card"><div class="v">' + age(r.age_years) + '</div><div class="l">running with no token</div></div></div>' +
      "<h3>Why this rank — the model, step by step</h3>" +
      '<div class="math">TVL ' + fullMoney(r.tvl_usd) + " × multiple " + r.multiple.toFixed(2) + " (" + esc(compLine) + ") = base " + fullMoney(r.base_value) +
      "\n× growth " + r.growth_factor.toFixed(2) + " (7d " + chg + ") × age " + r.age_factor.toFixed(2) + " (" + age(r.age_years) + " with no token) = implied " + fullMoney(r.implied_value_usd) + "</div>" +
      "<h3>How sure is the number? Move the multiple, move the value</h3>" +
      '<table class="sens"><thead><tr><th>Multiple</th><th>Implied value</th></tr></thead><tbody>' +
      "<tr><td>" + (r.multiple * 0.8).toFixed(2) + "x (20% lower)</td><td>" + fullMoney(r.implied_low) + "</td></tr>" +
      "<tr><td><b>" + r.multiple.toFixed(2) + "x (as priced)</b></td><td><b>" + fullMoney(r.implied_value_usd) + "</b></td></tr>" +
      "<tr><td>" + (r.multiple * 1.2).toFixed(2) + "x (20% higher)</td><td>" + fullMoney(r.implied_high) + "</td></tr></tbody></table>" +
      "<h3>TVL against implied value — every row on the board</h3>" +
      '<div class="scatterWrap"><canvas id="scatter" width="560" height="360"></canvas>' +
      '<div class="legend"><p><span class="sw" style="background:#d9a441"></span>Watchlist protocol</p>' +
      "<p><span class=\"sw\" style=\"background:#6ea8d8\"></span>Early radar protocol</p>" +
      "<p><span class=\"sw\" style=\"background:#e06c5a\"></span>This protocol</p>" +
      "<p>Both axes are logarithmic. A protocol far above the diagonal earns a higher multiple " +
      "than its TVL alone would suggest; one far below it is priced down by its category.</p></div></div>" +
      "<h3>Against its own category</h3>" +
      '<div class="vsbar"><div class="lbl"><span>' + esc(r.name) + ' TVL ' + money(r.tvl_usd) + '</span><span>category median ' + money(medTvl) + "</span></div>" +
      '<div class="track"><div class="fill" style="width:' + Math.max(2, Math.min(100, (r.tvl_usd / Math.max(medTvl, r.tvl_usd)) * 100)) + '%"></div></div></div>' +
      '<div class="vsbar"><div class="lbl"><span>Multiple ' + r.multiple.toFixed(2) + 'x</span><span>category median ' + r.cat_median.toFixed(2) + "x</span></div>" +
      '<div class="track"><div class="fill cmp" style="width:' + Math.max(2, Math.min(100, (r.multiple / Math.max(r.cat_median, r.multiple)) * 100)) + '%"></div></div></div>' +
      "<h3>How to farm it</h3>" +
      '<ol class="steps">' + r.farm_steps.map(function (s) {
        var cut = s.lastIndexOf("Cost:");
        var head = cut > -1 ? s.slice(0, cut) : s;
        var tail = cut > -1 ? s.slice(cut) : "";
        return "<li>" + esc(head) + '<span class="cost">' + esc(tail) + "</span></li>";
      }).join("") + "</ol>";
    drawScatter($("scatter"), r);
    render();
    if (scroll) $("detail").scrollIntoView({ behavior: "auto", block: "start" });
  }

  function drawScatter(canvas, sel) {
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height, pad = 44;
    var xs = rows.map(function (r) { return Math.log10(Math.max(1, r.tvl_usd)); });
    var ys = rows.map(function (r) { return Math.log10(Math.max(1, r.implied_value_usd)); });
    var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
    function X(v) { return pad + ((Math.log10(Math.max(1, v)) - x0) / (x1 - x0)) * (W - pad - 16); }
    function Y(v) { return H - pad - ((Math.log10(Math.max(1, v)) - y0) / (y1 - y0)) * (H - pad - 16); }
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "#262e3b"; ctx.fillStyle = "#6b7686"; ctx.font = "11px sans-serif"; ctx.lineWidth = 1;
    for (var gx = x0; gx <= x1; gx++) {
      var px = pad + ((gx - x0) / (x1 - x0)) * (W - pad - 16);
      ctx.beginPath(); ctx.moveTo(px, 16); ctx.lineTo(px, H - pad); ctx.stroke();
      ctx.fillText("10^" + gx, px - 8, H - pad + 16);
    }
    for (var gy = y0; gy <= y1; gy++) {
      var py = H - pad - ((gy - y0) / (y1 - y0)) * (H - pad - 16);
      ctx.beginPath(); ctx.moveTo(pad, py); ctx.lineTo(W - 16, py); ctx.stroke();
      ctx.fillText("10^" + gy, 6, py + 4);
    }
    ctx.fillStyle = "#9aa5b4"; ctx.font = "12px sans-serif";
    ctx.fillText("TVL (USD, log)", W / 2 - 40, H - 8);
    ctx.save(); ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("Implied value (USD, log)", -70, 0); ctx.restore();
    rows.forEach(function (r) {
      ctx.beginPath();
      ctx.arc(X(r.tvl_usd), Y(r.implied_value_usd), r.slug === sel.slug ? 6 : r.watchlist ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = r.slug === sel.slug ? "#e06c5a" : r.watchlist ? "#d9a441" : "#6ea8d8";
      ctx.fill();
    });
  }

  // ---- live tokens, set aside ------------------------------------------
  $("liveNote").textContent =
    R.live_n + " live tokens were priced as comparables and set aside; the twelve largest by market cap are shown. " +
    "A protocol leaves this list and joins the board only when the snapshot stops recording a token for it.";
  $("liveRows").innerHTML = R.live.slice(0, 12).map(function (p) {
    return "<tr><td>" + esc(p.name) + "</td><td>" + esc(p.category) + "</td><td>" + money(p.tvl_usd) +
      "</td><td>" + money(p.mcap_usd) + "</td><td>" + p.ratio.toFixed(2) + "x</td></tr>";
  }).join("");

  // ---- hash routing (for screenshots and deep links) -------------------
  var hash = location.hash || "";
  var m = hash.match(/#detail=([\w-]+)/);
  var c = hash.match(/#cat=([^&]+)/);
  if (c) { $("cat").value = decodeURIComponent(c[1]); }
  readControls();
  render();
  if (m) openDetail(m[1], false);
})();
