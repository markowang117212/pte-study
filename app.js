/* PTE Study App — MVP. Vanilla JS, data from bank.js, progress in localStorage. */
"use strict";
const BANK = window.PTE_BANK || { items: [], type_specs: {}, contrib_matrix: {}, targets: {}, safe_targets: {} };
const LSP = "pte:local:";

/* ---------------- storage ---------------- */
function lsGet(k, dflt) { try { const v = localStorage.getItem(LSP + k); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
function lsSet(k, v) { localStorage.setItem(LSP + k, JSON.stringify(v)); }
let ATTEMPTS = lsGet("attempts", []);
let SRS = lsGet("srs", {});
let CFG = Object.assign({ ttsVoice: "", ttsRate: 1.0, examDate: "", calib: null }, lsGet("cfg", {}));
let CUSTOM = lsGet("customBank", []);
let VSRS = lsGet("vsrs", {});
let HARVEST = lsGet("harvestVocab", []);
function saveAttempts() { if (ATTEMPTS.length > 3000) ATTEMPTS = ATTEMPTS.slice(-3000); lsSet("attempts", ATTEMPTS); }

/* ---------------- utils ---------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function toks(s) { return (String(s || "").match(/[A-Za-z0-9']+/g) || []).map(w => w.toLowerCase()); }
function wc(s) { return toks(s).length; }
function todayStr(d) { const x = d || new Date(); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function lcsLen(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) { const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur; }
  return prev[n];
}
function fmtTime(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

/* ---------------- timers (single registry) ---------------- */
const TIMERS = [];
function later(fn, ms) { const h = setTimeout(fn, ms); TIMERS.push(h); return h; }
function every(fn, ms) { const h = setInterval(fn, ms); TIMERS.push(h); return h; }
function clearTimers() { while (TIMERS.length) { const h = TIMERS.pop(); clearTimeout(h); clearInterval(h); } }

/* ---------------- TTS ---------------- */
let VOICES = [];
function refreshVoices() { VOICES = window.speechSynthesis ? speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)) : []; }
if (window.speechSynthesis) { refreshVoices(); speechSynthesis.onvoiceschanged = refreshVoices; }
function pickVoice(name) { if (name) { const v = VOICES.find(v => v.name === name); if (v) return v; }
  return VOICES.find(v => /en[-_]AU/i.test(v.lang)) || VOICES.find(v => /en[-_]GB/i.test(v.lang)) || VOICES[0] || null; }
function speak(text, opts, onend) {
  opts = opts || {};
  if (!window.speechSynthesis) { if (onend) later(onend, 500); return; }
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(opts.voiceName || CFG.ttsVoice); if (v) u.voice = v;
  u.rate = opts.rate || CFG.ttsRate || 1; u.lang = (v && v.lang) || "en-AU";
  let done = false; const fin = () => { if (!done) { done = true; if (onend) onend(); } };
  u.onend = fin; u.onerror = fin;
  speechSynthesis.speak(u);
  later(() => { if (!speechSynthesis.speaking && !done) fin(); }, Math.max(3000, text.length * 120));
}
function stopSpeak() { if (window.speechSynthesis) speechSynthesis.cancel(); }
function beep(onend) {
  try { const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.12; o.connect(g); g.connect(ctx.destination);
    o.start(); later(() => { o.stop(); if (onend) onend(); }, 350);
  } catch (e) { if (onend) later(onend, 350); }
}

/* ---------------- recorder + ASR ---------------- */
const REC = { media: null, rec: null, chunks: [], url: null, asr: null, transcript: "", startTs: 0, active: false };
async function startRecording() {
  REC.transcript = ""; REC.chunks = []; REC.url = null; REC.startTs = Date.now(); REC.active = true;
  try {
    if (!REC.media) REC.media = await navigator.mediaDevices.getUserMedia({ audio: true });
    REC.rec = new MediaRecorder(REC.media);
    REC.rec.ondataavailable = e => { if (e.data.size) REC.chunks.push(e.data); };
    REC.rec.start();
  } catch (e) { REC.rec = null; }
  try {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) { const r = new SR(); r.lang = "en-AU"; r.continuous = true; r.interimResults = false;
      r.onresult = ev => { for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) REC.transcript += " " + ev.results[i][0].transcript; };
      r.onerror = () => {}; r.start(); REC.asr = r; }
  } catch (e) { REC.asr = null; }
}
function stopRecording(cb) {
  if (!REC.active) { if (cb) cb(); return; }
  REC.active = false;
  const durMs = Date.now() - REC.startTs;
  const hadAsr = !!REC.asr;
  let pending = 0, fired = false;
  const fin = () => { if (!fired) { fired = true; REC.durMs = durMs; if (cb) later(cb, hadAsr ? 600 : 0); } };
  if (REC.rec && REC.rec.state !== "inactive") { pending++; REC.rec.onstop = () => { try { REC.url = URL.createObjectURL(new Blob(REC.chunks, { type: "audio/webm" })); } catch (e) {} fin(); }; try { REC.rec.stop(); } catch (e) { fin(); } }
  if (REC.asr) { try { REC.asr.stop(); } catch (e) {} REC.asr = null; }
  if (!pending) fin();
}

/* ---------------- bank access ---------------- */
function allItems() { return BANK.items.concat(CUSTOM); }
function itemsOf(type) { return allItems().filter(it => it.type === type); }
function attemptsOf(type) { return ATTEMPTS.filter(a => a.type === type); }
function attemptCount(itemId) { return ATTEMPTS.reduce((n, a) => n + (a.itemId === itemId ? 1 : 0), 0); }
function pickItem(type, notId) {
  const pool = itemsOf(type); if (!pool.length) return null;
  const scored = pool.map(it => ({ it, k: attemptCount(it.id) * 10 + Math.random() * (2 - (it.freq_weight || 0.5)) }));
  scored.sort((a, b) => a.k - b.k);
  let cand = scored[0].it;
  if (notId && cand.id === notId && scored.length > 1) cand = scored[1].it;
  return cand;
}

/* ---------------- scoring ---------------- */
function scoreWFD(ref, resp) {
  const rt = toks(ref), ut = toks(resp); const used = new Array(ut.length).fill(false);
  let hit = 0; const marks = rt.map(t => { const j = ut.findIndex((u, i) => !used[i] && u === t); if (j >= 0) { used[j] = true; hit++; return true; } return false; });
  return { raw: hit, max: rt.length, marks };
}
function scoreFIB(perBlank, resp) { let raw = 0; const marks = perBlank.map((w, i) => { const ok = String(resp[i] || "").trim().toLowerCase() === w.toLowerCase(); if (ok) raw++; return ok; }); return { raw, max: perBlank.length, marks }; }
function scoreRO(order, arrangement) { // arrangement = display indices in user order
  let raw = 0; for (let i = 0; i + 1 < order.length; i++) { const a = arrangement.indexOf(order[i]), b = arrangement.indexOf(order[i + 1]); if (a >= 0 && b === a + 1) raw++; }
  return { raw, max: order.length - 1 };
}
function scoreMCM(keys, sel, nOpts) { let c = 0, w = 0; sel.forEach(i => keys.includes(i) ? c++ : w++); return { raw: Math.max(0, c - w), max: keys.length }; }
function scoreHIW(wrongIdx, marked) { let c = 0, w = 0; marked.forEach(i => wrongIdx.includes(i) ? c++ : w++); return { raw: Math.max(0, c - w), max: wrongIdx.length }; }
function contentRatio(ref, resp) { const a = toks(ref), b = toks(resp); if (!a.length) return 0; return lcsLen(a, b) / a.length; }
function keywordCoverage(keywords, resp) {
  const t = new Set(toks(resp)); let hit = 0;
  keywords.forEach(k => { const ks = toks(k); if (ks.some(w => t.has(w) && w.length > 3) || ks.every(w => t.has(w))) hit++; });
  return { hit, total: keywords.length };
}

/* ---------------- attempts & SRS ---------------- */
function recordAttempt(item, raw, max, extra) {
  const a = Object.assign({ itemId: item.id, type: item.type, ts: Date.now(), raw, max }, extra || {});
  ATTEMPTS.push(a); saveAttempts();
  if ((item.type === "write_from_dictation" || item.type === "repeat_sentence") && max > 0 && raw / max < 0.8) srsAdd(item.id);
  renderStreak();
  return a;
}
function srsAdd(id) { if (!SRS[id]) { SRS[id] = { ease: 2.5, interval: 0, due: todayStr(), reps: 0, lapses: 0 }; lsSet("srs", SRS); } }
function srsGrade(id, q) { // q: 0 again, 3 hard, 4 good, 5 easy
  const c = SRS[id] || { ease: 2.5, interval: 0, due: todayStr(), reps: 0, lapses: 0 };
  if (q === 0) { c.reps = 0; c.lapses++; c.interval = 1; c.ease = Math.max(1.3, c.ease - 0.2); }
  else { c.reps++; c.ease = Math.max(1.3, c.ease + (q === 5 ? 0.1 : q === 3 ? -0.15 : 0));
    c.interval = c.reps === 1 ? 1 : c.reps === 2 ? 3 : Math.round(c.interval * c.ease); }
  const d = new Date(); d.setDate(d.getDate() + c.interval); c.due = todayStr(d);
  SRS[id] = c; lsSet("srs", SRS);
}
function srsDue() { const t = todayStr(); return Object.keys(SRS).filter(id => SRS[id].due <= t && allItems().some(it => it.id === id)); }

/* ---------------- vocab deck (定向词卡：FIB 搭配 + 拼写高危词) ---------------- */
function allVocab() { return (BANK.vocab || []).concat(HARVEST); }
function vNewToday() { const d = lsGet("vnew", {}); return d.date === todayStr() ? d.count : 0; }
function vBumpNew() { lsSet("vnew", { date: todayStr(), count: vNewToday() + 1 }); }
function vocabDue() {
  const t = todayStr(); const due = [], fresh = [];
  allVocab().forEach(c => { const s = VSRS[c.id]; if (s) { if (s.due <= t) due.push(c); } else fresh.push(c); });
  const allowance = Math.max(0, (CFG.vNewLimit || 15) - vNewToday()); // 每日新卡上限（设置页可调）
  const lv = c => c.id.startsWith("VH-") ? 0 : (10 + (c.level || 2)); // 错词收录优先，其后按词表等级
  fresh.sort((a, b) => lv(a) - lv(b));
  return due.concat(fresh.slice(0, allowance));
}
function vGrade(id, q) {
  const isNew = !VSRS[id];
  const c = VSRS[id] || { ease: 2.5, interval: 0, due: todayStr(), reps: 0, lapses: 0 };
  if (q === 0) { c.reps = 0; c.lapses++; c.interval = 1; c.ease = Math.max(1.3, c.ease - 0.2); }
  else { c.reps++; c.ease = Math.max(1.3, c.ease + (q === 5 ? 0.1 : q === 3 ? -0.15 : 0));
    c.interval = c.reps === 1 ? 1 : c.reps === 2 ? 3 : Math.round(c.interval * c.ease); }
  const d = new Date(); d.setDate(d.getDate() + c.interval); c.due = todayStr(d);
  VSRS[id] = c; lsSet("vsrs", VSRS); if (isNew) vBumpNew();
}
function harvestColloc(sentence, answer) {
  const key = answer.toLowerCase() + "|" + sentence.slice(0, 40);
  if (HARVEST.some(h => h.kind === "colloc" && (h.answer.toLowerCase() + "|" + h.sentence.slice(0, 40)) === key)) return;
  HARVEST.push({ id: "VH-" + Date.now() + "-" + Math.floor(Math.random() * 1000), kind: "colloc", sentence, answer, cn: "（FIB 错题自动收录）" });
  lsSet("harvestVocab", HARVEST);
}
function harvestSpell(word, example) {
  const w = String(word || "").toLowerCase().replace(/[^a-z']/g, ""); if (w.length < 4) return;
  if (HARVEST.some(h => h.kind === "spell" && h.word.toLowerCase() === w)) return;
  if ((BANK.vocab || []).some(h => h.kind === "spell" && h.word.toLowerCase() === w)) return;
  HARVEST.push({ id: "VH-" + Date.now() + "-" + Math.floor(Math.random() * 1000), kind: "spell", word: w, cn: "（听写错词自动收录）", example: example || "" });
  lsSet("harvestVocab", HARVEST);
}
function harvestFromFib(item, per, marks, asSpell) {
  per.forEach((w, i) => {
    if (marks[i]) return;
    if (asSpell) { harvestSpell(w, item.prompt.tts || ""); return; }
    let s = item.prompt.text;
    per.forEach((ww, j) => { s = s.replace("{" + j + "}", j === i ? "___" : ww); });
    const at = s.indexOf("___");
    if (s.length > 150) s = "…" + s.slice(Math.max(0, at - 60), Math.min(s.length, at + 80)) + "…";
    harvestColloc(s, w);
  });
}

/* ---------------- estimator ---------------- */
function typeAccuracy(type) {
  const arr = attemptsOf(type).slice(-10); if (!arr.length) return null;
  let num = 0, den = 0, w = 1;
  for (let i = arr.length - 1; i >= 0; i--) { const acc = arr[i].max ? arr[i].raw / arr[i].max : 0; num += acc * w; den += w; w *= 0.85; }
  return num / den;
}
function skillEstimates() {
  const skills = { speaking: null, listening: null, reading: null, writing: null };
  Object.keys(skills).forEach(sk => {
    let num = 0, den = 0;
    Object.keys(BANK.contrib_matrix).forEach(type => {
      const wgt = BANK.contrib_matrix[type][sk]; if (!wgt) return;
      const acc = typeAccuracy(type); if (acc == null) return;
      num += (10 + 80 * acc) * wgt; den += wgt;
    });
    skills[sk] = den > 0.15 ? num / den : null;
  });
  if (CFG.calib && CFG.calib.offsets) Object.keys(skills).forEach(sk => { if (skills[sk] != null && CFG.calib.offsets[sk] != null) skills[sk] += CFG.calib.offsets[sk]; });
  Object.keys(skills).forEach(sk => { if (skills[sk] != null) skills[sk] = Math.max(10, Math.min(90, skills[sk])); });
  const vals = Object.values(skills).filter(v => v != null);
  const overall = vals.length === 4 ? vals.reduce((a, b) => a + b, 0) / 4 : null;
  return { skills, overall };
}

/* ---------------- streak ---------------- */
function renderStreak() {
  const days = new Set(ATTEMPTS.map(a => todayStr(new Date(a.ts))));
  let n = 0; const d = new Date();
  while (days.has(todayStr(d))) { n++; d.setDate(d.getDate() - 1); }
  const today = ATTEMPTS.filter(a => todayStr(new Date(a.ts)) === todayStr()).length;
  $("#streak").textContent = `今日 ${today} 题 · 连续 ${n} 天`;
}

/* ---------------- router ---------------- */
const APP = $("#app");
window.addEventListener("hashchange", route);
function route() {
  clearTimers(); stopSpeak(); stopRecording();
  const h = location.hash || "#home";
  $all("#nav a").forEach(a => a.classList.toggle("active", a.getAttribute("href") === h.split("/")[0]));
  const [view, arg] = h.slice(1).split("/");
  if (view === "practice") viewPractice();
  else if (view === "player") viewPlayer(arg);
  else if (view === "memory") viewMemory();
  else if (view === "review") viewReview();
  else if (view === "vocab") viewVocab();
  else if (view === "learn") viewLearn();
  else if (view === "stats") viewStats();
  else if (view === "settings") viewSettings();
  else viewHome();
  window.scrollTo(0, 0);
}

/* ---------------- views ---------------- */
function skillBar(label, val, target, safe) {
  const pct = v => ((v - 10) / 80 * 100).toFixed(1) + "%";
  const shown = val == null ? "—" : Math.round(val);
  const cls = val == null ? "" : val >= safe ? "diffok" : val >= target ? "" : "diffbad";
  return `<div class="skillrow"><b>${label}</b>
    <div class="bar"><i style="width:${val == null ? 0 : pct(val)}"></i>
      <span class="target" style="left:${pct(target)}" title="目标 ${target}"></span>
      <span class="target" style="left:${pct(safe)};background:var(--warn)" title="安全 ${safe}"></span></div>
    <span class="${cls}">${shown} / ${target}</span></div>`;
}
function viewHome() {
  const est = skillEstimates(); const t = BANK.targets, s = BANK.safe_targets;
  const due = srsDue().length;
  const vdue = vocabDue().length;
  const t0 = Object.keys(BANK.type_specs).filter(k => BANK.type_specs[k].tier === 0);
  APP.innerHTML = `
  <div class="card"><h2>目标进度 <span class="muted small">（红线=OMARA 目标，橙线=安全目标）</span></h2>
    ${skillBar("Speaking", est.skills.speaking, t.speaking, s.speaking)}
    ${skillBar("Listening", est.skills.listening, t.listening, s.listening)}
    ${skillBar("Reading", est.skills.reading, t.reading, s.reading)}
    ${skillBar("Writing", est.skills.writing, t.writing, s.writing)}
    ${skillBar("Overall", est.overall, t.overall, s.overall)}
    <p class="muted small">预测分由练习正确率 × 贡献矩阵估算，完成官方 Scored Practice Test 后在设置页校准可显著提高准确度。数据不足时显示 —。</p>
  </div>
  <div class="card"><h2>今日建议（口语优先）</h2>
    <div class="flex">
      ${t0.map(k => `<button class="btn primary" onclick="location.hash='#player/${k}'">${BANK.type_specs[k].code} ${BANK.type_specs[k].name_cn}</button>`).join("")}
      <button class="btn" onclick="location.hash='#player/write_from_dictation'">WFD 听写</button>
      <button class="btn ${due ? "primary" : ""}" onclick="location.hash='#review'">SRS 复习（${due} 到期）</button>
      <button class="btn ${vdue ? "primary" : ""}" onclick="location.hash='#vocab'">背单词（${vdue}）</button>
    </div>
    <p class="muted small">标准套餐：跟读 15min → RA×8 → RS×20 → DI×2 → RTS×2 → WFD×20 → 阅读填空×3；写作隔日 WE/SWT 一篇。详见 docs/03 备考方案。</p>
  </div>
  <div class="card"><h2>快速入口</h2>
    <div class="flex">
      <button class="btn" onclick="location.hash='#practice'">全部题型</button>
      <button class="btn" onclick="location.hash='#learn'">方法卡与模板</button>
      <button class="btn" onclick="location.hash='#stats'">统计</button>
      <button class="btn" onclick="location.hash='#settings'">设置 / 校准 / 导入题库</button>
    </div>
  </div>`;
}
function viewPractice() {
  const tiers = [[0, "T0 每日必练"], [1, "T1 高频巩固"], [2, "T2 达标维护"], [3, "T3 快答不恋战"]];
  APP.innerHTML = tiers.map(([tier, label]) => {
    const types = Object.keys(BANK.type_specs).filter(k => BANK.type_specs[k].tier === tier);
    return `<div class="card"><h2><span class="tag t${tier}">${label}</span></h2><div class="grid cols3">` +
      types.map(k => { const sp = BANK.type_specs[k]; const n = itemsOf(k).length; const acc = typeAccuracy(k);
        return `<div class="card typecard" onclick="location.hash='#player/${k}'">
          <div class="code">${sp.code}</div><div>${sp.name_cn}</div>
          <div class="muted small">${n} 题 · ${acc == null ? "未练" : "近期 " + Math.round(acc * 100) + "%"}</div></div>`; }).join("") +
      `</div></div>`; }).join("");
}

/* ---------------- player ---------------- */
let CUR = null; // {item, spec, phase, answer state...}
function viewPlayer(typeKey, reviewCb, fixedItem) {
  const spec = BANK.type_specs[typeKey];
  if (!spec) { APP.innerHTML = "<div class='card'>未知题型</div>"; return; }
  const item = fixedItem || pickItem(typeKey, CUR && CUR.item && CUR.item.id);
  if (!item) { APP.innerHTML = "<div class='card'>该题型暂无题目，可在设置页导入。</div>"; return; }
  CUR = { item, spec, typeKey, reviewCb };
  startPhaseFlow();
}
function playerShell(phaseLabel, timerHtml, bodyHtml, controlsHtml) {
  APP.innerHTML = `<div class="card">
    <div class="flex spread">
      <div><span class="tag">${CUR.spec.code}</span><b>${CUR.spec.name_cn}</b> <span class="muted small">${CUR.item.id} · 难度${CUR.item.difficulty}</span></div>
      <div class="flex"><span class="phase">${phaseLabel}</span>${timerHtml}</div>
    </div>
    <div id="pbody">${bodyHtml}</div>
    <div class="flex" id="pctrl" style="margin-top:12px">${controlsHtml || ""}</div>
  </div>
  <div class="card small muted">提示：${esc(CUR.spec.tips)}</div>`;
}
function countdown(sec, onDone, label) {
  const el = () => $("#ptimer"); let left = sec;
  const draw = () => { if (el()) { el().textContent = fmtTime(left); el().classList.toggle("low", left <= 5); } };
  draw();
  every(() => { left--; draw(); if (left <= 0) { clearTimers(); onDone(); } }, 1000);
}
function timerSpan() { return `<span class="timer" id="ptimer">--</span>`; }

function stimulusHtml(mode) {
  const p = CUR.item.prompt || {};
  if (CUR.typeKey === "describe_image") return `<div class="stimulus">${p.image_svg}</div>`;
  if (CUR.typeKey === "read_aloud" || CUR.typeKey === "respond_to_situation") return `<div class="stimulus">${esc(p.text)}</div>`;
  if (mode === "listening") return `<div class="stimulus muted">🎧 正在播放音频…（考试中不显示文本）</div>`;
  return "";
}

function startPhaseFlow() {
  const t = CUR.typeKey, spec = CUR.spec, p = CUR.item.prompt || {};
  clearTimers(); stopSpeak();
  const listenThen = (next) => {
    playerShell("Listening", timerSpan(), stimulusHtml("listening"), `<button class="btn" onclick="skipAudio()">跳过音频</button>`);
    $("#ptimer").textContent = "…";
    CUR.skip = () => { stopSpeak(); clearTimers(); next(); };
    speak(p.tts, {}, () => later(next, 300));
  };
  if (t === "read_aloud") prepPhase(spec.prep_s, () => answerRecord(spec.answer_s));
  else if (t === "describe_image") prepPhase(spec.prep_s, () => answerRecord(spec.answer_s));
  else if (t === "respond_to_situation") {
    playerShell("Listening", timerSpan(), stimulusHtml(), "");
    speak(p.tts || p.text, {}, () => prepPhase(spec.prep_s, () => answerRecord(spec.answer_s)));
  } else if (t === "repeat_sentence" || t === "answer_short_question") listenThen(() => beep(() => answerRecord(spec.answer_s)));
  else if (t === "retell_lecture") listenThen(() => prepPhase(spec.prep_s, () => answerRecord(spec.answer_s)));
  else if (t === "summarize_group_discussion") playDialogue(() => prepPhase(spec.prep_s, () => answerRecord(spec.answer_s)));
  else if (t === "summarize_spoken_text" || t === "write_from_dictation") listenThen(() => answerType(spec.answer_s));
  else if (t === "summarize_written_text" || t === "write_essay") answerType(spec.answer_s);
  else if (t === "fib_reading_writing") answerDropdown(spec.answer_s);
  else if (t === "fib_reading") answerWordbank(spec.answer_s);
  else if (t === "reorder_paragraphs") answerOrder(spec.answer_s);
  else if (t === "fib_listening") answerFibListening();
  else if (t === "highlight_incorrect_words") answerHIW();
  else if (t === "select_missing_word") listenThen(() => beep(() => answerSelect(spec.answer_s)));
  else if (["mc_single_reading", "mc_multiple_reading"].includes(t)) answerSelect(spec.answer_s);
  else listenThen(() => answerSelect(spec.answer_s)); // mc listening + HCS
}
window.skipAudio = function () { if (CUR && CUR.skip) CUR.skip(); };

function prepPhase(sec, next) {
  playerShell("Prepare 准备", timerSpan(), stimulusHtml(), `<button class="btn primary" onclick="prepDone()">提前开始</button>`);
  CUR.prepNext = () => { clearTimers(); beep(next); };
  countdown(sec, CUR.prepNext);
}
window.prepDone = function () { if (CUR && CUR.prepNext) CUR.prepNext(); };

function answerRecord(sec) {
  playerShell("Recording 录音", timerSpan(), stimulusHtml() + `<div><span class="rec-dot"></span>录音中… 保持连贯，错了不回头。</div>`, `<button class="btn primary" onclick="finishRecord()">完成录音</button>`);
  startRecording();
  CUR.finish = () => { clearTimers(); stopRecording(() => reviewSpeaking()); };
  countdown(sec, CUR.finish);
}
window.finishRecord = function () { if (CUR && CUR.finish) CUR.finish(); };

function playDialogue(next) {
  const dlg = CUR.item.prompt.dialogue || [];
  playerShell("Listening 三人讨论", timerSpan(), `<div id="dlgbox" class="stimulus muted">🎧 讨论进行中…</div>`, `<button class="btn" onclick="skipAudio()">跳过音频</button>`);
  let i = 0; const enVoices = VOICES.length ? VOICES : [null];
  CUR.skip = () => { stopSpeak(); clearTimers(); next(); };
  const playNext = () => {
    if (i >= dlg.length) { next(); return; }
    const turn = dlg[i];
    const box = $("#dlgbox"); if (box) box.innerHTML = `<div class="speaker-label">${esc(turn.speaker)}：</div><div class="muted">…</div>`;
    const vIdx = ["F1", "M1", "F2"].indexOf((CUR.item.prompt.tts_voices || [])[i % 3]) >= 0 ? i % 3 : i % 3;
    const voice = enVoices[vIdx % enVoices.length];
    speak(turn.text, { voiceName: voice && voice.name }, () => { i++; later(playNext, 250); });
  };
  playNext();
}

function answerType(sec) {
  const t = CUR.typeKey; const p = CUR.item.prompt || {};
  let above = "";
  if (t === "summarize_written_text") above = `<div class="stimulus">${esc(p.text)}</div><hr>`;
  if (t === "write_essay") above = `<div class="stimulus"><b>${esc(p.text)}</b></div><hr>`;
  const limits = { summarize_written_text: "一句话 · 5–75 词（目标 40–60）", write_essay: "200–300 词（目标 210–240）", summarize_spoken_text: "50–70 词（目标 55–65）", write_from_dictation: "逐词听写" };
  playerShell("Answer 作答", timerSpan(),
    `${above}<textarea id="resp" placeholder="在此输入…" spellcheck="false"></textarea>
     <div class="small muted"><span id="wcount">0</span> 词 · ${limits[t] || ""}</div>`,
    `<button class="btn primary" onclick="submitTyped()">提交</button>` + (t === "write_from_dictation" ? ` <button class="btn" onclick="replayOnce()">再听一遍(练习)</button>` : ""));
  $("#resp").addEventListener("input", () => { $("#wcount").textContent = wc($("#resp").value); });
  $("#resp").focus();
  CUR.finish = () => { clearTimers(); submitTypedInner(); };
  countdown(sec, CUR.finish);
}
window.replayOnce = function () { speak(CUR.item.prompt.tts, {}, null); };
window.submitTyped = function () { if (CUR && CUR.finish) CUR.finish(); };
function submitTypedInner() {
  const resp = ($("#resp") && $("#resp").value) || "";
  const t = CUR.typeKey, ak = CUR.item.answer_key || {};
  if (t === "write_from_dictation") {
    const r = scoreWFD(ak.exact, resp);
    const rt = (ak.exact.match(/\S+/g) || []);
    const diff = rt.map((w, i) => `<span class="${r.marks[i] ? "diffok" : "diffbad"}">${esc(w)}</span>`).join(" ");
    rt.forEach((w, i) => { if (!r.marks[i]) harvestSpell(w, ak.exact); });
    recordAttempt(CUR.item, r.raw, r.max, { resp });
    reviewShell(`${r.raw} / ${r.max}`, `<h3>原句</h3><div class="stimulus">${diff}</div><h3>你的作答</h3><div class="stimulus">${esc(resp) || "<i class='muted'>（空）</i>"}</div>`, r.raw / r.max);
    return;
  }
  reviewWriting(resp);
}

function answerSelect(sec) {
  const p = CUR.item.prompt || {}; const multi = /multiple/.test(CUR.typeKey);
  const showText = /reading/.test(CUR.typeKey) && p.text;
  playerShell("Answer 作答", timerSpan(),
    `${showText ? `<div class="stimulus">${esc(p.text)}</div><hr>` : ""}
     ${p.question ? `<p><b>${esc(p.question)}</b></p>` : "<p><b>选择正确的" + (CUR.typeKey === "highlight_correct_summary" ? "摘要" : "选项") + "：</b></p>"}
     <div id="opts">${(p.options || []).map((o, i) => `<label class="opt" data-i="${i}"><input type="${multi ? "checkbox" : "radio"}" name="mc" style="margin-top:3px"> <span>${esc(o)}</span></label>`).join("")}</div>`,
    `<button class="btn primary" onclick="submitSelect()">提交</button>`);
  $all("#opts .opt").forEach(el => el.addEventListener("click", () => later(() => $all("#opts .opt").forEach(o => o.classList.toggle("sel", o.querySelector("input").checked)), 10)));
  CUR.finish = () => { clearTimers(); submitSelectInner(); };
  countdown(sec, CUR.finish);
}
window.submitSelect = function () { if (CUR && CUR.finish) CUR.finish(); };
function submitSelectInner() {
  const keys = (CUR.item.answer_key || {}).keys || [];
  const sel = $all("#opts .opt").filter(el => el.querySelector("input").checked).map(el => +el.dataset.i);
  const multi = /multiple/.test(CUR.typeKey);
  const r = multi ? scoreMCM(keys, sel) : { raw: sel.length && keys.includes(sel[0]) ? 1 : 0, max: 1 };
  $all("#opts .opt").forEach(el => { const i = +el.dataset.i;
    if (keys.includes(i)) el.classList.add("correct"); else if (sel.includes(i)) el.classList.add("wrong"); });
  recordAttempt(CUR.item, r.raw, r.max, { sel });
  reviewShell(`${r.raw} / ${r.max}`, $("#pbody").innerHTML, r.raw / r.max);
}

function answerDropdown(sec) {
  const p = CUR.item.prompt; let idx = 0;
  const html = esc(p.text).replace(/\{(\d+)\}/g, (m, g) => {
    const b = p.blanks[+g];
    return `<select data-b="${g}"><option value="">——</option>${b.options.map(o => `<option>${esc(o)}</option>`).join("")}</select>`;
  });
  playerShell("Answer 作答", timerSpan(), `<div class="stimulus">${html}</div>`, `<button class="btn primary" onclick="submitBlanks()">提交</button>`);
  CUR.finish = () => { clearTimers(); submitBlanksInner(); };
  countdown(sec, CUR.finish);
}
function answerWordbank(sec) {
  const p = CUR.item.prompt;
  const html = esc(p.text).replace(/\{(\d+)\}/g, (m, g) => `<span class="blankslot" data-b="${g}">&nbsp;</span>`);
  playerShell("Answer 作答", timerSpan(),
    `<div class="stimulus">${html}</div><hr><div id="bank">${shuffle(p.word_bank).map(w => `<span class="bankword">${esc(w)}</span>`).join("")}</div>
     <p class="small muted">点击空格选中（蓝色高亮），再点词库词填入；点击已填空格可清空。</p>`,
    `<button class="btn primary" onclick="submitBlanks()">提交</button>`);
  let active = null;
  const slots = $all(".blankslot");
  const setActive = s => { slots.forEach(x => x.classList.remove("active")); active = s; if (s) s.classList.add("active"); };
  setActive(slots[0]);
  slots.forEach(s => s.addEventListener("click", () => {
    if (s.dataset.word) { const w = s.dataset.word; delete s.dataset.word; s.innerHTML = "&nbsp;";
      const bw = $all("#bank .bankword").find(b => b.textContent === w && b.classList.contains("used")); if (bw) bw.classList.remove("used"); }
    setActive(s);
  }));
  $all("#bank .bankword").forEach(b => b.addEventListener("click", () => {
    if (!active || b.classList.contains("used")) return;
    if (active.dataset.word) { const old = active.dataset.word; const ob = $all("#bank .bankword").find(x => x.textContent === old && x.classList.contains("used")); if (ob) ob.classList.remove("used"); }
    active.dataset.word = b.textContent; active.textContent = b.textContent; b.classList.add("used");
    const nxt = slots.find(s => !s.dataset.word); setActive(nxt || null);
  }));
  CUR.finish = () => { clearTimers(); submitBlanksInner(); };
  countdown(sec, CUR.finish);
}
window.submitBlanks = function () { if (CUR && CUR.finish) CUR.finish(); };
function submitBlanksInner() {
  const ak = CUR.item.answer_key; const per = ak.per_blank;
  let resp;
  if (CUR.typeKey === "fib_reading_writing") resp = $all("select[data-b]").map(s => s.value);
  else resp = $all(".blankslot").map(s => s.dataset.word || "");
  const r = scoreFIB(per, resp);
  const detail = per.map((w, i) => `<div>${i + 1}. ${r.marks[i] ? `<span class="diffok">${esc(resp[i])}</span>` : `<span class="diffbad">${esc(resp[i] || "（空）")}</span> → <b>${esc(w)}</b>`}</div>`).join("");
  harvestFromFib(CUR.item, per, r.marks, false);
  recordAttempt(CUR.item, r.raw, r.max, { resp });
  reviewShell(`${r.raw} / ${r.max}`, detail, r.raw / r.max);
}
function answerFibListening() {
  const p = CUR.item.prompt; const spec = CUR.spec;
  const html = esc(p.text).replace(/\{(\d+)\}/g, (m, g) => `<input type="text" data-b="${g}" style="width:120px" autocomplete="off">`);
  playerShell("Listen & Type 边听边打", timerSpan(), `<div class="stimulus">${html}</div>`, `<button class="btn primary" onclick="submitBlanks()">提交</button>`);
  $("#ptimer").textContent = "🎧";
  CUR.finish = () => { clearTimers(); stopSpeak();
    const resp = $all("input[data-b]").map(i => i.value);
    const r = scoreFIB(CUR.item.answer_key.per_blank, resp);
    const detail = CUR.item.answer_key.per_blank.map((w, i) => `<div>${i + 1}. ${r.marks[i] ? `<span class="diffok">${esc(resp[i])}</span>` : `<span class="diffbad">${esc(resp[i] || "（空）")}</span> → <b>${esc(w)}</b>`}</div>`).join("");
    harvestFromFib(CUR.item, CUR.item.answer_key.per_blank, r.marks, true);
    recordAttempt(CUR.item, r.raw, r.max, { resp });
    reviewShell(`${r.raw} / ${r.max}`, detail + `<h3>原文</h3><div class="stimulus small">${esc(p.tts)}</div>`, r.raw / r.max); };
  later(() => speak(p.tts, {}, () => countdown(spec.answer_s, CUR.finish)), spec.prep_s * 1000);
}
function answerOrder(sec) {
  const p = CUR.item.prompt;
  const rows = p.paragraphs.map((txt, i) => ({ i, txt }));
  const draw = () => {
    $("#pbody").innerHTML = rows.map((r, pos) => `<div class="para"><div class="mv">
      <button onclick="moveRow(${pos},-1)">▲</button><button onclick="moveRow(${pos},1)">▼</button></div><div>${esc(r.txt)}</div></div>`).join("");
  };
  playerShell("Answer 排序（▲▼调整顺序）", timerSpan(), "", `<button class="btn primary" onclick="submitOrder()">提交</button>`);
  CUR.rows = rows; CUR.drawOrder = draw; draw();
  CUR.finish = () => { clearTimers();
    const arrangement = CUR.rows.map(r => r.i);
    const r = scoreRO(CUR.item.answer_key.order, arrangement);
    const correct = CUR.item.answer_key.order.map(ix => `<div class="para"><div>${esc(p.paragraphs[ix])}</div></div>`).join("");
    recordAttempt(CUR.item, r.raw, r.max, { arrangement });
    reviewShell(`${r.raw} / ${r.max} 相邻对`, `<h3>正确顺序</h3>${correct}`, r.max ? r.raw / r.max : 0); };
  countdown(sec, CUR.finish);
}
window.moveRow = function (pos, d) { const r = CUR.rows; const j = pos + d; if (j < 0 || j >= r.length) return; [r[pos], r[j]] = [r[j], r[pos]]; CUR.drawOrder(); };
window.submitOrder = function () { if (CUR && CUR.finish) CUR.finish(); };
function answerHIW() {
  const p = CUR.item.prompt; const spec = CUR.spec;
  const wordsArr = p.text.split(/\s+/);
  const html = wordsArr.map((w, i) => `<span class="word" data-i="${i}">${esc(w)}</span>`).join(" ");
  playerShell("Listen & Click 点错词", timerSpan(), `<div class="stimulus">${html}</div>`, `<button class="btn primary" onclick="submitHIW()">提交</button>`);
  $("#ptimer").textContent = "🎧";
  $all(".word").forEach(el => el.addEventListener("click", () => el.classList.toggle("mark")));
  CUR.finish = () => { clearTimers(); stopSpeak();
    const marked = $all(".word.mark").map(el => +el.dataset.i);
    const wrongIdx = (CUR.item.answer_key.wrong || []).map(w => w.i);
    const r = scoreHIW(wrongIdx, marked);
    $all(".word").forEach(el => { const i = +el.dataset.i; el.classList.remove("mark");
      if (wrongIdx.includes(i)) el.classList.add(marked.includes(i) ? "hit" : "shouldhave");
      else if (marked.includes(i)) el.classList.add("miss"); });
    const fixes = (CUR.item.answer_key.wrong || []).map(w => `<span class="small">${esc(w.shown)}→<b>${esc(w.correct)}</b></span>`).join(" · ");
    recordAttempt(CUR.item, r.raw, r.max, { marked });
    reviewShell(`${r.raw} / ${r.max}`, $("#pbody").innerHTML + `<p>${fixes}</p><p class="small muted">绿=命中 黄虚框=漏点 红=误点(倒扣)</p>`, r.max ? r.raw / r.max : 0); };
  later(() => speak(p.tts, {}, () => countdown(spec.answer_s, CUR.finish)), (spec.prep_s || 3) * 1000);
}
window.submitHIW = function () { if (CUR && CUR.finish) CUR.finish(); };

/* ---------------- speaking review ---------------- */
function sliderRow(id, label, val) {
  return `<div class="slider-row"><span>${label}</span><input type="range" id="${id}" min="0" max="5" step="1" value="${val}" oninput="$('#${id}v').textContent=this.value"><b id="${id}v">${val}</b></div>`;
}
function reviewSpeaking() {
  const t = CUR.typeKey, ak = CUR.item.answer_key || {}, p = CUR.item.prompt || {};
  const asr = (REC.transcript || "").trim();
  let autoHtml = "", contentPre = 3, maxDim = 5;
  if (t === "read_aloud" || t === "repeat_sentence") {
    const ratio = asr ? contentRatio(ak.exact, asr) : null;
    if (t === "repeat_sentence") contentPre = ratio == null ? 2 : ratio >= 0.85 ? 3 : ratio >= 0.5 ? 2 : ratio > 0.15 ? 1 : 0;
    else contentPre = ratio == null ? 3 : Math.round(ratio * 5);
    autoHtml = `<h3>参考文本</h3><div class="stimulus">${esc(ak.exact)}</div>` +
      (asr ? `<h3>识别到的语音</h3><div class="stimulus muted">${esc(asr)}</div><p>内容覆盖 ≈ <b>${Math.round((ratio || 0) * 100)}%</b></p>` : `<p class="muted small">（未获得语音识别结果——file:// 下需联网；可自行回放对照）</p>`);
  } else if (t === "answer_short_question") {
    const ok = asr && [ak.exact].concat(ak.accept || []).some(a => asr.toLowerCase().includes(String(a).toLowerCase().replace(/^(a|an|the)\s+/, "")));
    autoHtml = `<h3>参考答案</h3><div class="stimulus"><b>${esc(ak.exact)}</b> <span class="muted small">${(ak.accept || []).map(esc).join(" / ")}</span></div>` + (asr ? `<p>识别："${esc(asr)}" → ${ok ? "<span class='diffok'>命中</span>" : "<span class='diffbad'>未命中(可手动改判)</span>"}</p>` : "");
    contentPre = ok ? 5 : 0; maxDim = 5;
  } else {
    const kws = ak.keywords || [];
    const cov = asr ? keywordCoverage(kws, asr) : null;
    const pre = new Set();
    if (cov) kws.forEach((k, i) => { const ts = new Set(toks(asr)); const ks = toks(k); if (ks.some(w => ts.has(w) && w.length > 3) || ks.every(w => ts.has(w))) pre.add(i); });
    autoHtml = `<h3>内容要点（点击标记已覆盖）</h3><div id="kws">${kws.map((k, i) => `<span class="kwchip ${pre.has(i) ? "on" : ""}" data-i="${i}">${esc(k)}</span>`).join("")}</div>
      ${asr ? `<p class="muted small">已按语音识别预标注 ${pre.size}/${kws.length}</p>` : ""}
      <details style="margin-top:8px"><summary class="muted">参考答案</summary><div class="template">${esc(ak.model_answer || "")}</div></details>`;
  }
  const audio = REC.url ? `<p><audio controls src="${REC.url}"></audio></p>` : "";
  playerShell("Review 复盘", `<span class="scorebox" id="sc">—</span>`,
    audio + autoHtml + `<hr><h3>自评（对照 02 文档评分维度）</h3>
    ${sliderRow("dimC", "Content 内容", contentPre)}${sliderRow("dimP", "Pronunciation 发音", 3)}${sliderRow("dimF", "Fluency 流利度", 3)}
    <p class="small muted">流利度红线：无 >1s 停顿、无重启、语速 110–140wpm。录音时长 ${Math.round((REC.durMs || 0) / 1000)}s。</p>`,
    `<button class="btn primary" onclick="saveSpeaking()">保存成绩</button><button class="btn" onclick="nextItem()">跳过不计</button>`);
  $all("#kws .kwchip").forEach(el => el.addEventListener("click", () => el.classList.toggle("on")));
}
window.saveSpeaking = function () {
  const t = CUR.typeKey; const ak = CUR.item.answer_key || {};
  let c = +$("#dimC").value, p = +$("#dimP").value, f = +$("#dimF").value;
  if ($("#kws")) { const kwN = $all("#kws .kwchip").length, kwOn = $all("#kws .kwchip.on").length; if (kwN) c = Math.round(kwOn / kwN * 5); }
  const maxC = t === "repeat_sentence" ? 3 : 5;
  c = Math.min(c, maxC);
  const raw = c + p + f, max = maxC + 10;
  recordAttempt(CUR.item, raw, max, { dims: { c, p, f }, asr: (REC.transcript || "").slice(0, 400), durMs: REC.durMs || 0 });
  const acc = raw / max;
  $("#sc").textContent = Math.round(acc * 100) + "%";
  afterSave(acc);
};
function reviewWriting(resp) {
  const t = CUR.typeKey, ak = CUR.item.answer_key || {};
  const n = wc(resp);
  const sentences = (resp.trim().match(/[.!?]+(?=\s|$)/g) || []).length;
  let form = 1, formMsg = "";
  if (t === "summarize_written_text") { form = (n >= 5 && n <= 75 && sentences <= 1) ? 1 : 0; formMsg = `词数 ${n}（5–75）· 句数 ${Math.max(1, sentences)}（须为 1）→ Form ${form}/1`; }
  if (t === "write_essay") { form = n >= 200 && n <= 300 ? 2 : (n >= 120 && n <= 380 ? 1 : 0); formMsg = `词数 ${n}（200–300）→ Form ${form}/2`; }
  if (t === "summarize_spoken_text") { form = n >= 50 && n <= 70 ? 2 : (n >= 40 && n <= 100 ? 1 : 0); formMsg = `词数 ${n}（50–70）→ Form ${form}/2`; }
  const rubric = { summarize_written_text: "Content 0-2 / Grammar 0-2 / Vocabulary 0-2", write_essay: "Content 0-3 / Development 0-2 / Grammar 0-2 / Range 0-2 / Vocab 0-2 / Spelling 0-2", summarize_spoken_text: "Content 0-2 / Grammar 0-2 / Vocab 0-2 / Spelling 0-2" }[t];
  const prompt = `请作为 PTE Academic 评分员，按官方 rubric 给下面的作答打分（${rubric}，并给 3 条最优先的改进建议）。\n\n【题目】${(CUR.item.prompt.text || CUR.item.prompt.tts || "").slice(0, 1200)}\n\n【考生作答】${resp}`;
  CUR.pendingResp = resp; CUR.pendingForm = form;
  playerShell("Review 复盘", `<span class="scorebox" id="sc">—</span>`,
    `<p><b>${formMsg}</b></p>
     <h3>你的作答</h3><div class="stimulus" style="white-space:pre-wrap">${esc(resp) || "<i class='muted'>（空）</i>"}</div>
     ${ak.model_answer ? `<details><summary class="muted">参考答案</summary><div class="template" style="white-space:pre-wrap">${esc(ak.model_answer)}</div></details>` : ""}
     <hr>${sliderRow("dimC", "内容自评 0-5", 3)}
     <p class="small muted">深度批改：点下方按钮复制评分 Prompt，粘贴给 Claude 获取逐维度打分与修改建议。</p>`,
    `<button class="btn" onclick="copyPrompt()">复制 Claude 评分 Prompt</button>
     <button class="btn primary" onclick="saveWriting()">保存成绩</button><button class="btn" onclick="nextItem()">跳过不计</button>`);
  CUR.claudePrompt = prompt;
}
window.copyPrompt = function () { navigator.clipboard.writeText(CUR.claudePrompt).then(() => alert("已复制，粘贴给 Claude 即可获得批改。")); };
window.saveWriting = function () {
  const t = CUR.typeKey;
  const formMax = t === "summarize_written_text" ? 1 : 2;
  const c = +$("#dimC").value;
  const raw = CUR.pendingForm + c, max = formMax + 5;
  recordAttempt(CUR.item, raw, max, { resp: (CUR.pendingResp || "").slice(0, 2000) });
  afterSave(raw / max);
};
function reviewShell(scoreText, bodyHtml, acc) {
  playerShell("Review 复盘", `<span class="scorebox">${scoreText}</span>`, bodyHtml,
    `<button class="btn primary" onclick="nextItem()">下一题</button><button class="btn" onclick="location.hash='#practice'">返回题型</button>` +
    (CUR.reviewCb ? srsButtons() : ""));
  if (CUR.reviewCb) bindSrsButtons(acc);
}
function afterSave(acc) {
  const ctrl = $("#pctrl");
  ctrl.innerHTML = `<button class="btn primary" onclick="nextItem()">下一题</button><button class="btn" onclick="location.hash='#practice'">返回题型</button>` + (CUR.reviewCb ? srsButtons() : "");
  if (CUR.reviewCb) bindSrsButtons(acc);
}
window.nextItem = function () { if (CUR.reviewCb) { CUR.reviewCb(null); return; } viewPlayer(CUR.typeKey); };
function srsButtons() { return `<span style="margin-left:auto" class="flex"><span class="muted small">记忆评级：</span>
  <button class="btn" onclick="gradeCard(0)">重来</button><button class="btn" onclick="gradeCard(3)">困难</button>
  <button class="btn primary" onclick="gradeCard(4)">良好</button><button class="btn" onclick="gradeCard(5)">容易</button></span>`; }
function bindSrsButtons() {}
window.gradeCard = function (q) { srsGrade(CUR.item.id, q); if (CUR.reviewCb) CUR.reviewCb(q); };

/* ---------------- memory / review ---------------- */
function viewMemory() {
  const due = srsDue(); const all = Object.keys(SRS);
  const vdue = vocabDue().length;
  APP.innerHTML = `<div class="card"><h2>词汇卡（FIB 学术搭配 + 拼写高危词）</h2>
    <p>今日到期+新卡 <b>${vdue}</b> · 词库 ${allVocab().length}（内置 ${(BANK.vocab || []).length} + 错词收录 ${HARVEST.length}）· 每日新卡上限 ${CFG.vNewLimit || 15}</p>
    <div class="flex"><button class="btn primary" ${vdue ? "" : "disabled"} onclick="location.hash='#vocab'">开始背单词</button>
    ${HARVEST.length ? `<button class="btn" onclick="clearHarvest()">清空收录词</button>` : ""}</div>
    <p class="muted small">FIB 做错的空 → 自动生成搭配卡；WFD/听力填空拼错的词 → 自动生成拼写卡。</p>
    </div>
  <div class="card"><h2>错句库（WFD / RS 正确率 &lt;80% 自动收录，SM-2 间隔重复）</h2>
    <p>今日到期 <b>${due.length}</b> · 总卡片 ${all.length}</p>
    <button class="btn primary" ${due.length ? "" : "disabled"} onclick="location.hash='#review'">开始复习</button>
    </div>
    <div class="card"><h2>全部卡片</h2><table class="tbl"><tr><th>题目</th><th>下次到期</th><th>间隔</th><th>失误</th></tr>
    ${all.map(id => { const c = SRS[id]; const it = allItems().find(x => x.id === id); if (!it) return "";
      return `<tr><td>${id} <span class="muted small">${esc((it.prompt.tts || "").slice(0, 46))}…</span></td><td>${c.due}</td><td>${c.interval}d</td><td>${c.lapses}</td></tr>`; }).join("") || "<tr><td colspan=4 class='muted'>暂无卡片——WFD/RS 正确率低于 80% 时自动加入</td></tr>"}
    </table></div>`;
}
function viewReview() {
  const queue = srsDue();
  if (!queue.length) { APP.innerHTML = "<div class='card'><h2>今日复习完成 ✅</h2><button class='btn' onclick=\"location.hash='#memory'\">返回记忆库</button></div>"; return; }
  let i = 0;
  const next = () => {
    if (i >= queue.length) { APP.innerHTML = "<div class='card'><h2>今日复习完成 ✅</h2><button class='btn primary' onclick=\"location.hash='#home'\">回首页</button></div>"; return; }
    const it = allItems().find(x => x.id === queue[i]); i++;
    if (!it) { next(); return; }
    viewPlayer(it.type, () => next(), it);
  };
  next();
}

window.clearHarvest = function () { if (confirm("清空所有自动收录的错词卡？（内置词库保留）")) { HARVEST = []; lsSet("harvestVocab", HARVEST); viewMemory(); } };
function viewVocab() {
  const queue = shuffle(vocabDue()); let i = 0; const stats = { done: 0 };
  if (!queue.length) { APP.innerHTML = "<div class='card'><h2>今日词卡已清空 ✅</h2><button class='btn' onclick=\"location.hash='#memory'\">返回记忆库</button></div>"; return; }
  const next = () => {
    if (i >= queue.length) { APP.innerHTML = `<div class='card'><h2>词汇复习完成 ✅ 共 ${stats.done} 张</h2><button class='btn primary' onclick="location.hash='#home'">回首页</button></div>`; return; }
    renderCard(queue[i++]);
  };
  const gradeRow = () => `<div class="flex" style="margin-top:8px"><span class="muted small">记忆评级：</span>
        <button class="btn" data-q="0">重来</button><button class="btn" data-q="3">困难</button>
        <button class="btn primary" data-q="4">良好</button><button class="btn" data-q="5">容易</button></div>`;
  const bindGrade = (c) => { $all("#vres [data-q]").forEach(b => b.addEventListener("click", () => { vGrade(c.id, +b.dataset.q); stats.done++; next(); })); };
  const renderCard = (c) => {
    const kind = c.kind;
    const tagTxt = kind === "spell" ? "拼写" : kind === "word" ? "词义 L" + (c.level || 2) : "搭配";
    if (kind === "word") {
      APP.innerHTML = `<div class="card">
        <div class="flex spread"><div><span class="tag">${tagTxt}</span><span class="muted small">${c.id} · 剩余 ${queue.length - i + 1}</span></div></div>
        <div class="stimulus" style="margin-top:10px;font-size:28px;font-weight:800">${esc(c.word)} <button class="btn" id="vplay">🔊</button></div>
        <div class="flex"><button class="btn primary" id="vshow">显示释义</button></div>
        <div id="vres" style="margin-top:10px"></div></div>`;
      const play = () => speak(c.word, { rate: 0.95 }, null);
      $("#vplay").addEventListener("click", play); later(play, 300);
      $("#vshow").addEventListener("click", () => {
        $("#vres").innerHTML = `<p style="font-size:17px"><b>${esc(c.cn || "")}</b></p>${c.example ? `<p class="small muted">${esc(c.example)}</p>` : ""}${gradeRow()}`;
        bindGrade(c);
        if (c.example) speak(c.example, {}, null);
      });
      return;
    }
    const isSpell = kind === "spell";
    APP.innerHTML = `<div class="card">
      <div class="flex spread"><div><span class="tag">${tagTxt}</span><span class="muted small">${c.id} · 剩余 ${queue.length - i + 1}</span></div></div>
      <div class="stimulus" style="margin-top:10px">${isSpell ? `<button class="btn" id="vplay">🔊 播放</button> <span class="muted small">听音拼写（考试标准：拼错=0分）</span>` : esc(c.sentence).replace("___", "<b class='blankslot'>&nbsp;___&nbsp;</b>")}</div>
      <p class="muted">${esc(c.cn || "")}</p>
      <div class="flex"><input type="text" id="vin" style="flex:1" placeholder="输入${isSpell ? "单词" : "答案"}后回车" autocomplete="off">
      <button class="btn primary" id="vsub">检查</button><button class="btn" id="vshow">看答案</button></div>
      <div id="vres" style="margin-top:10px"></div></div>`;
    const answer = isSpell ? c.word : c.answer;
    if (isSpell) { const play = () => speak(c.word, { rate: 0.95 }, null); $("#vplay").addEventListener("click", play); later(play, 300); }
    const showResult = (ok) => {
      $("#vres").innerHTML = `<p>${ok ? "<span class='diffok'>✔ 正确</span>" : "<span class='diffbad'>✘</span>"} 答案：<b>${esc(answer)}</b></p>
        ${isSpell && c.example ? `<p class="small muted">${esc(c.example)}</p>` : ""}${gradeRow()}`;
      bindGrade(c);
    };
    const checkNow = () => { const v = ($("#vin").value || "").trim().toLowerCase(); showResult(v === answer.toLowerCase()); };
    $("#vsub").addEventListener("click", checkNow);
    $("#vin").addEventListener("keydown", e => { if (e.key === "Enter") checkNow(); });
    $("#vshow").addEventListener("click", () => showResult(false));
    $("#vin").focus();
  };
  next();
}

/* ---------------- learn ---------------- */
const TEMPLATES = [
  ["DI 骨架", "The [chart/graph/table/image] illustrates [主题]. The most striking feature is that [最大项+数值]. In contrast, [最小项+数值]. Meanwhile, [第二特征/趋势]. Overall, [一句结论]."],
  ["RL 骨架", "The lecture discussed [主题]. The speaker first pointed out that [要点1]. He/She then explained that [要点2]. Another key point was [要点3]. In conclusion, the speaker suggested that [结论]."],
  ["SGD 骨架", "The discussion was about [主题]. The first speaker argued that [A], while the second speaker pointed out that [B]. The third speaker suggested that [C]. In the end, they [agreed that… / could not agree on…]. Overall, [总括]."],
  ["RTS formal", "Good morning [称谓]. Thank you for [context]. I'm afraid [问题]. The reason is that [原因]. Would it be possible to [请求]? Alternatively, I could [替代方案]. I'd really appreciate your understanding."],
  ["RTS informal", "Hey [name], thanks so much for [context]. Unfortunately, [情况]. How about we [方案]? Or if that doesn't work, [替代]. Really sorry, and thanks for understanding!"],
  ["SWT 公式", "[主题句主干], which [支撑点1], while [支撑点2], and this suggests that [结论]. （单句 40–60 词）"],
  ["SST 模板", "The speaker discussed [主题]. He stated that [要点1]. Moreover, [要点2]. He also mentioned [细节]. In conclusion, [结论]. （55–65 词）"],
  ["WE 四段", "① 改写题目+立场 ② 论点一+解释+例子 ③ 让步 Admittedly… However… ④ In conclusion 重申。210–240 词，留 3 分钟检查拼写。"]
];
function viewLearn() {
  APP.innerHTML = `<div class="card"><h2>22 题型方法卡</h2><table class="tbl"><tr><th>题型</th><th>层</th><th>要点</th></tr>
    ${Object.keys(BANK.type_specs).map(k => { const s = BANK.type_specs[k];
      return `<tr><td><b>${s.code}</b> ${s.name_cn}</td><td>T${s.tier}</td><td>${esc(s.tips)}</td></tr>`; }).join("")}</table>
    <p class="muted small">完整方法论见 docs/02_教学逻辑设计.md；备考计划见 docs/03_备考方案.md。</p></div>
  <div class="card"><h2>模板库（骨架安全，内容词现场填）</h2>
    ${TEMPLATES.map(([n, t]) => `<h3>${n}</h3><div class="template">${esc(t)}</div>`).join("")}</div>
  <div class="card"><h2>考试日清单</h2><ol>
    <li>麦克风置于嘴角下方 2–3 指，试音用正常音量</li><li>Personal Introduction 用来热嗓</li>
    <li>提示音后 1 秒内开口；3 秒静默会截止录音</li><li>错了不回头，卡壳按骨架推进</li>
    <li>Reading 限时表：FIB-RW ≤2min/题</li><li>Listening 给 WFD 留 ≥5 分钟，SST ≤7 分钟</li>
    <li>WE：3 提纲 / 14 写 / 3 检查</li><li>单题失手 <2 分，忘掉上一题</li></ol></div>`;
}

/* ---------------- stats ---------------- */
function viewStats() {
  const est = skillEstimates();
  const rows = Object.keys(BANK.type_specs).map(k => {
    const arr = attemptsOf(k); if (!arr.length) return null;
    const acc = typeAccuracy(k);
    const last5 = arr.slice(-5).map(a => a.max ? Math.round(a.raw / a.max * 100) : 0).join("→");
    return `<tr><td><b>${BANK.type_specs[k].code}</b> ${BANK.type_specs[k].name_cn}</td><td class="right">${arr.length}</td><td class="right">${Math.round(acc * 100)}%</td><td class="muted small">${last5}</td></tr>`;
  }).filter(Boolean).join("");
  const days = {};
  ATTEMPTS.forEach(a => { const d = todayStr(new Date(a.ts)); days[d] = (days[d] || 0) + 1; });
  const dayRows = Object.keys(days).sort().slice(-14).map(d => `<tr><td>${d}</td><td class="right">${days[d]}</td></tr>`).join("");
  APP.innerHTML = `<div class="card"><h2>预测分</h2>
    ${["speaking", "listening", "reading", "writing"].map(sk => skillBar(sk[0].toUpperCase() + sk.slice(1), est.skills[sk], BANK.targets[sk], BANK.safe_targets[sk])).join("")}
    ${skillBar("Overall", est.overall, BANK.targets.overall, BANK.safe_targets.overall)}
    ${CFG.calib ? `<p class="small muted">已用官方模考校准（${CFG.calib.date}）</p>` : `<p class="small muted">未校准——在设置页录入官方 Scored Practice Test 成绩后更准。</p>`}</div>
  <div class="card"><h2>题型表现（近期加权正确率）</h2><table class="tbl"><tr><th>题型</th><th class="right">次数</th><th class="right">正确率</th><th>最近5次</th></tr>${rows || "<tr><td colspan=4 class='muted'>暂无数据</td></tr>"}</table></div>
  <div class="card"><h2>近 14 天练习量</h2><table class="tbl">${dayRows || "<tr><td class='muted'>暂无</td></tr>"}</table></div>`;
}

/* ---------------- settings ---------------- */
function viewSettings() {
  const est = skillEstimates();
  APP.innerHTML = `
  <div class="card"><h2>语音设置</h2>
    <div class="flex"><label>TTS 音色 <select id="voiceSel"><option value="">自动(en-AU优先)</option>
      ${VOICES.map(v => `<option ${CFG.ttsVoice === v.name ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>
    <label>语速 <input type="number" id="rateInp" min="0.7" max="1.3" step="0.05" value="${CFG.ttsRate}" style="width:70px"></label>
    <button class="btn" onclick="testVoice()">试听</button></div>
    <p class="muted small">语音识别（自动比对口语内容）需要 Chrome + 联网；若不可用仍可录音回放自评。</p></div>
  <div class="card"><h2>官方模考校准</h2>
    <p class="small muted">录入 Pearson Scored Practice Test 真实分数，预测分将以此锚定。</p>
    <div class="flex">${["speaking", "listening", "reading", "writing"].map(sk => `<label>${sk[0].toUpperCase() + sk.slice(1)} <input type="number" id="cal_${sk}" min="10" max="90" style="width:64px" value="${CFG.calib && CFG.calib.official ? CFG.calib.official[sk] : ""}"></label>`).join("")}
    <button class="btn primary" onclick="saveCalib()">保存校准</button></div></div>
  <div class="card"><h2>考试日期</h2><input type="date" id="examDate" value="${CFG.examDate || ""}"> <button class="btn" onclick="saveExamDate()">保存</button>
    ${CFG.examDate ? `<span class="muted small">距考试 ${Math.ceil((new Date(CFG.examDate) - new Date()) / 86400000)} 天</span>` : ""}</div>
  <div class="card"><h2>题库</h2>
    <p>内置 ${BANK.items.length} 题 · 已导入 ${CUSTOM.length} 题（bank v${BANK.bank_version}）</p>
    <div class="flex"><label class="btn">导入题库 JSON<input type="file" id="bankFile" accept=".json" style="display:none"></label>
    <button class="btn" onclick="clearCustom()">清空导入题</button></div>
    <p class="muted small">格式见 question-bank/schema.json；批量生成见 generation-prompts.md。</p></div>
  <div class="card"><h2>词卡设置</h2><p>每日新卡上限 <input type="number" id="vlimit" min="5" max="60" style="width:64px" value="${CFG.vNewLimit || 15}"> <button class="btn" onclick="saveVLimit()">保存</button> <span class="muted small">冲刺期建议 15；词汇基础期建议 25–30</span></p></div>
  <div class="card"><h2>数据</h2><div class="flex">
    <button class="btn" onclick="exportData()">导出进度</button>
    <label class="btn">导入进度<input type="file" id="progFile" accept=".json" style="display:none"></label>
    <button class="btn" style="color:var(--bad)" onclick="resetAll()">清空全部数据</button></div>
    <p class="muted small">共 ${ATTEMPTS.length} 条练习记录 · ${Object.keys(SRS).length} 张记忆卡</p></div>`;
  $("#voiceSel").addEventListener("change", e => { CFG.ttsVoice = e.target.value; lsSet("cfg", CFG); });
  $("#rateInp").addEventListener("change", e => { CFG.ttsRate = +e.target.value || 1; lsSet("cfg", CFG); });
  $("#bankFile").addEventListener("change", importBank);
  $("#progFile").addEventListener("change", importProgress);
}
window.testVoice = function () { CFG.ttsVoice = $("#voiceSel").value; CFG.ttsRate = +$("#rateInp").value || 1; lsSet("cfg", CFG); speak("The lecture has been moved to the main auditorium.", {}, null); };
window.saveCalib = function () {
  const official = {}; let any = false;
  ["speaking", "listening", "reading", "writing"].forEach(sk => { const v = +$("#cal_" + sk).value; if (v >= 10 && v <= 90) { official[sk] = v; any = true; } });
  if (!any) { alert("请至少填一项 10–90 的分数"); return; }
  const baseCalib = CFG.calib; CFG.calib = null;
  const raw = skillEstimates();
  const offsets = {};
  Object.keys(official).forEach(sk => { offsets[sk] = raw.skills[sk] == null ? 0 : official[sk] - raw.skills[sk]; });
  CFG.calib = { official, offsets, date: todayStr() };
  lsSet("cfg", CFG); alert("已校准"); viewSettings();
};
window.saveExamDate = function () { CFG.examDate = $("#examDate").value; lsSet("cfg", CFG); viewSettings(); };
window.saveVLimit = function () { CFG.vNewLimit = Math.max(5, Math.min(60, +$("#vlimit").value || 15)); lsSet("cfg", CFG); alert("已保存"); viewSettings(); };
function importBank(e) {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { try {
    let data = JSON.parse(rd.result); if (data.items) data = data.items;
    if (!Array.isArray(data)) throw new Error("需为数组或 {items:[...]}");
    const ok = data.filter(it => it.id && it.type && BANK.type_specs[it.type] && it.prompt && it.answer_key);
    const ids = new Set(allItems().map(i => i.id));
    ok.forEach(it => { let id = it.id, n = 1; while (ids.has(id)) id = it.id + "-" + (n++); it.id = id; ids.add(id); it.source = "imported"; });
    CUSTOM = CUSTOM.concat(ok); lsSet("customBank", CUSTOM);
    alert(`导入 ${ok.length} 题（跳过 ${data.length - ok.length} 条不合规）`); viewSettings();
  } catch (err) { alert("导入失败: " + err.message); } };
  rd.readAsText(f);
}
window.clearCustom = function () { if (confirm("清空所有导入题？")) { CUSTOM = []; lsSet("customBank", CUSTOM); viewSettings(); } };
window.exportData = function () {
  const blob = new Blob([JSON.stringify({ attempts: ATTEMPTS, srs: SRS, cfg: CFG, customBank: CUSTOM, vsrs: VSRS, harvestVocab: HARVEST }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "pte-progress-" + todayStr() + ".json"; a.click();
};
function importProgress(e) {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { try { const d = JSON.parse(rd.result);
    if (d.attempts) { ATTEMPTS = d.attempts; saveAttempts(); }
    if (d.srs) { SRS = d.srs; lsSet("srs", SRS); }
    if (d.cfg) { CFG = d.cfg; lsSet("cfg", CFG); }
    if (d.customBank) { CUSTOM = d.customBank; lsSet("customBank", CUSTOM); }
    if (d.vsrs) { VSRS = d.vsrs; lsSet("vsrs", VSRS); }
    if (d.harvestVocab) { HARVEST = d.harvestVocab; lsSet("harvestVocab", HARVEST); }
    alert("导入完成"); route(); } catch (err) { alert("导入失败: " + err.message); } };
  rd.readAsText(f);
}
window.resetAll = function () { if (confirm("确定清空所有练习记录、记忆卡与设置？")) { ["attempts", "srs", "cfg", "customBank", "vsrs", "harvestVocab", "vnew"].forEach(k => localStorage.removeItem(LSP + k)); location.reload(); } };
window.$ = $;

/* ---------------- boot ---------------- */
renderStreak();
later(() => { refreshVoices(); }, 400);
route();
