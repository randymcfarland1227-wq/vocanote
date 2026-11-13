import { tidy, parseAls, parseMidi, analyzeAudio, midiPeaks, chordEvents, drumKind, guessRoles, pc, octave, NAMES, KIND_COLORS, KIND_LABEL, KIND_ORDER, PEAK_RATE, demoSong, demoLyrics, guessKey } from './parse.js?v=5';
import { Engine } from './audio.js?v=5';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const EPS = 1e-4;
const GUT = 96, RUL = 40, LY = 68;
const LEVELS = [
  { k: 'bar', label: 'Bar' }, { k: 'q', label: '1/4', step: 1, den: 4 }, { k: 'e', label: '1/8', step: 0.5, den: 8 },
  { k: 's', label: '1/16', step: 0.25, den: 16 }, { k: 't', label: '1/32', step: 0.125, den: 32 },
];
const SECTION_TYPES = [
  { n: 'Intro', c: '#38bdf8' }, { n: 'Verse', c: '#818cf8' }, { n: 'Pre-Chorus', c: '#c084fc' }, { n: 'Chorus', c: '#fb7185' },
  { n: 'Hook', c: '#fb923c' }, { n: 'Bridge', c: '#34d399' }, { n: 'Outro', c: '#94a3b8' },
];
const TOK_FONT = '600 18px "Space Grotesk", system-ui, sans-serif';

const defProj = () => ({
  v: 1, tokens: [], sections: [], breaks: [], bpm: 120, offset: 0, roles: {},
  show: { chords: true, bass: true, drums: true }, grid: { bar: true, q: false, e: true, s: false, t: false },
  bars: 2, colors: {}, hidden: {}, follow: 'grid', guide: true, loop: 'off', demo: false,
});

const S = { proj: defProj(), song: null, audio: null, E: { chords: [], bass: [], drums: [] }, kinds: [], on: {}, lanes: [], rows: [], rowTops: [], total: 16, bar: 4, ppb: 60, W: 800, cursor: 0, active: 0, edit: null, undo: [], redo: [], lastNote: 66, peaks: null };
const engine = new Engine();
window.__vn = { S, engine };

const el = { rows: $('#rows'), list: $('#rowlist'), inp: $('#lyin'), ph: $('#ph'), wave: $('#wave'), wph: $('#wph'), stage: $('#stage'), mini: $('#mini'), pop: $('#pop'), menu: $('#menu') };
const mctx = document.createElement('canvas').getContext('2d');
const measure = t => { mctx.font = TOK_FONT; return mctx.measureText(t).width; };

// ---------- helpers ----------
const P = () => S.proj;
const color = k => P().colors[k] || KIND_COLORS[k] || '#999';
const beatToSec = b => (S.audio ? P().offset : 0) + b * 60 / P().bpm;
const fmt = s => { const neg = s < 0; s = Math.abs(s); const m = Math.floor(s / 60); return (neg ? '-' : '') + m + ':' + (s - m * 60).toFixed(2).padStart(5, '0'); };
const gridStep = () => { let st = 1; for (const l of LEVELS) if (l.step && P().grid[l.k]) st = l.step; return st; };
const rowIdx = b => { const r = S.rows; let i = r.length - 1; while (i > 0 && r[i].start > b + EPS) i--; return Math.max(0, i); };
const tokAt = b => P().tokens.find(t => Math.abs(t.beat - b) < 1e-3);
const tokById = id => P().tokens.find(t => t.id === id);
const sortTokens = () => P().tokens.sort((a, b) => a.beat - b.beat);
const sectionAt = b => { let s = null; for (const x of P().sections) if (x.beat <= b + EPS) s = x; return s; };
function posLabel(b) {
  const bar = Math.floor(b / S.bar + EPS), inb = b - bar * S.bar;
  if (inb < EPS) return 'Bar ' + (bar + 1);
  const st = gridStep(), l = LEVELS.find(x => x.step === st);
  return 'Bar ' + (bar + 1) + ', ' + (Math.round(inb / st) + 1) + '/' + l.den;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3800); }

function stretch(text, n) {
  if (n <= text.length) return text;
  let m = text.match(/^(.*?)([aeiou]+)([^aeiou]*)$/i) || text.match(/^(.*?)(y+)([^y]*)$/i);
  if (!m) return text + text.slice(-1).repeat(n - text.length);
  const son = m[3].match(/^[wmnlrhsfvz]*/i)[0], rest = m[3].slice(son.length);
  const units = [...m[2], ...son], extra = n - text.length, base = Math.floor(extra / units.length), rem = extra % units.length;
  return m[1] + units.map((c, i) => c.repeat(1 + base + (i < rem ? 1 : 0))).join('') + rest;
}

// ---------- persistence ----------
let saveT;
const PKEY = n => 'vocanote.p:' + n;
function writeProj() { clearTimeout(saveT); try { const j = JSON.stringify(P()); localStorage.setItem('vocanote.proj', j); if (P().name) localStorage.setItem(PKEY(P().name), j); } catch (e) {} }
function save() { clearTimeout(saveT); saveT = setTimeout(writeProj, 250); syncGuide(); }
function storedProj(name) { try { const raw = localStorage.getItem(PKEY(name)); return raw ? Object.assign(defProj(), JSON.parse(raw)) : null; } catch (e) { return null; } }
// every track file is its own project: put the current one away, then pick up that file's saved lyrics or start clean
function switchProj(name) { writeProj(); closeEdit(); const st = storedProj(name); S.proj = st || defProj(); S.proj.name = name; S.proj.demo = false; S.undo = []; S.redo = []; S.cursor = 0; engine.pos = 0; return !!st; }
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('vocanote', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbSet(k, v) { try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); v == null ? tx.objectStore('files').delete(k) : tx.objectStore('files').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) {} }
async function idbGet(k) { try { const db = await idb(); return await new Promise((res, rej) => { const r = db.transaction('files').objectStore('files').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); } catch (e) { return null; } }

function pushUndo() { S.undo.push(JSON.stringify({ tokens: P().tokens, sections: P().sections, breaks: P().breaks })); if (S.undo.length > 150) S.undo.shift(); S.redo = []; }
function restore(from, to) {
  if (!from.length) return;
  closeEdit();
  to.push(JSON.stringify({ tokens: P().tokens, sections: P().sections, breaks: P().breaks }));
  Object.assign(P(), JSON.parse(from.pop()));
  relayout();
}
const undo = () => restore(S.undo, S.redo), redo = () => restore(S.redo, S.undo);

// ---------- model ----------
function buildElements() {
  const E = { chords: [], bass: [], drums: [] }, R = P().roles, song = S.song;
  if (song) {
    const tr = id => song.tracks.find(t => t.id === id);
    const c = tr(R.chords); if (c) E.chords = chordEvents(c.notes);
    const b = tr(R.bass);
    if (b) { let last = null, lt = -1; for (const n of b.notes) { if (n.t - lt < 0.03) continue; lt = n.t; E.bass.push({ t: tidy(n.t), name: pc(n.p), changed: n.p % 12 !== last }); last = n.p % 12; } }
    const d = tr(R.drums);
    if (d) { const seen = new Set(); for (const n of d.notes) { const kind = drumKind(d.pads[n.p], n.p), key = Math.round(n.t * 96) + kind; if (seen.has(key)) continue; seen.add(key); E.drums.push({ t: tidy(n.t), kind, name: d.pads[n.p] || KIND_LABEL[kind] }); } }
  } else if (S.audio) {
    for (const sec of S.audio.onsets) { const t = (sec - P().offset) * P().bpm / 60; if (t >= -EPS) E.drums.push({ t: Math.max(0, t), kind: 'hit', name: 'Hit heard in the audio' }); }
  }
  S.E = E;
  S.kinds = KIND_ORDER.filter(k => E.drums.some(d => d.kind === k));
  S.on = { chord: E.chords.map(c => c.t), chordChange: E.chords.filter(c => c.changed).map(c => c.t), bass: E.bass.map(b => b.t) };
  for (const k of S.kinds) S.on[k] = E.drums.filter(d => d.kind === k).map(d => d.t);
}
const followTimes = k => k === 'chord' ? S.on.chordChange : S.on[k];

function computeTotal() {
  const song = S.song, p = P();
  S.bar = song ? song.num * 4 / song.den : 4;
  let tot = song ? song.lengthBeats : 0;
  if (S.audio) tot = Math.max(tot, (S.audio.buffer.duration - p.offset) * p.bpm / 60);
  for (const t of p.tokens) tot = Math.max(tot, t.beat + (t.len || 0) + 0.01);
  S.total = Math.max(S.bar * 4, Math.ceil(tot / S.bar - 1e-6) * S.bar);
  S.peaks = S.audio ? S.audio.peaks : song ? midiPeaks(song.tracks, p.bpm, S.total) : null;
}

function syncEngine() {
  const p = P(), song = S.song;
  engine.bpm = p.bpm; engine.offset = p.offset; engine.total = S.total; engine.buffer = S.audio ? S.audio.buffer : null; engine.guideOn = p.guide;
  const ev = [];
  if (song) for (const t of song.tracks) {
    const r = t.id === p.roles.drums || t.isDrum ? 'drum' : t.id === p.roles.bass ? 'bass' : 'chord';
    for (const n of t.notes) ev.push({ t: n.t, d: n.d, p: n.p, v: n.v, r, k: r === 'drum' ? drumKind(t.pads[n.p], n.p) : null });
  }
  engine.events = ev.sort((a, b) => a.t - b.t);
  syncGuide();
}
function syncGuide() {
  const ts = P().tokens, g = [];
  ts.forEach((t, i) => { if (t.note != null && !t.rest) g.push({ t: t.beat, p: t.note, d: t.len > 0 ? t.len : Math.min(1, ts[i + 1] ? Math.max(0.2, ts[i + 1].beat - t.beat) : 1) }); });
  engine.guide = g;
}

function computeLanes() {
  const p = P(), L = [];
  let y = RUL;
  if (S.E.chords.length && p.show.chords) { L.push({ k: 'chord', top: y, y: y + 28, h: 42 }); y += 42; }
  if (S.E.bass.length && p.show.bass) { L.push({ k: 'bass', top: y, y: y + 13, h: 26 }); y += 26; }
  if (p.show.drums) for (const k of S.kinds) if (!p.hidden[k]) { L.push({ k, top: y, y: y + 8, h: 16 }); y += 16; }
  S.lanes = L; S.lyTop = y + 8; S.rowH = S.lyTop + LY;
}
// lanes for one stretch of the song: an instrument with nothing to show there gets no line
function lanesFor(a, b) {
  const p = P(), L = [], has = (arr, k) => arr.some(x => x.t >= a - EPS && x.t < b - EPS && (!k || x.kind === k));
  let y = RUL;
  if (p.show.chords && has(S.E.chords)) { L.push({ k: 'chord', top: y, y: y + 28, h: 42 }); y += 42; }
  if (p.show.bass && has(S.E.bass)) { L.push({ k: 'bass', top: y, y: y + 13, h: 26 }); y += 26; }
  if (p.show.drums) for (const k of S.kinds) if (!p.hidden[k] && has(S.E.drums, k)) { L.push({ k, top: y, y: y + 8, h: 16 }); y += 16; }
  return { lanes: L, lyTop: y + 8, H: y + 8 + LY };
}

function computeRows() {
  const p = P(), bpr = S.bar * p.bars;
  p.breaks = [...new Set(p.breaks.map(b => Math.round(b * 1000) / 1000))].filter(b => b > EPS && b < S.total - EPS).sort((a, b) => a - b);
  p.sections.sort((a, b) => a.beat - b.beat);
  const hard = [...new Set([0, ...p.breaks, ...p.sections.map(s => s.beat).filter(b => b < S.total - EPS)].map(b => Math.round(b * 1000) / 1000))].sort((a, b) => a - b);
  const rows = [];
  hard.forEach((a, hi) => {
    const b = hi + 1 < hard.length ? hard[hi + 1] : S.total;
    for (let s = a; s < b - EPS;) {
      const e = Math.min(b, p.bars >= 1 ? (Math.floor(s / S.bar + EPS) + p.bars) * S.bar : (Math.floor(s / bpr + EPS) + 1) * bpr);
      const sec = sectionAt(s);
      rows.push({ start: s, end: e, sec, secStart: !!sec && Math.abs(sec.beat - s) < 1e-3, manual: s === a && p.breaks.some(x => Math.abs(x - a) < 1e-3) });
      s = e;
    }
  });
  const secs = p.sections.filter(s => s.beat < S.total - EPS), cache = new Map();
  for (const r of rows) {
    const a = r.sec ? r.sec.beat : 0, nx = secs.find(s => s.beat > a + EPS), b = nx ? nx.beat : S.total;
    if (!cache.has(a)) cache.set(a, lanesFor(a, b));
    Object.assign(r, cache.get(a));
  }
  S.rows = rows;
  S.W = Math.max(320, el.stage.clientWidth - GUT - 22);
  S.ppb = S.W / bpr;
}

// ---------- rendering ----------
function rowHTML(i) {
  const r = S.rows[i], p = P(), ppb = S.ppb, w = (r.end - r.start) * ppb, H = r.H, X = b => (b - r.start) * ppb;
  let g = '';
  if (w < S.W - 1) g += `<rect class="void" x="${w}" y="0" width="${S.W - w}" height="${H}"/>`;
  for (const ln of r.lanes) g += `<line class="lane-l" x1="0" x2="${w}" y1="${ln.y}" y2="${ln.y}" style="stroke:${color(ln.k)}"/>`;
  // grid
  const active = LEVELS.filter(l => l.step && p.grid[l.k]), lines = new Map();
  for (const l of [...active].reverse()) for (let n = Math.ceil((r.start - EPS) / l.step); n * l.step < r.end - EPS; n++) lines.set(Math.round(n * l.step * 1000), l.k);
  for (let n = Math.ceil((r.start - EPS) / S.bar); n * S.bar < r.end - EPS; n++) lines.set(Math.round(n * S.bar * 1000), 'bar');
  for (const [b, k] of lines) { const x = X(b / 1000); g += `<line class="g g-${k}" x1="${x}" x2="${x}" y1="${k === 'bar' ? 0 : RUL - (k === 'q' ? 14 : 8)}" y2="${H}"/>`; }
  // labels
  const lab = active[active.length - 1];
  const barTag = (b, x) => `<text class="tbar" x="${x + 4}" y="11">BAR ${Math.floor(b / S.bar + EPS) + 1}</text>`;
  if (lab) {
    let k = 1; while (lab.step * ppb * k < 42) k *= 2;
    for (let n = Math.ceil((r.start - EPS) / lab.step); n * lab.step < r.end - EPS; n++) {
      const b = n * lab.step, idx = Math.round((b - Math.floor(b / S.bar + EPS) * S.bar) / lab.step), x = X(b);
      if (idx === 0 && p.grid.bar) g += barTag(b, x);
      if (idx % k) continue;
      g += `<text class="tl${idx === 0 ? ' tb' : ''}" x="${x + 4}" y="23">${idx + 1}/${lab.den}</text><text class="tt" x="${x + 4}" y="34">${fmt(beatToSec(b))}</text>`;
    }
  } else for (let n = Math.ceil((r.start - EPS) / S.bar); n * S.bar < r.end - EPS; n++) g += barTag(n * S.bar, X(n * S.bar)) + `<text class="tt" x="${X(n * S.bar) + 4}" y="23">${fmt(beatToSec(n * S.bar))}</text>`;
  // lyric tokens + anchor connectors
  const toks = p.tokens.filter(t => t.beat >= r.start - EPS && t.beat < r.end - EPS);
  let th = '';
  toks.forEach((t, j) => {
    const x = X(t.beat), nx = j + 1 < toks.length ? X(toks[j + 1].beat) : Math.max(S.W, x + 60);
    if (t.rest) { th += `<div class="tok rest" data-id="${t.id}" style="left:${x}px;width:${Math.max(8, t.len * ppb)}px" title="Silence"><span class="dash"></span></div>`; return; }
    const ln = t.anchor && r.lanes.find(l => l.k === t.anchor);
    if (ln) g += `<line class="anc" x1="${x}" x2="${x}" y1="${ln.y + 6}" y2="${r.lyTop + 8}" style="stroke:${color(t.anchor)}"/>`;
    const holdW = (t.len || 0) * ppb;
    let disp = t.len > 0 ? stretch(t.text, Math.floor((holdW - 4) / S.chW)) : t.text;
    if (t.join) disp += '-';
    const nat = measure(disp), avail = nx - x - 4, sc = nat > avail ? Math.max(0.5, avail / nat) : 1;
    const end = t.len > 0 ? t.beat + t.len : Math.min(t.beat + 1, j + 1 < toks.length ? toks[j + 1].beat : r.end);
    th += `<div class="tok${ln ? ' anc' : ''}${S.edit && S.edit.id === t.id ? ' editing' : ''}" data-id="${t.id}" data-b="${t.beat}" data-e="${end}" style="left:${x}px;min-width:${Math.max(holdW, 14)}px${ln ? ';--a:' + color(t.anchor) : ''}">`
      + `<span class="tx" style="${sc < 1 ? `transform:scaleX(${sc.toFixed(3)})` : ''}">${esc(disp)}</span>`
      + (t.len > 0 ? `<span class="hold" style="width:${holdW}px"></span>` : '')
      + `<span class="nt${t.note == null ? ' none' : ''}" title="${t.note == null ? 'Add a note' : pc(t.note) + octave(t.note)}">${t.note == null ? '+ note' : '♪ ' + pc(t.note) + octave(t.note)}</span>`
      + `<i class="grip" style="left:${Math.max(holdW, nat * sc) + 1}px" title="Drag to hold this word"></i></div>`;
  });
  // element markers
  const inRow = t => t >= r.start - EPS && t < r.end - EPS;
  const lane = k => r.lanes.find(l => l.k === k);
  const lc = lane('chord');
  if (lc) for (const c of S.E.chords) if (inRow(c.t)) {
    const x = X(c.t);
    g += `<g class="mk" data-t="${c.t}" data-a="chord"><title>${esc(c.name)} chord</title><circle cx="${x}" cy="${lc.y}" r="${c.changed ? 9 : 4}" fill="${color('chord')}" ${c.changed ? '' : 'opacity=".55"'}/>${c.changed ? `<text class="cn" x="${x - 5}" y="${lc.y - 14}" fill="${color('chord')}">${esc(c.name)}</text>` : ''}</g>`;
  }
  const lb = lane('bass');
  if (lb) { let first = true; for (const b of S.E.bass) if (inRow(b.t)) {
    const x = X(b.t), showN = b.changed || first; first = false;
    g += `<g class="mk" data-t="${b.t}" data-a="bass"><title>Bass ${b.name}</title><rect x="${x - 5}" y="${lb.y - 5}" width="10" height="10" transform="rotate(45 ${x} ${lb.y})" fill="${color('bass')}"/>${showN ? `<text class="bn" x="${x + 10}" y="${lb.y + 4}" fill="${color('bass')}">${b.name}</text>` : ''}</g>`;
  } }
  for (const d of S.E.drums) if (inRow(d.t)) {
    const ld = lane(d.kind); if (!ld) continue;
    const x = X(d.t);
    g += `<g class="mk" data-t="${d.t}" data-a="${d.kind}"><title>${esc(d.name)}</title><rect x="${x - 5}" y="${ld.y - 5}" width="10" height="10" rx="2" fill="${color(d.kind)}"/></g>`;
  }
  const sc = r.sec ? r.sec.color : '#5b586e';
  const b1 = Math.floor(r.start / S.bar + EPS) + 1, b2 = Math.ceil(r.end / S.bar - EPS);
  const tags = r.lanes.map(l => `<span class="lt" style="top:${l.y - 6}px;color:${color(l.k)}">${KIND_LABEL[l.k]}</span>`).join('');
  return `<div class="row${i === S.active ? ' act' : ''}${r.secStart ? ' sst' : ''}" data-i="${i}" style="--sec:${sc};height:${H}px">`
    + `<div class="gut">${r.secStart ? `<b class="sname">${esc(r.sec.name)}</b>` : r.sec ? `<span class="scont">${esc(r.sec.name)}</span>` : ''}<span class="bars">${b1 === b2 ? 'Bar ' + b1 : 'Bars ' + b1 + '–' + b2}</span>${r.manual ? `<button class="unbr" data-unbreak="${r.start}" title="Remove this line break">↵ ×</button>` : ''}${tags}<span class="lt ly" style="top:${r.lyTop + 12}px">Lyrics</span></div>`
    + `<div class="lane" style="width:${S.W}px"><svg class="els" width="${S.W}" height="${H}">${g}</svg><div class="lyr" style="top:${r.lyTop}px;height:${LY}px">${th}</div></div></div>`;
}
function renderRow(i) { const n = el.list.children[i]; if (n) n.outerHTML = rowHTML(i); }
function renderRows() {
  S.chW = measure('o');
  let h = '';
  for (let i = 0; i < S.rows.length; i++) h += rowHTML(i);
  el.list.innerHTML = h;
  S.rowTops = [...el.list.children].map(c => c.offsetTop);
}

function relayout() {
  computeTotal(); engine.total = S.total;
  computeLanes(); computeRows();
  S.active = rowIdx(S.cursor);
  renderRows(); renderMini(); renderSecs(); drawWave(); placeInput(); updateLoop(); save();
}
function refresh() {
  buildElements(); computeTotal(); syncEngine(); renderSide(); relayout();
  const has = !!(S.song || S.audio);
  $('#empty').hidden = has; el.rows.hidden = !has; $('#sticky').hidden = !has;
  $('#fname').textContent = [S.song && S.song.name, S.audio && S.audio.name].filter(Boolean).join('  +  ');
  $('#offBox').hidden = !S.audio;
  const nd = S.song ? S.song.tracks.filter(t => !t.isDrum && t.id !== P().roles.drums) : [];
  S.key = S.song ? guessKey(nd) : null;
  $('#meta').hidden = !has;
  $('#meta').innerHTML = `<span title="${S.song ? 'Worked out from the notes in the track' : 'The key is read from MIDI notes. An audio-only file has none.'}">Key <b>${S.key || '—'}</b></span><span title="Change it under Tempo in the panel"><b>${+P().bpm.toFixed(2)}</b> BPM</span>`;
  zoomLabel();
}
const ZOOMS = [0.5, 1, 2, 3, 4, 6, 8];
function zoomLabel() { const b = P().bars; $('#barsN').textContent = b === 0.5 ? '½ bar' : b === 1 ? '1 bar' : b + ' bars'; }
function zoom(dir) { let i = ZOOMS.indexOf(P().bars); if (i < 0) i = ZOOMS.findIndex(z => z >= P().bars); i = Math.max(0, Math.min(ZOOMS.length - 1, i - dir)); if (ZOOMS[i] === P().bars) return; P().bars = ZOOMS[i]; zoomLabel(); const c = S.cursor; relayout(); const k = el.list.children[rowIdx(engine.playing ? engine.beat() : c)]; if (k) el.stage.scrollTo({ top: Math.max(0, S.rowTops[rowIdx(engine.playing ? engine.beat() : c)] - 8) }); }

function renderMini() {
  el.mini.innerHTML = S.rows.map((r, i) => `<i data-i="${i}" class="${i === S.active ? 'act' : ''}${r.secStart ? ' st' : ''}" style="flex:${r.end - r.start};background:${r.sec ? r.sec.color : '#4a4860'}" title="${r.sec ? esc(r.sec.name) + ' · ' : ''}Bar ${Math.floor(r.start / S.bar + EPS) + 1}"></i>`).join('');
}

function drawWave() {
  const c = el.wave, dpr = window.devicePixelRatio || 1, W = S.W, Hh = 92, r = S.rows[S.active];
  c.style.width = W + 'px'; c.style.height = Hh + 'px'; c.width = W * dpr; c.height = Hh * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr); x.clearRect(0, 0, W, Hh);
  if (!r) return;
  const col = r.sec ? r.sec.color : '#ffd166', mid = 56, amp = 32, ppb = S.ppb, w = (r.end - r.start) * ppb;
  x.fillStyle = col;
  if (S.peaks) for (let px = 0; px < w; px += 3) {
    const i0 = Math.floor(beatToSec(r.start + px / ppb) * PEAK_RATE), i1 = Math.max(i0 + 1, Math.floor(beatToSec(r.start + (px + 3) / ppb) * PEAK_RATE));
    let m = 0; for (let i = Math.max(0, i0); i < i1 && i < S.peaks.length; i++) if (S.peaks[i] > m) m = S.peaks[i];
    const h = Math.max(1, m * amp);
    x.globalAlpha = 0.9; x.fillRect(px, mid - h, 2, h * 2);
  }
  x.globalAlpha = 1; x.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
  for (let n = Math.ceil((r.start - EPS) / S.bar); n * S.bar < r.end - EPS; n++) {
    const bx = (n * S.bar - r.start) * ppb;
    x.fillStyle = 'rgba(241,237,228,.28)'; x.fillRect(bx, 0, 1, Hh);
    x.fillStyle = '#f1ede4'; x.fillText('Bar ' + (n + 1), bx + 6, 13);
    let ch = null; if (P().show.chords) for (const e of S.E.chords) { if (e.t > n * S.bar + 0.02) break; ch = e.name; }
    if (ch) { x.fillStyle = color('chord'); x.fillText(ch, bx + 6 + x.measureText('Bar ' + (n + 1) + '  ').width, 13); }
  }
}

function renderSide() {
  const p = P();
  $('#grid').innerHTML = LEVELS.map(l => `<button data-g="${l.k}" class="${p.grid[l.k] ? 'on' : ''}" aria-pressed="${!!p.grid[l.k]}">${l.label}</button>`).join('');
  let h = '';
  if (S.song) {
    const opts = sel => `<option value="">None</option>` + S.song.tracks.filter(t => t.notes.length).map(t => `<option value="${t.id}"${t.id === sel ? ' selected' : ''}>${esc(t.name)}${t.device && !t.name.includes(t.device) ? ' · ' + esc(t.device) : ''}</option>`).join('');
    for (const [role, lab, sym] of [['chords', 'Chords', 'cir'], ['bass', 'Bass', 'dia'], ['drums', 'Drums', 'sq']]) {
      const ck = role === 'chords' ? 'chord' : role === 'bass' ? 'bass' : null;
      h += `<div class="elr"><label class="chk"><input type="checkbox" data-show="${role}"${p.show[role] ? ' checked' : ''}><i class="sym ${sym}" style="background:${ck ? color(ck) : color('kick')}"></i>${lab}</label>${ck ? `<input type="color" data-col="${ck}" value="${color(ck)}" title="Color">` : ''}</div><select data-role="${role}" title="Which track is the ${lab.toLowerCase()}?">${opts(p.roles[role])}</select>`;
      if (role === 'drums') h += drumList();
    }
  } else if (S.audio) {
    h += `<div class="elr"><label class="chk"><input type="checkbox" data-show="drums"${p.show.drums ? ' checked' : ''}><i class="sym sq" style="background:${color('hit')}"></i>Hits heard in the audio</label><input type="color" data-col="hit" value="${color('hit')}"></div><p class="hint">Audio alone can’t tell chords from bass. Add the song’s .als or .mid (Open file) and the chords, bass and each drum show up.</p>`;
  } else h = '<p class="hint">Open a track to see its chords, bass and drums.</p>';
  $('#els').innerHTML = h;
  const f = [['grid', 'the next grid step']];
  if (S.E.chords.length) f.push(['chord', 'the next chord change']);
  if (S.E.bass.length) f.push(['bass', 'the next bass note']);
  for (const k of S.kinds) f.push([k, 'the next ' + KIND_LABEL[k].toLowerCase()]);
  if (!f.some(x => x[0] === p.follow)) p.follow = 'grid';
  $('#follow').innerHTML = f.map(([v, t]) => `<option value="${v}"${v === p.follow ? ' selected' : ''}>${t}</option>`).join('');
  $('#guide').checked = p.guide;
  $('#bpm').value = p.bpm; $('#off').value = p.offset;
  $('#secAdd').innerHTML = SECTION_TYPES.map(t => `<button data-sec="${t.n}" style="--c:${t.c}">${t.n}</button>`).join('') + '<button data-sec="*">Custom…</button>';
  $('#loop').textContent = 'Loop: ' + p.loop; $('#loop').classList.toggle('on', p.loop !== 'off');
}
const drumList = () => S.kinds.length ? '<div class="kinds">' + S.kinds.map(k => `<label class="chk"><input type="checkbox" data-kind="${k}"${P().hidden[k] ? '' : ' checked'}><input type="color" data-col="${k}" value="${color(k)}" title="Color">${KIND_LABEL[k]}</label>`).join('') + '</div>' : '';

function renderSecs() {
  $('#secHint').textContent = (S.song || S.audio) ? 'New section starts at ' + posLabel(S.cursor) + '.' : '';
  $('#secList').innerHTML = P().sections.map(s => `<div class="sec" data-id="${s.id}"><input type="color" value="${s.color}" title="Color"><input class="sn" value="${esc(s.name)}" aria-label="Section name"><span>${posLabel(s.beat).replace('Bar ', 'B')}</span><button title="Remove section" aria-label="Remove section">×</button></div>`).join('');
}

// ---------- cursor / playhead ----------
function setActive(i, scroll) {
  if (i === S.active) return;
  const kids = el.list.children;
  kids[S.active] && kids[S.active].classList.remove('act');
  S.active = i;
  kids[i] && kids[i].classList.add('act');
  const m = el.mini.children; for (let j = 0; j < m.length; j++) m[j].classList.toggle('act', j === i);
  drawWave();
  if (scroll && kids[i]) {
    const top = S.rowTops[i] + el.rows.offsetTop - $('#sticky').offsetHeight - 12, st = el.stage.scrollTop, vh = el.stage.clientHeight - $('#sticky').offsetHeight;
    const want = Math.max(0, Math.min(top + 4, el.stage.scrollHeight - el.stage.clientHeight));
    if (Math.abs(want - st) > 6) el.stage.scrollTo({ top: want, behavior: 'smooth' });
  }
}
function setCursor(b, seek = true) {
  S.cursor = Math.max(0, Math.min(S.total - EPS, b));
  if (seek && !engine.playing) engine.seek(S.cursor);
  if (!engine.playing) setActive(rowIdx(S.cursor), false);
  updateLoop();
  $('#secHint').textContent = 'New section starts at ' + posLabel(S.cursor) + '.';
}
function updateLoop() {
  const m = P().loop, r = S.rows[rowIdx(S.cursor)];
  if (m === 'off' || !r) { engine.loop = null; return; }
  if (m === 'line') { engine.loop = [r.start, r.end]; return; }
  const s = sectionAt(S.cursor), nx = P().sections.find(x => x.beat > S.cursor + EPS);
  engine.loop = [s ? s.beat : 0, nx ? nx.beat : S.total];
}
function frame() {
  if (S.rows.length) {
    const b = Math.max(0, Math.min(S.total - EPS, engine.beat())), i = rowIdx(b), r = S.rows[i];
    if (engine.playing) setActive(i, true);
    el.ph.style.transform = `translate(${GUT + (b - r.start) * S.ppb}px,${S.rowTops[i] || 0}px)`;
    el.ph.style.height = r.H + 'px';
    const ar = S.rows[S.active], inA = ar && b >= ar.start - EPS && b <= ar.end;
    el.wph.style.display = inA ? '' : 'none';
    if (inA) el.wph.style.transform = `translateX(${GUT + (b - ar.start) * S.ppb}px)`;
    $('#clock').textContent = 'Bar ' + (Math.floor(b / S.bar + EPS) + 1) + ' · ' + fmt(beatToSec(b));
    if (engine.playing || S.wasPlaying) {
      for (const t of el.list.querySelectorAll('.tok.on')) t.classList.remove('on');
      if (engine.playing && el.list.children[i]) for (const t of el.list.children[i].querySelectorAll('.tok[data-b]')) if (b >= +t.dataset.b - 0.02 && b < +t.dataset.e) t.classList.add('on');
    }
    if (S.wasPlaying !== engine.playing) { S.wasPlaying = engine.playing; $('#play').textContent = engine.playing ? '❚❚' : '▶'; $('#play').classList.toggle('on', engine.playing); }
  }
  requestAnimationFrame(frame);
}

// ---------- snapping / stepping ----------
const RANK = k => k === P().follow ? 0 : k === 'kick' ? 1 : k === 'snare' ? 2 : k === 'chord' ? 9 : k === 'bass' ? 8 : 5;
function snap(row, x, free) {
  let b = Math.max(row.start, Math.min(row.end - 1e-3, row.start + x / S.ppb));
  if (free) return { beat: Math.round(b * 96) / 96, anchor: null };
  let best = null;
  const lim = 9 / S.ppb;
  for (const ln of S.lanes) for (const t of S.on[ln.k] || []) {
    if (t < row.start - EPS || t >= row.end - EPS) continue;
    const d = Math.abs(t - b);
    if (d > lim) continue;
    if (!best || d < best.d - 1e-3 || (Math.abs(d - best.d) <= 1e-3 && RANK(ln.k) < RANK(best.anchor))) best = { d, beat: t, anchor: ln.k };
  }
  if (best) return best;
  const st = gridStep();
  return { beat: Math.max(row.start, Math.min(Math.round(b / st) * st, row.end - Math.min(st, row.end - row.start))), anchor: null };
}
function anchorAt(beat) {
  let best = null;
  for (const ln of S.lanes) if ((S.on[ln.k] || []).some(t => Math.abs(t - beat) < 1e-3) && (!best || RANK(ln.k) < RANK(best))) best = ln.k;
  return best;
}
function nextStep(beat, min = 0) {
  const f = P().follow, from = Math.max(beat + 1e-3, min - 1e-3);
  if (f !== 'grid') { const n = (followTimes(f) || []).find(t => t >= from); if (n != null) return { beat: n, anchor: S.lanes.some(l => l.k === f) ? f : null }; }
  const st = gridStep(), b = Math.min(S.total - st, Math.max(Math.floor(beat / st + 1e-6) * st + st, Math.ceil(min / st - 1e-6) * st));
  return { beat: b, anchor: anchorAt(b) };
}
function prevStep(beat) {
  const f = P().follow;
  if (f !== 'grid') { const a = (followTimes(f) || []).filter(t => t < beat - 1e-3); if (a.length) return { beat: a[a.length - 1], anchor: f }; }
  const st = gridStep();
  const b = Math.max(0, Math.ceil(beat / st - 1e-6) * st - st);
  return { beat: b, anchor: anchorAt(b) };
}

// ---------- lyric editing ----------
function placeInput() {
  const e = S.edit, inp = el.inp;
  if (!e) { inp.style.display = 'none'; $('#edbar').hidden = true; return; }
  const i = rowIdx(e.beat), r = S.rows[i], tk = e.id && tokById(e.id);
  inp.style.display = 'block';
  inp.style.left = GUT + (e.beat - r.start) * S.ppb - 3 + 'px';
  inp.style.top = S.rowTops[i] + r.lyTop + 5 + 'px';
  inp.style.width = Math.max(34, measure(inp.value) + 16, tk ? tk.len * S.ppb : 0) + 'px';
  const bar = $('#edbar'); bar.hidden = false;
  bar.innerHTML = tk && !tk.rest ? `<button data-eb="note">${tk.note == null ? '♪ Add note' : '♪ ' + pc(tk.note) + octave(tk.note)}</button><button data-eb="up" title="Note up (↑)">▲</button><button data-eb="dn" title="Note down (↓)">▼</button><button data-eb="shorter" title="Hold shorter (Shift ←)">⇤ hold</button><button data-eb="longer" title="Hold longer (Shift →)">hold ⇥</button><button data-eb="del" class="del">Delete</button>` : '<span>Type the word. Then pick its note and hold here.</span>';
  bar.style.top = S.rowTops[i] + r.lyTop + 36 + 'px';
  bar.style.left = Math.max(4, Math.min(GUT + (e.beat - r.start) * S.ppb - 3, GUT + S.W - bar.offsetWidth - 4)) + 'px';
}
function openEdit(beat, anchor) {
  if (!S.rows.length) return;
  if (S.edit) { const old = S.edit; S.edit = null; renderRow(rowIdx(old.beat)); }
  let t = tokAt(beat), guard = 0;
  while (t && t.rest && guard++ < 50) { beat = t.beat + t.len; t = tokAt(beat); }
  beat = Math.max(0, Math.min(S.total - EPS, beat));
  S.edit = { beat, id: t ? t.id : null, anchor: anchor !== undefined ? anchor : null, dirty: false };
  el.inp.value = t ? t.text : '';
  if (t) renderRow(rowIdx(beat));
  placeInput();
  el.inp.focus({ preventScroll: true });
  el.inp.setSelectionRange(el.inp.value.length, el.inp.value.length);
  const i = rowIdx(beat), top = S.rowTops[i] + el.rows.offsetTop, sh = $('#sticky').offsetHeight;
  if (top - sh < el.stage.scrollTop || top + S.rows[i].H > el.stage.scrollTop + el.stage.clientHeight) el.stage.scrollTo({ top: Math.max(0, top - sh - 30), behavior: 'smooth' });
}
function closeEdit() {
  if (!S.edit) return;
  const i = rowIdx(S.edit.beat);
  S.edit = null; el.inp.style.display = 'none'; el.inp.value = ''; $('#edbar').hidden = true;
  renderRow(i);
}
const holdEnd = () => { const t = S.edit && tokById(S.edit.id); return t && t.len > 0 ? t.beat + t.len : 0; };
const dirty = () => { if (S.edit && !S.edit.dirty) { pushUndo(); S.edit.dirty = true; } };
const go = n => { setCursor(n.beat); openEdit(n.beat, n.anchor); };

function newTok(beat, anchor) { const t = { id: uid(), beat, text: '', len: 0, note: null, anchor: anchor || null }; P().tokens.push(t); return t; }
function removeTok(t) { const a = P().tokens, i = a.indexOf(t); if (i >= 0) a.splice(i, 1); }

function onInput() {
  const e = S.edit; if (!e) return;
  const v = el.inp.value;
  dirty();
  if (v === '-') return addRest();
  const parts = [];
  for (const w of v.split(/\s+/)) {
    if (/^-+$/.test(w)) { parts.push({ rest: w.length }); continue; }
    const re = /([^-]+)(-?)/g; let m;
    while ((m = re.exec(w))) parts.push({ text: m[1], join: m[2] === '-' });
  }
  const trailing = /[\s-]$/.test(v);
  if (!parts.length) {
    if (e.id) { removeTok(tokById(e.id)); e.id = null; }
    el.inp.value = '';
    if (trailing) return go(nextStep(e.beat));
    renderRow(rowIdx(e.beat)); placeInput(); save(); return;
  }
  let beat = e.beat, anchor = e.anchor, t = null;
  const st = gridStep();
  parts.forEach((pt, idx) => {
    if (pt.rest) {
      if (!tokAt(beat)) P().tokens.push({ id: uid(), beat, text: '', len: st * pt.rest, rest: true });
      beat = Math.min(S.total - st, beat + st * pt.rest); anchor = anchorAt(beat); t = null; return;
    }
    t = idx === 0 && e.id ? tokById(e.id) : tokAt(beat);
    if (t && t.rest) { removeTok(t); t = null; }
    if (!t) t = newTok(beat, anchor);
    t.text = pt.text; t.join = pt.join;
    if (idx < parts.length - 1 || trailing) { const n = nextStep(beat, t.len > 0 ? t.beat + t.len : 0); beat = n.beat; anchor = n.anchor; }
  });
  sortTokens(); save();
  if (parts.length === 1 && !trailing && t) { e.id = t.id; renderRow(rowIdx(e.beat)); placeInput(); return; }
  S.edit = null; renderRows();
  if (trailing || !t) go({ beat, anchor }); else { setCursor(t.beat); openEdit(t.beat); }
}
function addRest() {
  const e = S.edit, st = gridStep(), beat = e.beat;
  el.inp.value = '';
  const prev = P().tokens.find(t => t.rest && Math.abs(t.beat + t.len - beat) < 1e-3);
  if (prev) prev.len += st;
  else if (!tokAt(beat)) P().tokens.push({ id: uid(), beat, text: '', len: st, rest: true });
  sortTokens(); save();
  S.edit = null; renderRows();
  go({ beat: Math.min(S.total - st, beat + st), anchor: null });
}
function backEmpty() {
  const e = S.edit, st = gridStep(), beat = e.beat, a = P().tokens;
  const rest = a.find(t => t.rest && Math.abs(t.beat + t.len - beat) < 1e-3);
  if (rest) {
    dirty(); rest.len -= st;
    const to = Math.max(rest.beat, beat - st);
    if (rest.len < 1e-3) removeTok(rest);
    S.edit = null; renderRows(); save(); setCursor(to); openEdit(to); return;
  }
  const r = S.rows[rowIdx(beat)];
  if (Math.abs(r.start - beat) < 1e-3 && r.manual) { removeBreak(beat); return; }
  const prev = [...a].reverse().find(t => t.beat < beat - 1e-3);
  if (prev) { setCursor(prev.beat); openEdit(prev.beat); }
}
function nudgeNote(dir, oct) {
  const t = S.edit && tokById(S.edit.id); if (!t) return;
  dirty();
  t.note = t.note == null ? S.lastNote : Math.max(24, Math.min(108, t.note + dir * (oct ? 12 : 1)));
  S.lastNote = t.note; engine.blip(t.note);
  renderRow(rowIdx(t.beat)); placeInput(); save();
}
function nudgeLen(dir) {
  const t = S.edit && tokById(S.edit.id); if (!t) return;
  dirty();
  t.len = Math.max(0, Math.round(((t.len || 0) + dir * gridStep()) * 1000) / 1000);
  renderRow(rowIdx(t.beat)); placeInput(); save();
}

function addBreak(beat) {
  const r = S.rows[rowIdx(beat)];
  if (beat < EPS || Math.abs(r.start - beat) < 1e-3) { toast('This spot already starts a line.'); return; }
  pushUndo(); P().breaks.push(beat); relayout();
  toast('Everything from ' + posLabel(beat) + ' moved to its own line.');
}
function removeBreak(beat) { pushUndo(); P().breaks = P().breaks.filter(b => Math.abs(b - beat) > 1e-3); relayout(); }
function addSection(type, beat) {
  let name = type.n, col = type.c;
  if (name === '*') { name = (prompt('Section name') || '').trim(); if (!name) return; col = ['#f472b6', '#facc15', '#2dd4bf', '#a3e635'][P().sections.length % 4]; }
  pushUndo();
  beat = Math.round(beat * 1000) / 1000;
  const same = P().sections.filter(s => s.name.replace(/ \d+$/, '') === name && Math.abs(s.beat - beat) > 1e-3).length;
  if (same && !/Intro|Outro/.test(name)) name += ' ' + (same + 1);
  const ex = P().sections.find(s => Math.abs(s.beat - beat) < 1e-3);
  if (ex) { ex.name = name; ex.color = col; } else P().sections.push({ id: uid(), beat, name, color: col });
  relayout();
}

// ---------- pointer interactions on the rows ----------
let drag = null;
function rowAtY(clientY) {
  const y = clientY - el.rows.getBoundingClientRect().top;
  let i = 0; while (i + 1 < S.rowTops.length && S.rowTops[i + 1] <= y) i++;
  return i;
}
const laneLeft = () => el.rows.getBoundingClientRect().left + GUT;
el.rows.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target === el.inp) return;
  const ub = e.target.closest('[data-unbreak]');
  if (ub) { removeBreak(+ub.dataset.unbreak); return; }
  const rowEl = e.target.closest('.row'); if (!rowEl) return;
  const i = +rowEl.dataset.i, row = S.rows[i], x = e.clientX - laneLeft(), y = e.clientY - rowEl.getBoundingClientRect().top;
  const tokEl = e.target.closest('.tok');
  e.preventDefault();
  if (tokEl) {
    const t = tokById(tokEl.dataset.id);
    if (e.target.closest('.nt')) { closeEdit(); return openNotes(t, e.target.closest('.nt')); }
    drag = { t, mode: e.target.closest('.grip') ? 'len' : 'move', x0: e.clientX, y0: e.clientY, dx: e.clientX - tokEl.getBoundingClientRect().left, moved: false };
    el.rows.setPointerCapture(e.pointerId);
    return;
  }
  const mk = e.target.closest('.mk');
  if (mk) { setCursor(+mk.dataset.t); return openEdit(+mk.dataset.t, mk.dataset.a); }
  if (x < 0) { closeEdit(); return setCursor(row.start); }
  if (y >= row.lyTop) {
    const bx = row.start + x / S.ppb, inside = P().tokens.find(t => !t.rest && t.len > 0 && bx >= t.beat - EPS && bx < t.beat + t.len && t.beat >= row.start - EPS);
    if (inside) { setCursor(inside.beat); return openEdit(inside.beat, inside.anchor); }
    const s = snap(row, x, e.altKey); setCursor(s.beat); openEdit(s.beat, s.anchor);
  }
  else { closeEdit(); el.inp.blur(); const st = gridStep(), b = row.start + x / S.ppb; setCursor(e.altKey ? b : Math.min(row.end - EPS, Math.round(b / st) * st)); }
});
el.rows.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.moved) { if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return; drag.moved = true; pushUndo(); closeEdit(); }
  const t = drag.t;
  if (drag.mode === 'len' || t.rest && drag.mode === 'len') {
    const row = S.rows[rowIdx(t.beat)], st = gridStep(), b = row.start + (e.clientX - laneLeft()) / S.ppb;
    const len = Math.max(0, (e.altKey ? b : Math.round(b / st) * st) - t.beat);
    t.len = t.rest ? Math.max(st, len) : len;
    renderRow(rowIdx(t.beat));
  } else {
    const oi = rowIdx(t.beat), ni = rowAtY(e.clientY), s = snap(S.rows[ni], e.clientX - drag.dx - laneLeft(), e.altKey);
    if (Math.abs(s.beat - t.beat) < 1e-4 && s.anchor === t.anchor) return;
    const clash = tokAt(s.beat); if (clash && clash !== t) return;
    t.beat = s.beat; if (!t.rest) t.anchor = s.anchor;
    sortTokens(); renderRow(oi); if (ni !== oi) renderRow(ni);
  }
});
const endDrag = () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.moved) { setCursor(d.t.beat); openEdit(d.t.beat, d.t.anchor); } else save();
};
el.rows.addEventListener('pointerup', endDrag);
el.rows.addEventListener('pointercancel', endDrag);

el.rows.addEventListener('contextmenu', e => {
  const rowEl = e.target.closest('.row'); if (!rowEl) return;
  e.preventDefault();
  const row = S.rows[+rowEl.dataset.i], x = e.clientX - laneLeft(), st = gridStep();
  let b = x < 0 ? row.start : Math.max(row.start, Math.min(row.end - EPS, Math.round((row.start + x / S.ppb) / st) * st));
  const nb = Math.round(b / S.bar) * S.bar; if (Math.abs(nb - b) * S.ppb < 14 && nb >= row.start - EPS && nb < row.end) b = nb;
  const tokEl = e.target.closest('.tok'), tk = tokEl && tokById(tokEl.dataset.id);
  if (tk) b = tk.beat;
  closeEdit(); setCursor(b);
  const lineToks = P().tokens.filter(t => t.beat >= row.start - EPS && t.beat < row.end - EPS);
  const del = (tk && !tk.rest ? '<button class="mi" data-m="note">Set the note for this word…</button>' : '') + (tk ? `<button class="mi del" data-m="del">${tk.rest ? 'Delete this silence' : 'Delete “' + esc(tk.text || '…') + '”'}</button>` : '') + (lineToks.length ? '<button class="mi del" data-m="clear">Delete every word on this line</button>' : '');
  const items = [del, `<div class="mh">${posLabel(b)}</div><div class="ml">Start a section here</div><div class="chips sm">` + SECTION_TYPES.map(t => `<button data-m="sec" data-n="${t.n}" style="--c:${t.c}">${t.n}</button>`).join('') + `<button data-m="sec" data-n="*">Custom…</button></div>`];
  if (Math.abs(row.start - b) > 1e-3) items.push('<button class="mi" data-m="break">Push the rest onto a new line <kbd>Enter</kbd></button>');
  if (row.manual) items.push('<button class="mi" data-m="unbreak">Remove this line’s break</button>');
  const s = sectionAt(b); if (s) items.push(`<button class="mi" data-m="unsec">Remove section “${esc(s.name)}”</button>`);
  items.push('<button class="mi" data-m="play">Play from here</button>');
  showMenu(items.join(''), e.clientX, e.clientY, m => {
    if (m.m === 'sec') addSection(m.n === '*' ? { n: '*' } : SECTION_TYPES.find(t => t.n === m.n), b);
    else if (m.m === 'break') addBreak(b);
    else if (m.m === 'unbreak') removeBreak(row.start);
    else if (m.m === 'unsec') { pushUndo(); P().sections = P().sections.filter(q => q !== s); relayout(); }
    else if (m.m === 'play') engine.play(b);
    else if (m.m === 'note') noteFor(tk);
    else if (m.m === 'del') { pushUndo(); const a = P().tokens, j = a.indexOf(tk); if (j > 0 && a[j - 1].join && !tk.join) a[j - 1].join = false; removeTok(tk); relayout(); }
    else if (m.m === 'clear') { pushUndo(); P().tokens = P().tokens.filter(t => !lineToks.includes(t)); relayout(); }
  });
});

function showMenu(html, x, y, cb) {
  const m = el.menu; m.innerHTML = html; m.hidden = false;
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 8) + 'px'; m.style.top = Math.min(y, innerHeight - m.offsetHeight - 8) + 'px';
  m.onclick = e => { const b = e.target.closest('[data-m]'); if (!b) return; m.hidden = true; cb(b.dataset); };
}
function noteFor(t) { closeEdit(); const n = el.list.querySelector(`.tok[data-id="${t.id}"] .nt`); if (n) openNotes(t, n); }
$('#edbar').addEventListener('pointerdown', e => e.preventDefault());
$('#edbar').addEventListener('click', e => {
  const b = e.target.closest('[data-eb]'), t = S.edit && tokById(S.edit.id); if (!b || !t) return;
  const k = b.dataset.eb;
  if (k === 'note') return noteFor(t);
  if (k === 'del') { pushUndo(); closeEdit(); const a = P().tokens, j = a.indexOf(t); if (j > 0 && a[j - 1].join && !t.join) a[j - 1].join = false; removeTok(t); return relayout(); }
  if (k === 'up' || k === 'dn') nudgeNote(k === 'up' ? 1 : -1, false); else nudgeLen(k === 'longer' ? 1 : -1);
  placeInput();
});
function openNotes(t, target) {
  const p = el.pop, draw = () => {
    const cur = t.note, oc = cur == null ? octave(S.lastNote) : octave(cur);
    p.innerHTML = `<div class="pn">${NAMES.map((n, i) => `<button data-pc="${i}" class="${cur != null && cur % 12 === i ? 'on' : ''}${n.length > 1 ? ' acc' : ''}">${n}</button>`).join('')}</div><div class="po"><button data-oc="-1">− octave</button><b>${oc}</b><button data-oc="1">octave +</button><button data-clear="1">No note</button></div>`;
  };
  draw(); p.hidden = false;
  const r = target.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.left - 20, innerWidth - p.offsetWidth - 8)) + 'px'; p.style.top = Math.min(r.bottom + 6, innerHeight - p.offsetHeight - 8) + 'px';
  p.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    pushUndo();
    const base = t.note == null ? S.lastNote : t.note;
    if (b.dataset.clear) { t.note = null; p.hidden = true; }
    else if (b.dataset.oc) t.note = Math.max(24, Math.min(108, base + 12 * +b.dataset.oc));
    else t.note = (octave(base) + 2) * 12 + +b.dataset.pc;
    if (t.note != null) { S.lastNote = t.note; engine.blip(t.note); draw(); }
    renderRow(rowIdx(t.beat)); save();
  };
}
document.addEventListener('pointerdown', e => {
  if (!el.pop.hidden && !e.target.closest('#pop')) el.pop.hidden = true;
  if (!el.menu.hidden && !e.target.closest('#menu')) el.menu.hidden = true;
}, true);

// ---------- lyric input events ----------
el.inp.addEventListener('input', onInput);
el.inp.addEventListener('blur', () => setTimeout(() => { if (S.edit && document.activeElement !== el.inp) closeEdit(); }, 0));
el.inp.addEventListener('keydown', e => {
  const ed = S.edit; if (!ed) return;
  const k = e.key, inp = el.inp, mod = e.metaKey || e.ctrlKey;
  if (k === 'Enter') { e.preventDefault(); if (mod) { engine.playing ? engine.pause() : engine.play(S.rows[rowIdx(ed.beat)].start); } else addBreak(ed.beat); }
  else if (k === 'Escape') { e.preventDefault(); closeEdit(); inp.blur(); }
  else if (k === 'Tab') { e.preventDefault(); go(e.shiftKey ? prevStep(ed.beat) : nextStep(ed.beat, holdEnd())); }
  else if (k === 'Backspace' && inp.value === '') { e.preventDefault(); backEmpty(); }
  else if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); nudgeNote(k === 'ArrowUp' ? 1 : -1, e.altKey); }
  else if ((k === 'ArrowRight' || k === 'ArrowLeft') && e.shiftKey) { e.preventDefault(); nudgeLen(k === 'ArrowRight' ? 1 : -1); }
  else if (k === 'ArrowRight' && inp.selectionStart === inp.value.length) { e.preventDefault(); go(nextStep(ed.beat, holdEnd())); }
  else if (k === 'ArrowLeft' && inp.selectionEnd === 0) { e.preventDefault(); go(prevStep(ed.beat)); }
  else if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});
document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea,dialog') || !S.rows.length || !(S.song || S.audio)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === ' ') { e.preventDefault(); engine.toggle(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod || e.altKey) return;
  else if (e.key === 'Enter') { e.preventDefault(); addBreak(S.cursor); }
  else if (e.key === 'l' || e.key === 'L') cycleLoop();
  else if (e.key === 'Home') { setCursor(0); el.stage.scrollTo({ top: 0 }); }
  else if (e.key.length === 1) openEdit(S.cursor, anchorAt(S.cursor));
});

// ---------- chrome ----------
function cycleLoop() { const o = ['off', 'line', 'section']; P().loop = o[(o.indexOf(P().loop) + 1) % 3]; $('#loop').textContent = 'Loop: ' + P().loop; $('#loop').classList.toggle('on', P().loop !== 'off'); updateLoop(); save(); }
$('#play').onclick = () => engine.toggle();
$('#loop').onclick = cycleLoop;
$('#vol').oninput = e => engine.setVol(+e.target.value);
$('#undo').onclick = undo;
const sideLabel = () => { const hid = document.body.classList.contains('noside') !== matchMedia('(max-width: 900px)').matches; $('#sideBtn').textContent = hid ? '☰ Show panel' : '☰ Hide panel'; };
$('#sideBtn').onclick = () => { document.body.classList.toggle('noside'); try { localStorage.setItem('vocanote.noside', document.body.classList.contains('noside') ? '1' : ''); } catch (e) {} sideLabel(); setTimeout(relayout, 20); };
try { if (localStorage.getItem('vocanote.noside') && !matchMedia('(max-width: 900px)').matches) document.body.classList.add('noside'); } catch (e) {}
sideLabel(); matchMedia('(max-width: 900px)').addEventListener('change', sideLabel);
$('#zoom').onclick = e => { const b = e.target.closest('[data-z]'); if (b) zoom(+b.dataset.z); };
$('#grid').onclick = e => { const b = e.target.closest('[data-g]'); if (!b) return; P().grid[b.dataset.g] = !P().grid[b.dataset.g]; renderSide(); relayout(); };
$('#side').addEventListener('click', e => {
  const s = e.target.closest('[data-sec]');
  if (s) { addSection(s.dataset.sec === '*' ? { n: '*' } : SECTION_TYPES.find(t => t.n === s.dataset.sec), S.edit ? S.edit.beat : S.cursor); return; }
  const x = e.target.closest('.sec button');
  if (x) { pushUndo(); const id = x.closest('.sec').dataset.id; P().sections = P().sections.filter(q => q.id !== id); relayout(); }
});
$('#side').addEventListener('change', e => {
  const t = e.target, p = P();
  if (t.dataset.show) { p.show[t.dataset.show] = t.checked; relayout(); }
  else if (t.dataset.role) { p.roles[t.dataset.role] = t.value || null; refresh(); }
  else if (t.dataset.kind) { p.hidden[t.dataset.kind] = !t.checked; relayout(); }
  else if (t.dataset.col) { p.colors[t.dataset.col] = t.value; renderSide(); relayout(); }
  else if (t.id === 'follow') { p.follow = t.value; save(); }
  else if (t.id === 'guide') { p.guide = t.checked; engine.guideOn = t.checked; save(); }
  else if (t.id === 'bpm') { const v = +t.value; if (v >= 30 && v <= 300) { p.bpm = v; refresh(); } }
  else if (t.id === 'off') { p.offset = +t.value || 0; refresh(); }
  else if (t.closest('.sec')) { const s = p.sections.find(q => q.id === t.closest('.sec').dataset.id); if (!s) return; pushUndo(); if (t.type === 'color') s.color = t.value; else s.name = t.value.trim() || s.name; relayout(); }
});
const setOffset = v => { P().offset = Math.round(v * 100) / 100; refresh(); };
$('#offHere').onclick = () => { const sec = beatToSec(engine.beat()); engine.pause(); engine.pos = 0; S.cursor = 0; setOffset(sec); };
$('#offM').onclick = () => setOffset(P().offset - 60 / P().bpm);
$('#offP').onclick = () => setOffset(P().offset + 60 / P().bpm);
let taps = [];
$('#tap').onclick = () => { const n = performance.now(); if (taps.length && n - taps[taps.length - 1] > 2500) taps = []; taps.push(n); if (taps.length >= 4) { P().bpm = Math.round(60000 / ((n - taps[0]) / (taps.length - 1)) * 2) / 2; refresh(); } };

el.mini.onclick = e => { const i = e.target.dataset.i; if (i == null) return; closeEdit(); setCursor(S.rows[+i].start); el.stage.scrollTo({ top: Math.max(0, S.rowTops[+i] - 20), behavior: 'smooth' }); };
$('#wavewrap').addEventListener('pointerdown', e => { const r = S.rows[S.active]; if (!r) return; const x = e.clientX - el.wave.getBoundingClientRect().left; if (x < 0) return; const b = Math.min(r.end - EPS, r.start + x / S.ppb); S.cursor = b; engine.seek(b); updateLoop(); });

function sheetText(notes) {
  const out = [];
  S.rows.forEach(r => {
    const toks = P().tokens.filter(t => t.beat >= r.start - EPS && t.beat < r.end - EPS);
    if (r.secStart) out.push('', '[' + r.sec.name + ']');
    if (!toks.length) return;
    let line = '';
    for (const t of toks) line += t.rest ? '— ' : t.text + (notes && t.note != null ? '(' + pc(t.note) + ')' : '') + (t.join ? (notes ? '-' : '') : ' ');
    out.push(line.trim());
  });
  return out.join('\n').trim();
}
$('#sheetBtn').onclick = () => { $('#sheetText').value = sheetText($('#sheetNotes').checked) || 'No lyrics yet.'; $('#sheet').showModal(); };
$('#sheetNotes').onchange = e => $('#sheetText').value = sheetText(e.target.checked);
$('#sheetClose').onclick = () => $('#sheet').close();
$('#sheetCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#sheetText').value); toast('Copied.'); } catch (e) { $('#sheetText').select(); } };

$('#fileBtn').onclick = e => {
  const r = e.target.getBoundingClientRect();
  showMenu('<button class="mi" data-m="new">New (start empty)</button><button class="mi" data-m="import">Open a track or saved project…</button><button class="mi" data-m="export">Save to a file…</button><button class="mi" data-m="demo">Load the demo</button><div class="ml">Your lyrics also save on their own in this browser, per track.</div>', r.left, r.bottom + 6, async m => {
    if (m.m === 'export') { if (!(S.song || S.audio) && !P().tokens.length) return toast('Nothing to save yet. Open a track first.'); writeProj(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(P(), null, 1)], { type: 'application/json' })); a.download = ((S.song && S.song.name) || (S.audio && S.audio.name) || 'lyrics') + '.vocanote.json'; a.click(); toast('Saved to your Downloads folder. Open it later with File › Open, then open the track.'); }
    else if (m.m === 'import') $('#file').click();
    else if (m.m === 'demo') { if (!P().tokens.length || confirm('Replace what is here with the demo?')) loadDemo(); }
    else if (m.m === 'new' && (!(S.song || S.audio) || confirm('Start an empty project? Lyrics for the current track stay saved in this browser and come back when you reopen that track.'))) { engine.pause(); writeProj(); closeEdit(); S.song = null; S.audio = null; S.proj = defProj(); S.cursor = 0; S.undo = []; await idbSet('midi', null); await idbSet('audio', null); refresh(); }
  });
};

// ---------- files ----------
$('#pick').onclick = () => $('#file').click();
$('#file').onchange = async e => { for (const f of e.target.files) await openFile(f); e.target.value = ''; };
$('#demo').onclick = () => loadDemo();
addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', async e => { e.preventDefault(); document.body.classList.remove('dragging'); for (const f of e.dataTransfer.files) await openFile(f); });

function adoptSong(song, keepRoles) {
  S.song = song;
  const p = P();
  p.bpm = song.bpm; p.demo = song.kind === 'demo';
  const ids = new Set(song.tracks.map(t => t.id));
  if (!keepRoles || !Object.values(p.roles).some(id => ids.has(id))) p.roles = guessRoles(song.tracks);
  if (!p.sections.length && song.locators.length) song.locators.forEach((l, i) => { const ty = SECTION_TYPES.find(t => l.name.toLowerCase().includes(t.n.toLowerCase())); p.sections.push({ id: uid(), beat: l.beat, name: l.name, color: ty ? ty.c : SECTION_TYPES[i % 7].c }); });
}
async function loadAudio(file, analyze) {
  const buffer = await engine.ac().decodeAudioData(await file.arrayBuffer());
  const an = analyzeAudio(buffer);
  S.audio = { name: file.name.replace(/\.[^.]+$/, ''), buffer, peaks: an.peaks, onsets: an.onsets };
  if (analyze) { if (!S.song) { P().bpm = an.bpm; P().offset = an.offset; } else P().offset = 0; }
  return an;
}
async function openFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  document.body.classList.add('busy');
  try {
    engine.pause();
    if (ext === 'json') { const d = JSON.parse(await file.text()); if (!Array.isArray(d.tokens)) throw new Error('That file is not a Vocanote project.'); S.proj = Object.assign(defProj(), d); toast('Project loaded. Open the track to go with it.'); }
    else if (ext === 'als' || ext === 'mid' || ext === 'midi') {
      const song = ext === 'als' ? await parseAls(file) : await parseMidi(file);
      const had = switchProj(file.name), bpm = P().bpm;
      S.audio = null; await idbSet('audio', null);
      adoptSong(song, had); if (had) { P().bpm = bpm; toast('Picked up your saved lyrics for this track.'); }
      if (!S.song.tracks.some(t => t.notes.length)) toast('No MIDI notes found in that file. Audio-only sets need the bounced mp3.');
      await idbSet('midi', file);
    } else {
      const own = !S.song || P().demo; let had = false;
      if (own) { had = switchProj(file.name); S.song = null; await idbSet('midi', null); }
      const an = await loadAudio(file, !had);
      await idbSet('audio', file);
      toast(had ? 'Picked up your saved lyrics for this track.' : S.song ? 'Audio added to this set. If it is off the grid, adjust “Beat 1 at” under Tempo.' : `Tempo guessed at ${an.bpm} BPM. Fix it under Tempo if the grid is off.`);
    }
    refresh();
  } catch (err) { console.error(err); toast(err.message || 'Could not read that file.'); }
  document.body.classList.remove('busy');
}
function loadDemo() {
  engine.pause();
  S.proj = defProj(); S.audio = null; S.cursor = 0;
  const d = demoLyrics();
  P().tokens = d.tokens.map(t => ({ id: uid(), note: null, anchor: null, ...t }));
  P().sections = d.sections.map(s => ({ id: uid(), ...s }));
  adoptSong(demoSong(), false);
  idbSet('midi', null); idbSet('audio', null);
  refresh();
}

// ---------- boot ----------
async function boot() {
  try { const raw = localStorage.getItem('vocanote.proj'); if (raw) S.proj = Object.assign(defProj(), JSON.parse(raw)); } catch (e) {}
  for (const t of P().tokens) { if (!t.id) t.id = uid(); t.len = t.len || 0; }
  const q = new URLSearchParams(location.search).get('load');
  try {
    if (q) { for (const u of q.split(',')) { const r = await fetch(u); await openFile(new File([await r.blob()], u.split('/').pop())); } }
    else if (P().demo) adoptSong(demoSong(), true);
    else {
      const m = await idbGet('midi'), a = await idbGet('audio');
      if (m) adoptSong(/\.als$/i.test(m.name) ? await parseAls(m) : await parseMidi(m), true), P().bpm = JSON.parse(localStorage.getItem('vocanote.proj') || '{}').bpm || P().bpm;
      if (a) await loadAudio(a, false);
    }
  } catch (e) { console.error(e); }
  refresh();
  new ResizeObserver(() => { const w = Math.max(320, el.stage.clientWidth - GUT - 22); if (Math.abs(w - S.W) > 1 && S.rows.length) relayout(); }).observe(el.stage);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (S.rows.length) { renderRows(); drawWave(); } });
  engine.onend = () => setCursor(0);
  requestAnimationFrame(frame);
}
boot();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
