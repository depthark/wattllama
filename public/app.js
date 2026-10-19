const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let S = null, range = "24h", series = null;

const fmtW = (w) => w == null ? "–" : `${Math.round(w)} W`;
const energy = (wh) => wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh.toFixed(wh < 10 ? 2 : 0)} Wh`;
const dur = (s) => s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const nf = (n) => Math.round(n).toLocaleString();
const when = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
// Optional cost (DASH_PRICE_PER_KWH / DASH_CURRENCY): "" when no price is set.
let PRICE = null, CUR = "";
function money(wh) {
  if (!PRICE || wh == null) return "";
  const v = wh / 1000 * PRICE, digits = v < 1000 ? 2 : 0;
  if (/^[A-Z]{3}$/.test(CUR)) {
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: CUR, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v); } catch {}
  }
  return `${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${CUR ? " " + CUR : ""}`;
}
const withCost = (wh) => PRICE ? `${energy(wh)} · ${money(wh)}` : energy(wh);
const extraWh = (p) => S.idleW == null ? null : Math.max(0, p.wha - S.idleW * p.act / 3600);

async function get(u) { const r = await fetch(u, { cache: "no-store" }); if (!r.ok) throw new Error(r.status); return r.json(); }

async function refreshLive() {
  try {
    const L = await get("api/live");
    $("nowW").innerHTML = L.sysW == null ? "–" : `${Math.round(L.sysW)} <small>W whole PC (est.)</small>`;
    $("nowGpu").textContent = L.gpu ? `${fmtW(L.gpu.power)} · ${L.gpu.temp ?? "–"} °C · ${Math.round(L.gpu.util)} %` : "not measured";
    $("nowCpu").textContent = L.cpu ? `${fmtW(L.cpu.power + L.cpu.dram)} · ${Math.round(L.cpu.util)} %${L.cpu.measured ? "" : " (est.)"}` : "–";
    $("nowVram").textContent = L.gpu?.vramTotal ? `${(L.gpu.vramUsed / 1024).toFixed(1)} / ${(L.gpu.vramTotal / 1024).toFixed(1)} GB` : "–";
    const m = L.llm;
    liveModels = m?.models || [];
    $("status").innerHTML = !m ? "LLM tracking off"
      : !m.reachable ? `no engine running (${esc(m.engines.map((e) => e.name).join(", "))})`
      : !liveModels.length ? "no model loaded"
      : liveModels.map((x) => x.processing
          ? `<b><span class="dot run"></span>${esc(short(x.id))} · ${Math.round(x.genRate)} tok/s</b>`
          : `<span class="dot ok"></span>${esc(short(x.id))} idle`).join(" &nbsp; ");
    renderHardware(L);
    renderAlertBar(L.alerts || []);
    const asig = (L.alerts || []).map((a) => a.since).join();
    if (asig !== alertSig) { alertSig = asig; safe(refreshAlerts); }     // a new alert: notify now, not in 30 s
    const sig = liveModels.map((x) => x.id + x.processing + (x.slots || []).map((s) => s.ctx).join("/")).join();
    if (sig !== liveSig) { liveSig = sig; renderModels(); }
  } catch { $("status").textContent = "dashboard not reachable"; }
}

async function refreshSummary() {
  S = await get("api/summary");
  renderModels(); fillHeatModels();
  PRICE = S.price; CUR = S.currency || "";
  const t = S.today, m = S.month, a = S.all;
  $("todayKwh").textContent = energy(t.wh);
  for (const id of ["costRow", "costMRow"]) $(id).hidden = !PRICE;
  $("todayCost").textContent = PRICE ? `${money(t.wh)} · LLM ${money(t.wha)}` : "";
  $("costM").textContent = PRICE && a.gen > 0 ? money(a.wha / (a.gen / 1e6)) : "–";
  $("todayOn").textContent = dur(t.secs);
  $("todayL").textContent = `${energy(t.wha)} · ${dur(t.act)}`;
  const ex = extraWh(t);
  $("todayExtra").textContent = ex == null ? "learning idle power…" : `${energy(ex)} (idle ≈ ${Math.round(S.idleW)} W)`;
  $("yKwh").textContent = withCost(S.yesterday.wh);
  $("wKwh").textContent = withCost(S.week.wh);
  $("mKwh").textContent = withCost(m.wh);
  $("mL").textContent = `${withCost(m.wha)} · ${dur(m.act)}`;
  $("tokToday").innerHTML = `${nf(t.gen)} <small>tokens today</small>`;
  $("actToday").textContent = `${dur(t.act)} · prefill ${nf(t.pp)}`;
  $("whk").textContent = a.gen > 0 ? energy(a.wha / (a.gen / 1000)) : "–";
  $("per1m").textContent = a.gen > 0 ? energy(a.wha / (a.gen / 1e6)) : "–";
  $("foot").textContent = `GPU (nvidia-smi; AMD / Intel via LibreHardwareMonitor or Linux hwmon) and CPU + RAM (RAPL energy counters) are measured; the rest of the PC is an estimate of ${S.restW} W `
    + `and the power supply ${Math.round(S.psuEff * 100)} % efficient. The monitor is not included. Data since ${S.first ? new Date(S.first).toLocaleString() : "now"}.`;
}

async function refreshSeries() { series = await get(`api/series?range=${range}`); drawAll(); }
function csvLinks() {
  const r = range === "1h" || range === "6h" ? "24h" : range;
  $("csvMin").href = `api/export.csv?data=minutes&range=${r}`;
  $("csvMod").href = `api/export.csv?data=models&range=${r}`;
  $("csvRuns").href = `api/export.csv?data=runs&range=${r}`;
}
csvLinks();

let runsAll = false, runsData = [];
async function refreshRuns() { runsData = await get("api/runs"); drawRuns(); }
function drawRuns() {
  const R = runsAll ? runsData : runsData.slice(0, 10);
  $("runsMore").hidden = runsData.length <= 10;
  $("runsMore").textContent = runsAll ? "Show fewer" : `Show all ${runsData.length}`;
  $("runs").innerHTML = R.length
    ? `<tr><th>start</th><th>model</th><th class="n">busy</th><th class="n">requests</th><th class="n">tokens</th><th class="n">prefill</th><th class="n">tok/s</th><th class="n">energy</th>${PRICE ? '<th class="n">cost</th>' : ""}<th class="n">Wh / 1k tok</th></tr>`
      + R.map((r) => `<tr><td>${r.open ? '<span class="dot run"></span>' : ""}${when(r.start)}</td><td>${esc(r.model || "–")}</td>
        <td class="n">${dur(r.active_s)}</td><td class="n">${nf(r.req || 0)}</td><td class="n">${nf(r.gen_tok)}</td><td class="n">${nf(r.pp_tok)}</td>
        <td class="n">${r.active_s > 0 && r.gen_tok ? (r.gen_tok / r.active_s).toFixed(1) : "–"}</td>
        <td class="n">${energy(r.wh)}</td>${PRICE ? `<td class="n">${money(r.wh)}</td>` : ""}<td class="n">${r.gen_tok ? (r.wh / (r.gen_tok / 1000)).toFixed(2) : "–"}</td></tr>`).join("")
    : `<tr><td class="muted">No runs yet. A run is recorded each time a model works.</td></tr>`;
}
$("runsMore").addEventListener("click", () => { runsAll = !runsAll; drawRuns(); });

function chips(list, cls = "") { return `<div class="chips">${list.map((x) => `<span class="chip ${cls}">${x}</span>`).join("")}</div>`; }
const gb = (b) => b ? `${(b / 1024 ** 3).toFixed(1)} GB` : "";
const bn = (n) => n ? `${(n / 1e9).toFixed(1)}B params` : "";

let liveModels = [], liveSig = "", setupModels = null;
const short = (id) => String(id).replace(/\.gguf$/i, "");

// One card per model: live state, today's / all-time numbers, and its exact parameters.
function renderModels() {
  if (!setupModels) return;
  if (!setupModels.length) { $("models").innerHTML = `<div class="card muted">No inference engine reachable. WattLlama reads llama.cpp; see the README to connect it.</div>`; return; }
  const stat = (when, id) => (S?.models?.[when] || []).find((x) => x.model === id);
  $("models").innerHTML = setupModels.map((m) => {
    const lv = liveModels.find((x) => x.id === m.id);
    const st = lv?.processing ? ["run", `generating · ${Math.round(lv.genRate)} tok/s`] : m.status === "loaded" ? ["ok", "loaded · idle"] : ["", m.status || "unloaded"];
    const t = stat("today", m.id), a = stat("all", m.id);
    const rows = t || a ? `
      <div class="row"><span>today</span><span>${nf(t?.req || 0)} req · ${t?.gen ? nf(t.gen) + " tok out · " : ""}${nf(t?.pp || 0)} tok in · ${dur(t?.act || 0)} busy</span></div>
      <div class="row"><span>energy while busy today</span><span>${withCost(t?.wh || 0)}</span></div>
      <div class="row"><span>all time</span><span>${nf(a?.req || 0)} req · ${a?.gen ? `${nf(a.gen)} tok · ${energy(a.wh / (a.gen / 1000))} / 1k tok` : `${dur(a?.act || 0)} busy · ${a?.req ? energy(a.wh / a.req) + " / req" : "–"}`}</span></div>` : "";
    return `<div class="card"><h3><span class="dot ${st[0]}"></span>${esc(st[1])}${m.kind && m.kind !== "text" ? ` · ${esc(m.kind)}` : ""}<span class="eng">${esc(m.engine)}</span></h3>
      <div style="font-weight:600;margin-bottom:4px;word-break:break-all">${esc(m.id)}</div>
      <div class="muted" style="font-size:12px;margin-bottom:8px">${[m.paramsText ? `${esc(m.paramsText)} params` : bn(m.params), gb(m.size), m.ctxTrain ? `trained ctx ${nf(m.ctxTrain)}` : ""].filter(Boolean).join(" · ")}</div>
      ${(lv?.slots || []).filter((sl) => sl.nCtx).map((sl, i, all) => `<div class="ctxbar"><div class="row"><span>context${all.length > 1 ? ` slot ${i}` : ""}${sl.speculative ? " · speculative" : ""}</span>
        <span>${nf(sl.ctx)} / ${nf(sl.nCtx)} (${Math.round(100 * sl.ctx / sl.nCtx)} %)</span></div>${bar(sl.ctx, sl.nCtx, sl.processing ? "--llm" : "--cpu")}</div>`).join("")}
      ${rows}<div style="margin-top:8px">${m.args.length ? chips(m.args.map(([k, v]) => v === "" ? esc(k) : `${esc(k)} <b>${esc(v)}</b>`), "k") : '<span class="muted">not loaded: parameters appear once it runs</span>'}</div>
    </div>`;
  }).join("");
}

async function refreshSetup() {
  const X = await get("api/setup");
  setupModels = (X.engines || []).flatMap((E) => (E.models || []).map((m) => ({ ...m, engine: E.engine })));
  renderModels();
  const P = X.pi;
  $("piWrap").hidden = !P || P.error;
  if (P && !P.error) {
    const c = P.compaction;
    $("pi").innerHTML = `
      <div class="card"><h3>Default</h3>
        <div class="row"><span>pi CLI</span><span>${esc(P.version || "–")}</span></div>
        <div class="row"><span>provider</span><span>${esc(P.provider || "–")}</span></div>
        <div class="row"><span>model</span><span style="word-break:break-all">${esc(P.model || "–")}</span></div>
        <div class="row"><span>thinking</span><span>${esc(P.thinking || "–")}</span></div>
        <div class="row"><span>compaction</span><span>${c ? (c.enabled ? `on · reserve ${nf(c.reserveTokens || 0)} · keep ${nf(c.keepRecentTokens || 0)}` : "off") : "–"}</span></div>
        <div class="row"><span>retry</span><span>${P.retry ? "on" : "off"}</span></div>
      </div>
      <div class="card"><h3>Tools</h3>${chips(P.tools.map(esc))}</div>
      <div class="card"><h3>Extensions · packages</h3>${chips([...P.extensions, ...P.packages].map(esc)) || "–"}</div>
      <div class="card"><h3>Skills</h3>${P.skills.length ? chips(P.skills.map(esc)) : '<span class="muted">none</span>'}</div>
      <div class="card"><h3>Providers</h3>${P.providers.map((p) => `<div class="row"><span>${esc(p.name)}</span><span style="word-break:break-all">${p.models.map(esc).join(", ") || "–"}</span></div>`).join("") || "–"}
        <div class="row"><span>enabled</span><span>${P.enabledModels.map(esc).join(", ")}</span></div></div>`;
  }
  const T = X.tasks;
  $("tasksWrap").hidden = !Array.isArray(T);
  if (Array.isArray(T)) {
    const res = (t) => t.state === "Running" || t.lastResult === 267009 ? ["run", "running"]
      : t.lastResult === 0 ? ["ok", "OK"] : t.lastResult === 267011 ? ["", "never ran"]
      : ["bad", `0x${(t.lastResult >>> 0).toString(16)}`];
    $("tasks").innerHTML = `<tr><th>task</th><th>schedule</th><th>last run</th><th>result</th><th>next run</th></tr>`
      + T.map((t) => { const [d, txt] = res(t); return `<tr><td>${esc(t.name)}${t.state === "Disabled" ? ' <span class="muted">(disabled)</span>' : ""}</td>
        <td>${esc(t.schedule)}</td><td>${t.lastRun ? when(t.lastRun) : "–"}</td><td><span class="dot ${d}"></span>${txt}</td>
        <td>${t.nextRun ? when(t.nextRun) : "–"}</td></tr>`; }).join("");
  }
}

// ---------- hardware: GPU, CPU, memory, disk, sensors, power limit ----------

const bar = (v, max, color) => `<div class="meter"><div style="width:${Math.max(0, Math.min(100, 100 * v / (max || 1)))}%;background:var(${color})"></div></div>`;
const mbps = (b) => b == null ? "–" : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB/s` : `${Math.round(b / 1024)} KB/s`;
let hwControl = false, plDraft = {};

function renderHardware(L) {
  hwControl = !!L.control;
  const cards = [];
  for (const g of L.gpus || []) {
    const pl = plDraft[g.index] ?? Math.round(g.limit ?? 0);
    cards.push(`<div class="card"><h3>GPU ${esc(g.index)} · ${esc(g.name)}</h3>
      <div class="row"><span>power</span><span>${fmtW(g.power)}${g.limit ? ` of ${fmtW(g.limit)} limit` : ""}</span></div>${g.limit ? bar(g.power, g.limit, "--gpu") : ""}
      <div class="row"><span>temperature</span><span>${g.temp ?? "–"} °C</span></div>
      <div class="row"><span>fan</span><span>${g.fan == null ? "–" : `${g.fan} %`}</span></div>
      <div class="row"><span>load · memory bus</span><span>${g.util ?? "–"} % · ${g.memUtil ?? "–"} %</span></div>
      <div class="row"><span>clocks core · mem</span><span>${g.clockSm ?? "–"} · ${g.clockMem ?? "–"} MHz</span></div>
      ${g.vramTotal ? `<div class="row"><span>VRAM</span><span>${(g.vramUsed / 1024).toFixed(1)} / ${(g.vramTotal / 1024).toFixed(1)} GB</span></div>${bar(g.vramUsed, g.vramTotal, "--cpu")}` : ""}
      ${g.source ? `<div class="muted" style="font-size:12px">read from ${esc(g.source)}</div>` : `
      <div class="row"><span>state · PCIe</span><span>${esc(g.pstate || "–")} · ${esc(g.pcie || "–")}</span></div>
      <div class="row"><span>held back by</span><span>${g.throttle?.length ? esc(g.throttle.join(", ")) : "nothing"}</span></div>`}
      ${g.limitMin != null ? `<div class="pl">
        <div class="row"><span>power limit</span><span><b id="plv${esc(g.index)}">${pl} W</b> <span class="muted">(${g.safeMin}–${g.safeMax}, default ${Math.round(g.limitDefault)}${g.safeMax < Math.floor(g.limitMax) ? `; card max ${Math.round(g.limitMax)} needs DASH_POWER_LIMIT_ABOVE_DEFAULT=1` : ""})</span></span></div>
        ${hwControl ? `<input type="range" min="${g.safeMin}" max="${g.safeMax}" step="5" value="${pl}" data-gpu="${esc(g.index)}" class="plr">
        <div class="hd"><button class="theme" data-apply="${esc(g.index)}">Apply (asks ${L.platform === "linux" ? "password" : "UAC"})</button><button class="theme" data-reset="${esc(g.index)}">Reset to default</button><span class="muted" id="plmsg${esc(g.index)}"></span></div>`
        : `<div class="muted" style="font-size:12px">Control is off. Set DASH_ALLOW_POWER_LIMIT=1 to change it from here.</div>`}
      </div>` : ""}
    </div>`);
  }
  const c = L.cpu;
  if (c) {
    cards.push(`<div class="card"><h3>CPU</h3>
      <div class="row"><span>package power</span><span>${fmtW(c.power)}${c.measured ? "" : " (est.)"}</span></div>
      <div class="row"><span>RAM power</span><span>${c.dram ? `${c.dram.toFixed(1)} W` : "–"}</span></div>
      <div class="row"><span>load</span><span>${Math.round(c.util)} %</span></div>${bar(c.util, 100, "--cpu")}
      <div class="row"><span>effective clock</span><span>${c.mhz ? `${Math.round(c.mhz)} MHz` : "–"}</span></div>
      <div class="row"><span>temperature</span><span>${c.temp != null ? `${Math.round(c.temp)} °C` : L.lhm === "off" ? '<span class="muted">see More sensors</span>' : L.lhm === "native" ? '<span class="muted">no sensor</span>' : '<span class="muted">LHM not reachable</span>'}</span></div>
      ${c.zoneC != null ? `<div class="row"><span>ACPI thermal zone</span><span>${c.zoneC.toFixed(0)} °C</span></div>` : ""}
    </div>`);
  }
  cards.push(`<div class="card"><h3>Memory · disk</h3>
    <div class="row"><span>RAM</span><span>${(L.ram.used / 1073741824).toFixed(1)} / ${(L.ram.total / 1073741824).toFixed(1)} GB</span></div>${bar(L.ram.used, L.ram.total, "--gpu")}
    ${L.gpu ? `<div class="row"><span>VRAM (all GPUs)</span><span>${(L.gpu.vramUsed / 1024).toFixed(1)} / ${(L.gpu.vramTotal / 1024).toFixed(1)} GB</span></div>${bar(L.gpu.vramUsed, L.gpu.vramTotal, "--cpu")}` : ""}
    <div class="row"><span>disk read</span><span>${mbps(L.disk?.read)}</span></div>
    <div class="row"><span>disk write</span><span>${mbps(L.disk?.write)}</span></div>
  </div>`);
  for (const grp of L.sensors || []) {
    const rows = grp.sensors.map((x) => `<div class="row"><span>${esc(x.name)}</span><span>${x.kind === "fan" ? `${Math.round(x.value)} RPM` : `${x.value.toFixed(0)} °C`}</span></div>`).join("");
    cards.push(`<div class="card"><h3>${esc(grp.hardware)}</h3>${rows}</div>`);
  }
  if (L.lhm === "off") cards.push(`<div class="card muted" style="font-size:13px"><h3>More sensors</h3>
    CPU core temperatures, fans, motherboard and SSD temperatures need a hardware driver that Windows does not ship.
    Run <b>LibreHardwareMonitor</b> with <i>Options → Remote Web Server</i> and set <code>DASH_LHM_URL=http://127.0.0.1:8085</code>.</div>`);
  // Keep a slider the user is dragging: re-render only when not interacting with the controls.
  if (!document.activeElement?.closest?.("#hw")) $("hw").innerHTML = cards.join("");
}

$("hw").addEventListener("input", (e) => {
  const r = e.target.closest(".plr"); if (!r) return;
  plDraft[r.dataset.gpu] = Number(r.value);
  $(`plv${r.dataset.gpu}`).textContent = `${r.value} W`;
});
$("hw").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-apply],button[data-reset]"); if (!b) return;
  const gpu = b.dataset.apply ?? b.dataset.reset, msg = $(`plmsg${gpu}`);
  const body = b.dataset.reset != null ? { gpu, reset: true } : { gpu, watts: plDraft[gpu] };
  msg.textContent = "confirm the prompt…"; b.disabled = true;
  try {
    const r = await fetch("api/gpu/power-limit", { method: "POST", headers: { "content-type": "application/json", "x-wattllama": "1" }, body: JSON.stringify(body) });
    const j = await r.json();
    msg.textContent = j.ok ? `set to ${j.watts} W` : j.error;
    if (j.ok) delete plDraft[gpu];
  } catch { msg.textContent = "failed"; }
  b.disabled = false; b.blur();
});

async function refreshEfficiency() {
  const E = await get("api/efficiency");
  $("eff").innerHTML = E.length
    ? `<tr><th>GPU power limit</th><th class="n">avg GPU draw</th><th class="n">tokens</th><th class="n">tok/s</th><th class="n">Wh / 1k tok</th><th class="n">tokens / Wh</th><th class="n">minutes</th></tr>`
      + E.map((r) => `<tr><td>${r.pl} W</td><td class="n">${fmtW(r.gpuw)}</td><td class="n">${nf(r.gen)}</td>
        <td class="n">${(r.gen / r.act).toFixed(1)}</td><td class="n">${(r.wh / (r.gen / 1000)).toFixed(2)}</td>
        <td class="n">${(r.gen / r.wh).toFixed(0)}</td><td class="n">${nf(r.minutes)}</td></tr>`).join("")
    : `<tr><td class="muted">Generate with different power limits and compare speed and energy per token here.</td></tr>`;
}

// ---------- inference details: per request speed, prefill, draft acceptance, cache ----------

let reqRange = "24h", reqData = null;
const median = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
async function refreshRequests() {
  const model = $("reqModel").value;
  reqData = await get(`api/requests?range=${reqRange}${model ? `&model=${encodeURIComponent(model)}` : ""}`);
  const sel = $("reqModel"), want = reqData.models.map((m) => m.model).join("|");
  if (sel.dataset.ids !== want) {
    const keep = sel.value;
    sel.dataset.ids = want;
    sel.innerHTML = `<option value="">All models</option>` + reqData.models.map((m) => `<option value="${esc(m.model)}">${esc(short(m.model))} (${esc(m.engine)})</option>`).join("");
    sel.value = reqData.models.some((m) => m.model === keep) ? keep : "";
  }
  drawRequests();
}
function drawRequests() {
  if (!reqData) return;
  const R = reqData.rows;
  const dec = R.filter((r) => r.gen_tok > 0 && r.gen_ms > 0).map((r) => ({ x: r.ctx, y: r.gen_tok / (r.gen_ms / 1000), r }));
  const pre = R.filter((r) => r.pp_tok >= 16 && r.pp_ms > 0).map((r) => ({ x: r.ctx, y: r.pp_tok / (r.pp_ms / 1000), r }));
  const dAcc = R.reduce((a, r) => a + (r.draft_acc || 0), 0), dGen = R.reduce((a, r) => a + (r.draft_gen || 0), 0);
  const cached = R.reduce((a, r) => a + (r.cached || 0), 0), computed = R.reduce((a, r) => a + (r.pp_tok || 0), 0);
  const card = (title, big, sub) => `<div class="card"><h3>${title}</h3><div class="big">${big}</div><div class="muted" style="font-size:12px">${sub}</div></div>`;
  $("reqStats").innerHTML = !R.length
    ? `<div class="card muted">No requests recorded yet. Exact per-request details come from the llama.cpp log (DASH_LLAMA_LOG), Ollama's log or LM Studio.</div>`
    : [card("Requests", nf(R.length), `median context ${nf(median(R.map((r) => r.ctx)) || 0)} tokens`),
      card("Generation", median(dec.map((p) => p.y))?.toFixed(1) ?? "–", "median tok/s"),
      card("Prefill", median(pre.map((p) => p.y))?.toFixed(0) ?? "–", `median tok/s · first token ${median(R.map((r) => r.pp_ms)) != null ? (median(R.map((r) => r.pp_ms)) / 1000).toFixed(2) + " s" : "–"}`),
      card("Speculative", dGen ? `${Math.round(100 * dAcc / dGen)} %` : "–", dGen ? `${nf(dAcc)} of ${nf(dGen)} drafted tokens accepted` : "no draft model / MTP"),
      card("Prompt cache", cached + computed ? `${Math.round(100 * cached / (cached + computed))} %` : "–", "of prompt tokens reused, not recomputed"),
    ].join("");
  scatter($("cDecode"), dec, css("--llm"));
  scatter($("cPrefill"), pre, css("--gpu"));
  $("reqTable").innerHTML = R.length
    ? `<tr><th>time</th><th>model</th><th class="n">context</th><th class="n">prompt new / cached</th><th class="n">prefill tok/s</th><th class="n">generated</th><th class="n">tok/s</th><th class="n">draft accepted</th></tr>`
      + R.slice(0, 15).map((r) => `<tr><td>${when(r.ts)}</td><td>${esc(short(r.model))}</td><td class="n">${r.ctx != null ? nf(r.ctx) : "–"}${r.n_ctx ? ` <span class="muted">/ ${nf(r.n_ctx)}</span>` : ""}</td>
        <td class="n">${nf(r.pp_tok || 0)} / ${r.cached != null ? nf(r.cached) : "–"}</td><td class="n">${r.pp_tok >= 16 && r.pp_ms ? nf(r.pp_tok / (r.pp_ms / 1000)) : "–"}</td>
        <td class="n">${nf(r.gen_tok || 0)}</td><td class="n">${r.gen_ms ? (r.gen_tok / (r.gen_ms / 1000)).toFixed(1) : "–"}</td>
        <td class="n">${r.draft_gen ? `${Math.round(100 * r.draft_acc / r.draft_gen)} %` : "–"}</td></tr>`).join("")
    : "";
}
// x = context depth, y = tokens per second; hover shows the request.
function scatter(cv, pts, color) {
  const { g, w, h } = setup(cv);
  const L = 48, R = 10, T = 6, B = 22, pw = w - L - R, ph = h - T - B;
  const xmax = niceMax(Math.max(1000, ...pts.map((p) => p.x || 0))), ymax = niceMax(Math.max(1, ...pts.map((p) => p.y)));
  const X = (v) => L + (v / xmax) * pw, Y = (v) => T + ph - (v / ymax) * ph;
  g.font = "11px system-ui"; g.fillStyle = css("--dim"); g.strokeStyle = css("--line"); g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const v = (ymax / 4) * i; g.beginPath(); g.moveTo(L, Y(v) + .5); g.lineTo(L + pw, Y(v) + .5); g.stroke(); g.fillText(Math.round(v), 4, Y(v) + 4); }
  for (let i = 0; i <= 4; i++) { const v = (xmax / 4) * i; g.fillText(v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : v, X(v) - 8, h - 6); }
  g.fillStyle = color; g.globalAlpha = 0.7;
  for (const p of pts) { g.beginPath(); g.arc(X(p.x || 0), Y(p.y), 2.6, 0, 7); g.fill(); }
  g.globalAlpha = 1;
  if (!pts.length) { g.fillStyle = css("--dim"); g.fillText("no data in this range", L + pw / 2 - 50, T + ph / 2); }
  cv._scatter = { pts, X, Y };
}
for (const id of ["cDecode", "cPrefill"]) {
  const cv = $(id), tip = cv.nextElementSibling;
  cv.addEventListener("mousemove", (e) => {
    const S = cv._scatter; if (!S) return;
    const rect = cv.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best = null, bd = 1e9;
    for (const p of S.pts) { const d = Math.hypot(S.X(p.x || 0) - mx, S.Y(p.y) - my); if (d < bd) { bd = d; best = p; } }
    if (!best || bd > 12) { tip.style.display = "none"; return; }
    tip.textContent = `${when(best.r.ts)} · ${short(best.r.model)} · ${nf(best.x || 0)} tokens deep · ${best.y.toFixed(1)} tok/s`;
    tip.style.display = "block";
    tip.style.left = Math.max(0, Math.min(mx + 14, rect.width - tip.offsetWidth - 4)) + "px"; tip.style.top = "26px";
  });
  cv.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}
$("reqModel").addEventListener("change", () => safe(refreshRequests));
pick("reqRange", "r", (r) => { reqRange = r; safe(refreshRequests); });

// ---------- alerts: bar on top, rules and events, optional browser notifications ----------

function renderAlertBar(active) {
  const bar = $("alertBar");
  bar.hidden = !active.length;
  bar.innerHTML = active.map((a) => `<div>⚠️ <b>${esc(a.title)}</b> <span class="muted">since ${when(a.since)}</span></div>`).join("");
}

let lastNotified = 0, alertSig = "";
try { lastNotified = Number(localStorage.getItem("wattllama-notified")) || 0; } catch {}
async function refreshAlerts() {
  const A = await get("api/alerts");
  const s = A.settings;
  const rule = (on, text) => on ? `<span class="chip">${esc(text)}</span>` : "";
  $("alertRules").innerHTML = !s.enabled ? '<span class="muted">Alerts are off (DASH_ALERTS=0).</span>' : [
    rule(s.gpuTemp != null, `GPU ≥ ${s.gpuTemp} °C`), rule(s.cpuTemp != null, `CPU ≥ ${s.cpuTemp} °C`), rule(s.vramPct != null, `VRAM ≥ ${s.vramPct} %`),
    rule(s.throttle, "GPU throttling"), rule(s.engineDown, "engine down"), rule(s.busyMin, `busy > ${s.busyMin} min`),
    rule(s.dailyKwh != null, `over ${s.dailyKwh} kWh / day`), rule(s.dailyCost != null, `over ${s.dailyCost} / day`),
    `<span class="chip">${s.webhook === "invalid" ? "webhook: invalid URL" : s.webhook ? `to phone: ${esc(s.webhook)}` : "to phone: off (DASH_ALERT_WEBHOOK)"}</span>`,
  ].join("");
  $("alertEvents").innerHTML = A.events.length
    ? `<tr><th>time</th><th>alert</th><th>details</th><th>sent</th></tr>` + A.events.slice(0, 30).map((e) => `<tr><td>${when(e.ts)}</td>
        <td class="lvl-${esc(e.level)}">${esc(e.title)}</td><td>${esc(e.message)}</td><td>${e.sent ? "✓" : ""}</td></tr>`).join("")
    : `<tr><td class="muted">No alerts yet. They appear here when a temperature, the VRAM, an engine or a budget needs attention.</td></tr>`;
  // Browser notifications for new warnings, while this page is open somewhere.
  const fresh = A.events.filter((e) => e.ts > lastNotified && e.level !== "ok");
  if (fresh.length && "Notification" in window && Notification.permission === "granted" && lastNotified) {
    for (const e of fresh.slice(0, 3).reverse()) new Notification(`WattLlama: ${e.title}`, { body: e.message, icon: "logo.svg", tag: `wl-${e.ts}` });
  }
  if (A.events[0]) { lastNotified = Math.max(lastNotified, A.events[0].ts); try { localStorage.setItem("wattllama-notified", String(lastNotified)); } catch {} }
  else if (!lastNotified) lastNotified = 1;
  drawNotifyBtn();
}
function drawNotifyBtn() {
  const b = $("notifyBtn");
  if (!("Notification" in window) || !isSecureContext) { b.hidden = true; return; }      // http on a LAN IP is not a secure context
  b.hidden = false;
  b.textContent = Notification.permission === "granted" ? "Browser notifications: on" : Notification.permission === "denied" ? "Browser notifications: blocked" : "Enable browser notifications";
  b.disabled = Notification.permission !== "default";
}
$("notifyBtn").addEventListener("click", async () => { try { await Notification.requestPermission(); } catch {} drawNotifyBtn(); });

// ---------- report: per day and per model for a period, CSV or print / PDF ----------

const PERIOD_NAMES = { "this-month": "this month", "last-month": "last month", "7d": "last 7 days", "30d": "last 30 days",
  "this-year": "this year", "last-year": "last year", all: "all time" };
async function refreshReport() {
  const p = $("reportPeriod").value;
  $("reportCsv").href = `api/report.csv?period=${encodeURIComponent(p)}`;
  const R = await get(`api/report?period=${encodeURIComponent(p)}`);
  PRICE = R.price; CUR = R.currency || "";
  const t = R.total, day = (d) => new Date(d + "T12:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const range = `${new Date(R.from).toLocaleDateString()} – ${new Date(R.to).toLocaleDateString()}`;
  $("reportTitle").textContent = `${PERIOD_NAMES[R.period] || R.period} (${range})`;
  const card = (title, big, rows) => `<div class="card"><h3>${title}</h3><div class="big">${big}</div>${rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join("")}</div>`;
  $("reportCards").innerHTML = [
    card("Energy", energy(t.wh), [["PC on", dur(t.secs)], ["average", t.secs ? fmtW(t.wh / (t.secs / 3600)) : "–"]]),
    card("LLM", energy(t.wha), [["busy", dur(t.act)], ["share of energy", t.wh ? `${Math.round(100 * t.wha / t.wh)} %` : "–"]]),
    card("Tokens", nf(t.gen), [["prompt tokens", nf(t.pp)], ["energy per 1k tokens", t.gen ? energy(t.wha / (t.gen / 1000)) : "–"]]),
    ...(PRICE ? [card("Cost", money(t.wh), [["of which LLM", money(t.wha)], ["price", `${money(1000)} / kWh`]])] : []),
  ].join("");
  $("reportDays").innerHTML = R.days.length
    ? `<tr><th>day</th><th class="n">PC on</th><th class="n">energy</th><th class="n">LLM energy</th><th class="n">LLM busy</th><th class="n">tokens</th><th class="n">GPU max</th>${PRICE ? '<th class="n">cost</th>' : ""}</tr>`
      + R.days.map((d) => `<tr><td>${esc(day(d.day))}</td><td class="n">${dur(d.secs)}</td><td class="n">${energy(d.wh)}</td><td class="n">${energy(d.wha)}</td>
        <td class="n">${dur(d.act)}</td><td class="n">${nf(d.gen)}</td><td class="n">${d.gpu_tmax ? `${Math.round(d.gpu_tmax)} °C` : "–"}</td>${PRICE ? `<td class="n">${money(d.wh)}</td>` : ""}</tr>`).join("")
      + `<tr><th>total</th><th class="n">${dur(t.secs)}</th><th class="n">${energy(t.wh)}</th><th class="n">${energy(t.wha)}</th><th class="n">${dur(t.act)}</th><th class="n">${nf(t.gen)}</th><th></th>${PRICE ? `<th class="n">${money(t.wh)}</th>` : ""}</tr>`
    : `<tr><td class="muted">No data in this period.</td></tr>`;
  $("reportModels").innerHTML = R.models.length
    ? `<tr><th>model</th><th class="n">requests</th><th class="n">tokens out</th><th class="n">tokens in</th><th class="n">busy</th><th class="n">energy while busy</th><th class="n">Wh / 1k tok</th>${PRICE ? '<th class="n">cost</th>' : ""}</tr>`
      + R.models.map((m) => `<tr><td>${esc(short(m.model))}</td><td class="n">${nf(m.req || 0)}</td><td class="n">${nf(m.gen)}</td><td class="n">${nf(m.pp)}</td><td class="n">${dur(m.act)}</td>
        <td class="n">${energy(m.wh)}</td><td class="n">${m.gen ? (m.wh / (m.gen / 1000)).toFixed(2) : "–"}</td>${PRICE ? `<td class="n">${money(m.wh)}</td>` : ""}</tr>`).join("")
    : `<tr><td class="muted">No model activity in this period.</td></tr>`;
  $("reportNote").textContent = $("foot").textContent;
}
$("reportPeriod").addEventListener("change", () => safe(refreshReport));
$("reportPrint").addEventListener("click", () => print());

// ---------- share your result (community RESULTS.md) ----------

const REPO = "https://github.com/depthark/wattllama";
let shareData = null;
async function refreshShare() {
  shareData = await get("api/share");
  const sel = $("shareModel"), ids = shareData.models.map((m) => m.model), want = ids.join("|");
  if (sel.dataset.ids !== want) {
    const keep = sel.value;
    sel.dataset.ids = want;
    sel.innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(short(id))}</option>`).join("");
    if (ids.includes(keep)) sel.value = keep;
  }
  drawShare();
}
function shareRow() {
  const D = shareData, m = D?.models.find((x) => x.model === $("shareModel").value);
  if (!m) return null;
  const sm = (setupModels || []).find((x) => x.id === m.model);
  const quant = m.quant || sm?.args?.find(([k]) => k === "quant")?.[1] || "";
  const engine = m.engine || sm?.engine || "";
  return { gpu: D.gpus.join(" + ") || "none", cpu: D.cpu, ram: `${D.ramGB} GB`, os: D.os, model: short(m.model), quant, engine,
    power_limit: m.powerLimit ? `${m.powerLimit} W` : "", tok_s: m.tokPerS ? m.tokPerS.toFixed(1) : "",
    wh_1k: m.whPer1k.toFixed(2), tokens: String(m.tokens), version: D.version };
}
function drawShare() {
  const r = shareRow(), open = $("shareOpen");
  if (!r) { $("sharePreview").textContent = "Generate at least 1,000 tokens with a model to share a result."; open.setAttribute("aria-disabled", "true"); open.removeAttribute("href"); return; }
  const md = `| ${r.gpu} | ${r.cpu} | ${r.ram} | ${r.model} | ${r.quant || "–"} | ${r.engine || "–"} | ${r.power_limit || "–"} | ${r.tok_s || "–"} | ${r.wh_1k} | ${Number(r.tokens).toLocaleString("en")} | ${r.version} |`;
  $("sharePreview").textContent = [
    `GPU: ${r.gpu}`,
    `CPU: ${r.cpu} · RAM ${r.ram} · ${r.os}`,
    `Model: ${r.model}${r.quant ? ` (${r.quant})` : ""}${r.engine ? ` on ${r.engine}` : ""}`,
    `Generation: ${r.tok_s || "–"} tok/s · ${r.wh_1k} Wh per 1k tokens (whole PC while busy) · ${Number(r.tokens).toLocaleString()} tokens${r.power_limit ? ` · GPU limit ${r.power_limit}` : ""}`,
    "", md].join("\n");
  const q = new URLSearchParams({ template: "result.yml", title: `Result: ${r.model} on ${r.gpu}`, ...r, row: md });
  open.href = `${REPO}/issues/new?${q}`;
  open.removeAttribute("aria-disabled");
}
$("shareModel").addEventListener("change", drawShare);
$("shareCopy").addEventListener("click", async () => {
  const t = $("sharePreview").textContent;
  try { await navigator.clipboard.writeText(t); $("shareMsg").textContent = "copied"; }
  catch { getSelection().selectAllChildren($("sharePreview")); $("shareMsg").textContent = "selected: press Ctrl+C"; }
  setTimeout(() => { $("shareMsg").textContent = ""; }, 2500);
});

// ---------- tiny canvas charts ----------

function setup(cv) {
  const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}

function niceMax(v) { const p = 10 ** Math.floor(Math.log10(v)); for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v * 1.05) return m * p; return v; }

function chart(cv, opt) {
  const { g, w, h } = setup(cv);
  const rows = series.rows, step = series.step * 1000;
  const L = 48, R = 8, T = 6, B = 20, pw = w - L - R, ph = h - T - B;
  const x0 = series.from, x1 = Date.now();
  const X = (t) => L + ((t - x0) / (x1 - x0)) * pw;
  let ymax = opt.ymax ?? 0;
  for (const r of rows) {
    if (opt.stack) ymax = Math.max(ymax, opt.stack.reduce((a, k) => a + (r[k.key] || 0), 0));
    if (opt.bars) ymax = Math.max(ymax, r[opt.bars.key] || 0);
    for (const s of opt.lines) ymax = Math.max(ymax, r[s.key] || 0);
  }
  ymax = niceMax(ymax || 1);
  const Y = (v) => T + ph - (v / ymax) * ph;

  g.font = "11px system-ui"; g.fillStyle = css("--dim"); g.strokeStyle = css("--line"); g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = (ymax / 4) * i, y = Y(v);
    g.beginPath(); g.moveTo(L, y + .5); g.lineTo(L + pw, y + .5); g.stroke();
    g.fillText(opt.fmt ? opt.fmt(v) : ymax < 10 ? +v.toFixed(1) : Math.round(v), 4, y + 4);
  }
  const span = x1 - x0, tick = span <= 6.1 * 3600e3 ? 3600e3 : span <= 1.01 * 86400e3 ? 4 * 3600e3 : span <= 8 * 86400e3 ? 86400e3 : 5 * 86400e3;
  const mid = new Date(x0); mid.setHours(0, 0, 0, 0);   // ticks on local hours / midnights
  let t = mid.getTime(); while (t < x0) t += tick;
  for (; t < x1; t += tick) {
    const d = new Date(t);
    const lab = tick >= 86400e3 ? d.toLocaleDateString([], { day: "numeric", month: "numeric" }) : `${d.getHours()}:00`;
    g.fillText(lab, X(t) - 12, h - 5);
  }
  const bw = Math.max(1, (step / (x1 - x0)) * pw);

  if (opt.shade) {
    for (const r of rows) {
      const f = Math.min(1, (r.act || 0) / Math.max(1, r.s));
      if (f > 0) { g.fillStyle = `rgba(${css("--shade")},${0.08 + 0.22 * f})`; g.fillRect(X(r.t), T, bw, ph); }
    }
  }
  if (opt.stack) {
    for (const r of rows) {
      let acc = 0;
      for (const s of opt.stack) {
        const v = r[s.key] || 0;
        g.fillStyle = s.color; g.fillRect(X(r.t), Y(acc + v), bw * 0.9 + .5, Y(acc) - Y(acc + v)); acc += v;
      }
    }
  }
  if (opt.bars) {
    g.fillStyle = opt.bars.color;
    for (const r of rows) { const v = r[opt.bars.key] || 0; if (v) g.fillRect(X(r.t), Y(v), bw * 0.85 + .5, Y(0) - Y(v)); }
  }
  for (const s of opt.lines) {
    g.strokeStyle = s.color; g.lineWidth = 1.8; g.beginPath();
    let first = true, prev = null;
    for (const r of rows) {
      const v = r[s.key];
      if (v == null) continue;
      const x = X(r.t + step / 2), y = Y(v);
      if (first || (!opt.connect && prev != null && r.t - prev > step * 3)) g.moveTo(x, y); else g.lineTo(x, y);
      first = false; prev = r.t;
    }
    g.stroke();
  }
  cv._hit = { rows, X, step, opt };
}

function drawAll() {
  if (!series || !S) return;
  const rows = series.rows;
  let c = 0, cl = 0;
  for (const r of rows) { r.rest = Math.max(0, r.sys - r.gpu - r.cpu); c += r.wh / 1000; cl += r.wha / 1000; r.cum = c; r.cuml = cl; }

  chart($("cPower"), { shade: true, lines: [], stack: [
      { key: "gpu", color: css("--gpu") }, { key: "cpu", color: css("--cpu") }, { key: "rest", color: css("--rest") }],
    tip: (r) => `${Math.round(r.sys)} W · GPU ${Math.round(r.gpu)} · CPU+RAM ${Math.round(r.cpu)}${r.act ? ` · LLM ${dur(r.act)}` : ""}` });
  chart($("cEnergy"), { connect: true, lines: [{ key: "cum", color: css("--gpu") }, { key: "cuml", color: css("--llm") }],
    fmt: (v) => v.toFixed(v === 0 ? 0 : v < 1 ? 3 : v < 10 ? 2 : 1), tip: (r) => `whole PC ${r.cum.toFixed(3)} kWh · LLM ${r.cuml.toFixed(3)} kWh` });
  chart($("cTemp"), { shade: true, lines: [{ key: "tmax", color: css("--hot") }, { key: "tavg", color: css("--gpu") }, { key: "ctmax", color: css("--cpu") }], ymax: 80,
    tip: (r) => `GPU max ${Math.round(r.tmax)} °C · avg ${Math.round(r.tavg)} °C${r.ctmax != null ? ` · CPU max ${Math.round(r.ctmax)} °C` : ""}` });
  chart($("cTok"), { lines: [], bars: { key: "gen", color: css("--llm") }, fmt: (v) => v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : +v.toFixed(1),
    tip: (r) => `${nf(r.gen || 0)} tokens · ${dur(r.act || 0)} busy` });
}

for (const cv of document.querySelectorAll("canvas")) {
  const tip = cv.nextElementSibling;
  cv.addEventListener("mousemove", (e) => {
    const H = cv._hit; if (!H || !H.rows.length) return;
    const rect = cv.getBoundingClientRect(), mx = e.clientX - rect.left;
    let best = null, bd = 1e9;
    for (const r of H.rows) { const d = Math.abs(H.X(r.t + H.step / 2) - mx); if (d < bd) { bd = d; best = r; } }
    if (!best || bd > 30) { tip.style.display = "none"; return; }
    tip.textContent = `${when(best.t)} · ${H.opt.tip(best)}`;
    tip.style.display = "block";
    tip.style.left = Math.max(0, Math.min(mx + 14, rect.width - tip.offsetWidth - 4)) + "px"; tip.style.top = "26px";
  });
  cv.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}

$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  range = b.dataset.r; csvLinks();
  for (const x of $("tabs").children) x.classList.toggle("on", x === b);
  refreshSeries();
});
addEventListener("resize", () => { drawAll(); drawRequests(); });

// ---------- day x hour heatmap ----------

let heatMetric = "gen", heatDays = 7, heatModel = "", heatData = null;
const HEAT = {
  gen: { title: "Token usage by day and hour", color: "--heat", fmt: (v) => `${nf(v)} tokens`, total: (v) => `${nf(v)} tokens` },
  wh: { title: "Energy by day and hour", color: "--gpu", fmt: (v) => energy(v), total: (v) => energy(v) },   // one model: energy while it was busy
  act: { title: "LLM busy time by day and hour", color: "--cpu", fmt: (v) => dur(v), total: (v) => dur(v) },
};

async function refreshHeat() {
  heatData = await get(`api/heatmap?days=${heatDays}${heatModel ? `&model=${encodeURIComponent(heatModel)}` : ""}`);
  drawHeat();
}

function fillHeatModels() {
  const ids = [...new Set([...(S?.models?.all || []).map((x) => x.model), ...liveModels.map((x) => x.id)])];
  const sel = $("heatModel"), want = ["", ...ids].join("|");
  if (sel.dataset.ids === want) return;
  sel.dataset.ids = want;
  sel.innerHTML = `<option value="">All models</option>` + ids.map((id) => `<option value="${esc(id)}">${esc(short(id))}</option>`).join("");
  sel.value = ids.includes(heatModel) ? heatModel : "";
}

function drawHeat() {
  if (!heatData) return;
  const M = HEAT[heatMetric], val = (c) => c[heatMetric];
  const accent = `var(${M.color})`;
  $("heatTitle").textContent = M.title;
  const byHour = Array(24).fill(0);
  let max = 0, total = 0;
  for (const d of heatData.days) d.hours.forEach((c, h) => { const v = val(c); byHour[h] += v; total += v; max = Math.max(max, v); });
  const hmax = Math.max(...byHour) || 1;
  $("heatTotal").textContent = M.total(total);
  const hh = (i) => String(i).padStart(2, "0");
  // sqrt keeps quiet hours visible next to one huge hour
  const shade = (v) => v > 0 && max > 0 ? `color-mix(in srgb, ${accent} ${Math.round(18 + 82 * Math.sqrt(v / max))}%, var(--cell))` : "var(--cell)";
  let h = `<div></div>` + byHour.map((v, i) =>
    `<div class="bar" title="${hh(i)}:00 · ${esc(M.fmt(v))}"><div style="height:${Math.max(3, 100 * v / hmax)}%;opacity:${v ? 1 : .25}"></div></div>`).join("");
  h += `<div></div>` + byHour.map((_, i) => `<div class="hr">${i % 3 === 0 ? hh(i) : ""}</div>`).join("");
  for (const d of heatData.days) {
    h += `<div class="lab">${d.date}</div>` + d.hours.map((c, i) =>
      `<div class="cell" style="background:${shade(val(c))}" title="${d.date} ${hh(i)}:00 · ${esc(M.fmt(val(c)))}"></div>`).join("");
  }
  const el = $("heat");
  el.style.setProperty("--accent", accent);
  el.innerHTML = h;
}

function pick(id, attr, set) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    for (const x of $(id).children) x.classList.toggle("on", x === b);
    set(b.dataset[attr]);
  });
}
pick("heatMetric", "m", (m) => { heatMetric = m; drawHeat(); });
pick("heatDays", "d", (d) => { heatDays = Number(d); safe(refreshHeat); });
$("heatModel").addEventListener("change", (e) => { heatModel = e.target.value; safe(refreshHeat); });

// ---------- theme: auto (follows the system) -> light -> dark ----------

const THEMES = ["auto", "light", "dark"];
let theme = "auto";
try { theme = localStorage.getItem("wattllama-theme") || "auto"; } catch {}
const themeParam = new URLSearchParams(location.search).get("theme");   // ?theme=light|dark
if (THEMES.includes(themeParam)) theme = themeParam;
function applyTheme() {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  $("theme").textContent = theme === "auto" ? "◐ auto" : theme === "light" ? "☀ light" : "☾ dark";
  drawAll(); drawHeat();
}
$("theme").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { localStorage.setItem("wattllama-theme", theme); } catch {}
  applyTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawAll(); drawHeat(); });

// Poll only while the tab is visible, so a background tab costs nothing.
const safe = (f) => f().catch(() => {});
async function fast() { if (!document.hidden) await safe(refreshLive); setTimeout(fast, 2000); }
async function slow() {
  if (!document.hidden) { await safe(refreshSummary); await safe(refreshSeries); await safe(refreshRuns); await safe(refreshHeat); await safe(refreshEfficiency); await safe(refreshShare); await safe(refreshReport); await safe(refreshAlerts); await safe(refreshRequests); }
  setTimeout(slow, 30000);
}
async function slowest() { if (!document.hidden) await safe(refreshSetup); setTimeout(slowest, 60000); }
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { safe(refreshLive); safe(refreshSummary).then(() => safe(refreshSeries)); safe(refreshRuns); safe(refreshSetup); safe(refreshHeat); }
});
applyTheme(); fast(); slow(); slowest();
