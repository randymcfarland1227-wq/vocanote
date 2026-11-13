// Vocanote — file parsing and music analysis. Everything is in beats (quarter notes).

export const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const pc = n => NAMES[((n % 12) + 12) % 12];
export const octave = n => Math.floor(n / 12) - 2; // Ableton naming: C3 = 60

export const KIND_ORDER = ['kick', 'snare', 'clap', 'rim', 'hat', 'openhat', 'tom', 'ride', 'crash', 'perc', 'hit'];
export const KIND_LABEL = { kick: 'Kick', snare: 'Snare', clap: 'Clap', rim: 'Rim', hat: 'Hi-hat', openhat: 'Open hat', tom: 'Tom', ride: 'Ride', crash: 'Crash', perc: 'Perc', hit: 'Hit', chord: 'Chords', bass: 'Bass' };
export const KIND_COLORS = { kick: '#f5c518', hat: '#ff8a3d', snare: '#ff4d6d', clap: '#ff7ab8', rim: '#c9a27a', openhat: '#ffb86b', tom: '#8f7cff', ride: '#58c7f3', crash: '#7ee0c3', perc: '#9aa0a6', hit: '#d8d4c8', chord: '#6cb6ff', bass: '#5fe0a0' };

const GM = { 35: 'kick', 36: 'kick', 37: 'rim', 38: 'snare', 39: 'clap', 40: 'snare', 41: 'tom', 42: 'hat', 43: 'tom', 44: 'hat', 45: 'tom', 46: 'openhat', 47: 'tom', 48: 'tom', 49: 'crash', 50: 'tom', 51: 'ride', 52: 'crash', 53: 'ride', 55: 'crash', 57: 'crash', 59: 'ride' };

export function drumKind(name, pitch) {
  const n = (name || '').toLowerCase();
  if (n) {
    if (/kick|\bbd\b|bass ?drum|808/.test(n)) return 'kick';
    if (/clap/.test(n)) return 'clap';
    if (/rim|stick/.test(n)) return 'rim';
    if (/snare|\bsd\b|\bsnr\b/.test(n)) return 'snare';
    if (/(open|ohh)/.test(n) && /(hat|hh)/.test(n)) return 'openhat';
    if (/hat|\bhh\b|hihat/.test(n)) return 'hat';
    if (/tom/.test(n)) return 'tom';
    if (/ride/.test(n)) return 'ride';
    if (/crash|cymbal/.test(n)) return 'crash';
    if (/perc|wood|shaker|conga|bongo|shell|cow|tamb/.test(n)) return 'perc';
  }
  return GM[pitch] || 'perc';
}

// ---------- chords ----------
const TPL = [
  ['', [0, 4, 7]], ['m', [0, 3, 7]], ['5', [0, 7]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]],
  ['7', [0, 4, 7, 10]], ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]],
  ['add9', [0, 2, 4, 7]], ['m9', [0, 2, 3, 7, 10]], ['9', [0, 2, 4, 7, 10]], ['dim', [0, 3, 6]], ['aug', [0, 4, 8]],
];
export function chordName(pitches) {
  if (!pitches.length) return '';
  const bass = Math.min(...pitches) % 12;
  const set = new Set(pitches.map(p => p % 12));
  if (set.size === 1) return NAMES[bass];
  let best = null;
  for (let root = 0; root < 12; root++) {
    if (!set.has(root)) continue;
    TPL.forEach(([suf, iv], ti) => {
      let hit = 0;
      for (const i of iv) if (set.has((root + i) % 12)) hit++;
      const score = hit * 2 - (set.size - hit) * 2 - (iv.length - hit) * 2.4 + (root === bass ? 0.9 : 0) - ti * 0.02;
      if (!best || score > best.score) best = { score, root, suf };
    });
  }
  return NAMES[best.root] + best.suf + (best.root !== bass ? '/' + NAMES[bass] : '');
}

export const tidy = t => { const g = Math.round(t * 8) / 8; return Math.abs(g - t) < 0.035 ? g : t; };

export function chordEvents(notes) {
  const ns = [...notes].sort((a, b) => a.t - b.t);
  const out = [];
  let i = 0, last = null;
  while (i < ns.length) {
    const T = ns[i].t;
    while (i < ns.length && ns[i].t < T + 0.2) i++;
    const act = [];
    for (let j = 0; j < i; j++) if (ns[j].t + ns[j].d > T + 0.21 || ns[j].t >= T) act.push(ns[j].p);
    const name = chordName(act);
    out.push({ t: tidy(T), name, changed: name !== last });
    last = name;
  }
  return out;
}

export function guessRoles(tracks) {
  const roles = { chords: null, bass: null, drums: null };
  const stats = tracks.map(t => {
    const on = new Map();
    let sum = 0;
    for (const n of t.notes) { on.set(Math.round(n.t * 16), (on.get(Math.round(n.t * 16)) || 0) + 1); sum += n.p; }
    return { t, poly: t.notes.length / Math.max(1, on.size), mean: sum / Math.max(1, t.notes.length), nm: (t.name + ' ' + (t.device || '')).toLowerCase() };
  }).filter(s => s.t.notes.length);
  const d = stats.find(s => s.t.isDrum) || stats.find(s => /drum|kit|perc|beat|break/.test(s.nm));
  if (d) roles.drums = d.t.id;
  const rest = stats.filter(s => s !== d);
  const b = rest.find(s => /bass|sub|808/.test(s.nm)) || rest.filter(s => s.poly < 1.2 && s.mean < 50).sort((a, c) => a.mean - c.mean)[0];
  if (b) roles.bass = b.t.id;
  const c = rest.filter(s => s !== b).sort((a, c2) => (c2.poly + (/pad|key|piano|chord|organ|rhodes|strings/.test(c2.nm) ? 1 : 0)) - (a.poly + (/pad|key|piano|chord|organ|rhodes|strings/.test(a.nm) ? 1 : 0)))[0];
  if (c) roles.chords = c.t.id;
  return roles;
}

const finish = (song) => {
  let end = 0;
  for (const t of song.tracks) { t.notes.sort((a, b) => a.t - b.t); for (const n of t.notes) end = Math.max(end, n.t + n.d); }
  song.lengthBeats = end;
  return song;
};

// ---------- Ableton .als (gzipped XML) ----------
const kid = (el, path) => {
  for (const n of path.split('/')) {
    if (!el) return null;
    let f = null;
    for (const c of el.children) if (c.tagName === n) { f = c; break; }
    el = f;
  }
  return el;
};
const V = (el, path) => { const e = path ? kid(el, path) : el; return e ? e.getAttribute('Value') : null; };

function clipNotes(clip, session) {
  const out = [];
  const ls = +V(clip, 'Loop/LoopStart') || 0, le = +V(clip, 'Loop/LoopEnd') || 0;
  const loopOn = V(clip, 'Loop/LoopOn') === 'true', sr = +V(clip, 'Loop/StartRelative') || 0;
  const cs = session ? 0 : +V(clip, 'CurrentStart'), ce = session ? le - ls : +V(clip, 'CurrentEnd');
  const L = ce - cs, ll = le - ls;
  if (!(L > 0)) return out;
  for (const kt of clip.getElementsByTagName('KeyTrack')) {
    const p = +V(kt, 'MidiKey');
    for (const ev of kt.getElementsByTagName('MidiNoteEvent')) {
      if (ev.getAttribute('IsEnabled') === 'false') continue;
      const t = +ev.getAttribute('Time'), d = +ev.getAttribute('Duration'), v = +ev.getAttribute('Velocity') || 100;
      if (loopOn && ll > 0) {
        if (t < ls - 1e-6 || t >= le) continue;
        for (let x = t - ls - sr; x < L; x += ll) if (x >= -1e-6) out.push({ t: cs + Math.max(0, x), d: Math.min(d, L - x), p, v });
      } else {
        const x = t - ls;
        if (x >= -1e-6 && x < L) out.push({ t: cs + Math.max(0, x), d: Math.min(d, L - x), p, v });
      }
    }
  }
  return out;
}

export async function parseAls(file) {
  let text;
  try {
    text = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } catch (e) { text = await file.text(); }
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const ls = kid(doc.documentElement, 'LiveSet');
  if (!ls) throw new Error('This does not look like an Ableton Live set.');
  const song = { kind: 'als', name: file.name.replace(/\.als$/i, '').trim(), bpm: 120, num: 4, den: 4, tracks: [], locators: [] };
  const tempo = V(ls, 'MainTrack/DeviceChain/Mixer/Tempo/Manual') || V(ls, 'MasterTrack/DeviceChain/Mixer/Tempo/Manual');
  if (tempo) song.bpm = Math.round(+tempo * 100) / 100;
  let sig = false;
  for (const tr of kid(ls, 'Tracks').children) {
    if (tr.tagName !== 'MidiTrack') continue;
    const name = (V(tr, 'Name/EffectiveName') || 'Track').replace(/^\d+-/, '');
    const devs = kid(tr, 'DeviceChain/DeviceChain/Devices');
    let device = '';
    if (devs && devs.children.length) device = V(devs.children[0], 'UserName') || devs.children[0].tagName.replace(/Device$/, '');
    const pads = {};
    for (const b of tr.getElementsByTagName('DrumBranch')) {
      const rn = V(b, 'BranchInfo/ReceivingNote');
      if (rn != null) pads[128 - +rn] = V(b, 'Name/EffectiveName') || V(b, 'Name/UserName') || '';
    }
    const isDrum = Object.keys(pads).length > 0 || /drum|kit\b/i.test(name);
    let notes = [];
    const ev = kid(tr, 'DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events');
    const clips = ev ? [...ev.children].filter(c => c.tagName === 'MidiClip') : [];
    for (const c of clips) notes.push(...clipNotes(c, false));
    if (!clips.length) {
      const sc = tr.getElementsByTagName('MidiClip')[0];
      if (sc) notes = clipNotes(sc, true);
    }
    const anyClip = clips[0] || tr.getElementsByTagName('MidiClip')[0];
    if (anyClip && !sig) {
      const ts = anyClip.getElementsByTagName('RemoteableTimeSignature')[0];
      if (ts) { song.num = +V(ts, 'Numerator') || 4; song.den = +V(ts, 'Denominator') || 4; sig = true; }
    }
    song.tracks.push({ id: 't' + tr.getAttribute('Id'), name, device, notes, isDrum, pads });
  }
  for (const cp of ls.getElementsByTagName('CuePoint')) song.locators.push({ beat: +V(cp, 'Time'), name: V(cp, 'Name') || 'Section' });
  song.locators.sort((a, b) => a.beat - b.beat);
  return finish(song);
}

// ---------- Standard MIDI file ----------
export async function parseMidi(file) {
  const buf = await file.arrayBuffer();
  const d = new DataView(buf);
  let p = 0;
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p++)); return s; };
  if (str(4) !== 'MThd') throw new Error('This does not look like a MIDI file.');
  const hl = d.getUint32(p); p += 4;
  const ntr = d.getUint16(p + 2), div = d.getUint16(p + 4); p += hl;
  if (div & 0x8000) throw new Error('This MIDI file uses SMPTE timing, which is not supported.');
  const song = { kind: 'midi', name: file.name.replace(/\.midi?$/i, ''), bpm: null, num: 4, den: 4, tracks: [], locators: [] };
  let sig = false;
  for (let ti = 0; ti < ntr && p < d.byteLength - 8; ti++) {
    const id = str(4), len = d.getUint32(p); p += 4;
    const end = p + len;
    if (id !== 'MTrk') { p = end; continue; }
    let tick = 0, run = 0, name = '';
    const open = new Map(), byCh = new Map();
    const vlq = () => { let v = 0, b; do { b = d.getUint8(p++); v = (v << 7) | (b & 127); } while (b & 128); return v; };
    while (p < end) {
      tick += vlq();
      let st = d.getUint8(p);
      if (st & 0x80) { p++; if (st < 0xf0) run = st; } else st = run;
      if (st === 0xff) {
        const type = d.getUint8(p++), l = vlq();
        if (type === 3 && !name) name = new TextDecoder().decode(new Uint8Array(buf, p, l));
        else if (type === 0x51 && song.bpm == null) song.bpm = Math.round(6e9 / ((d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2))) / 100;
        else if (type === 0x58 && !sig) { song.num = d.getUint8(p); song.den = 1 << d.getUint8(p + 1); sig = true; }
        else if (type === 6) song.locators.push({ beat: tick / div, name: new TextDecoder().decode(new Uint8Array(buf, p, l)) });
        p += l;
      } else if (st === 0xf0 || st === 0xf7) { p += vlq(); }
      else {
        const ch = st & 15, hi = st & 0xf0;
        if (hi === 0x90 || hi === 0x80) {
          const k = d.getUint8(p++), v = d.getUint8(p++), key = ch * 128 + k;
          const o = open.get(key);
          if (o) { o.d = Math.max(tick / div - o.t, 0.02); open.delete(key); }
          if (hi === 0x90 && v > 0) {
            const n = { t: tick / div, d: 0.25, p: k, v };
            open.set(key, n);
            if (!byCh.has(ch)) byCh.set(ch, []);
            byCh.get(ch).push(n);
          }
        } else if (hi === 0xc0 || hi === 0xd0) p += 1; else p += 2;
      }
    }
    p = end;
    for (const [ch, notes] of byCh) {
      const isDrum = ch === 9 || /drum|kit\b|perc/i.test(name) || /drum/i.test(song.name);
      song.tracks.push({ id: 'm' + ti + '_' + ch, name: name || (isDrum ? 'Drums' : 'Track ' + (song.tracks.length + 1)), device: '', notes, isDrum, pads: {} });
    }
  }
  if (song.bpm == null) {
    const m = file.name.match(/(\d{2,3})\s*bpm/i);
    song.bpm = m ? +m[1] : 120;
  }
  return finish(song);
}

// ---------- audio analysis ----------
export const PEAK_RATE = 100; // peaks per second

export function analyzeAudio(buffer) {
  const sr = buffer.sampleRate, hop = Math.round(sr / PEAK_RATE);
  const n = Math.floor(buffer.length / hop);
  const a = buffer.getChannelData(0), b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const peaks = new Float32Array(n), rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let mx = 0, e = 0;
    const o = i * hop;
    for (let j = 0; j < hop; j += 2) {
      const s = b ? (a[o + j] + b[o + j]) * 0.5 : a[o + j];
      const ab = s < 0 ? -s : s;
      if (ab > mx) mx = ab;
      e += s * s;
    }
    peaks[i] = mx; rms[i] = Math.sqrt(e / (hop / 2));
  }
  // onset strength
  const f = new Float32Array(n);
  let fmax = 0;
  for (let i = 1; i < n; i++) { f[i] = Math.max(0, rms[i] - rms[i - 1]); if (f[i] > fmax) fmax = f[i]; }
  const onsets = [];
  for (let i = 4; i < n - 4; i++) {
    let mean = 0;
    for (let j = -12; j <= 12; j++) mean += f[Math.min(n - 1, Math.max(0, i + j))];
    mean /= 25;
    if (f[i] > mean * 2.2 + fmax * 0.06 && f[i] >= f[i - 1] && f[i] >= f[i + 1] && f[i] >= f[i - 2] && f[i] >= f[i + 2] && f[i] > f[i - 3] && f[i] >= f[i + 3]) {
      if (!onsets.length || i / PEAK_RATE - onsets[onsets.length - 1] > 0.07) onsets.push(i / PEAK_RATE);
    }
  }
  // tempo: comb over the autocorrelation of onset strength
  const N = Math.min(n, 120 * PEAK_RATE), maxLag = Math.min(N - 1, 760);
  const ac = new Float32Array(maxLag + 2);
  for (let l = 20; l <= maxLag; l++) { let s = 0; for (let i = 0; i + l < N; i++) s += f[i] * f[i + l]; ac[l] = s / (N - l); }
  const at = x => { const i = Math.floor(x); return i + 1 > maxLag ? 0 : ac[i] + (ac[i + 1] - ac[i]) * (x - i); };
  let bpm = 120, bs = -1;
  for (let c = 70; c <= 175; c += 0.5) {
    const per = 60 / c * PEAK_RATE;
    let s = 0, k = 0;
    for (let m = 1; m <= 8 && per * m < maxLag; m++) { s += at(per * m); k++; }
    s = s / Math.max(1, k) * (1 - Math.abs(c - 115) / 400);
    if (s > bs) { bs = s; bpm = c; }
  }
  if (Math.abs(bpm - Math.round(bpm)) <= 0.5) bpm = Math.round(bpm);
  const per = 60 / bpm * PEAK_RATE;
  let ph = 0, ps = -1;
  for (let o = 0; o < per; o++) { let s = 0; for (let x = o; x < N; x += per) s += f[Math.round(x)] || 0; if (s > ps) { ps = s; ph = o; } }
  let offset = ph / PEAK_RATE;
  const first = onsets.length ? onsets[0] : 0;
  while (offset < first - 0.05) offset += 60 / bpm;
  return { peaks, onsets, bpm, offset: Math.round(offset * 100) / 100 };
}

export function midiPeaks(tracks, bpm, lengthBeats) {
  const spb = 60 / bpm, n = Math.ceil(lengthBeats * spb * PEAK_RATE) + 1;
  const arr = new Float32Array(n);
  for (const t of tracks) for (const nt of t.notes) {
    const i0 = Math.round(nt.t * spb * PEAK_RATE);
    const amp = (nt.v / 127) * (t.isDrum ? 1 : 0.45);
    const len = t.isDrum ? 14 : Math.min(400, Math.max(6, Math.round(nt.d * spb * PEAK_RATE)));
    const tau = t.isDrum ? 4 : len / 1.6;
    for (let j = 0; j < len && i0 + j < n; j++) arr[i0 + j] += amp * Math.exp(-j / tau);
  }
  let mx = 0;
  for (let i = 0; i < n; i++) if (arr[i] > mx) mx = arr[i];
  if (mx > 0) for (let i = 0; i < n; i++) arr[i] = Math.pow(arr[i] / mx, 0.7);
  return arr;
}

// ---------- built-in demo ----------
export function demoSong() {
  const chords = [[57, 61, 64], [58, 62, 65], [62, 66, 69], [60, 64, 67]];
  const pad = [], bass = [], drums = [];
  for (let bar = 0; bar < 8; bar++) {
    const c = chords[bar % 4], t0 = bar * 4;
    for (const p of c) pad.push({ t: t0, d: 3.9, p, v: 90 });
    for (const o of [0.75, 2.25, 3]) bass.push({ t: t0 + o, d: 0.4, p: c[0] - 24, v: 105 });
    for (const o of [0, 0.5, 1.5, 2, 3, 3.5]) drums.push({ t: t0 + o, d: 0.1, p: 36, v: 115 });
    for (const o of [1, 3]) drums.push({ t: t0 + o, d: 0.1, p: 38, v: 110 });
    if (bar >= 4) for (let o = 0; o < 4; o += 0.5) drums.push({ t: t0 + o, d: 0.05, p: 42, v: 70 });
  }
  return finish({
    kind: 'demo', name: 'Now I’m talking to you (demo)', bpm: 100, num: 4, den: 4, locators: [],
    tracks: [
      { id: 'd1', name: 'Digi Pad', device: 'Pad', notes: pad, isDrum: false, pads: {} },
      { id: 'd2', name: 'Fifth Bass', device: 'Bass', notes: bass, isDrum: false, pads: {} },
      { id: 'd3', name: 'Young Blood Kit', device: 'Drum Rack', notes: drums, isDrum: true, pads: { 36: 'Kick', 38: 'Snare', 42: 'Hihat Closed' } },
    ],
  });
}
export const demoLyrics = () => ({
  tokens: [
    { beat: 0, text: 'Now', len: 1, note: 66, anchor: 'kick' },
    { beat: 1.5, text: 'I’m', len: 0, note: 66, anchor: 'kick' },
    { beat: 2, text: 'talk', len: 0, note: 66, join: true, anchor: 'kick' },
    { beat: 2.5, text: 'ing', len: 0, note: 67 },
    { beat: 3, text: '', len: 0.5, rest: true },
    { beat: 3.5, text: 'to', len: 0, note: 69, anchor: 'kick' },
    { beat: 4, text: 'you', len: 1.5, note: 64, anchor: 'chord' },
  ],
  sections: [{ beat: 0, name: 'Verse', color: '#818cf8' }, { beat: 16, name: 'Chorus', color: '#fb7185' }],
});

// Key guess from MIDI notes (Krumhansl profiles, weighted by note length). Returns e.g. "A minor" or null.
export function guessKey(tracks) {
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const h = new Array(12).fill(0); let n = 0;
  for (const t of tracks) for (const x of t.notes) { h[((x.p % 12) + 12) % 12] += Math.max(0.1, Math.min(4, x.d || 0.25)); n++; }
  if (n < 4) return null;
  const corr = (prof, root) => { let mh = 0, mp = 0; for (let i = 0; i < 12; i++) { mh += h[i] / 12; mp += prof[i] / 12; } let a = 0, b = 0, c = 0; for (let i = 0; i < 12; i++) { const x = h[(i + root) % 12] - mh, y = prof[i] - mp; a += x * y; b += x * x; c += y * y; } return a / Math.sqrt(b * c || 1); };
  let best = null;
  for (let r = 0; r < 12; r++) for (const [prof, q] of [[MAJ, 'major'], [MIN, 'minor']]) { const v = corr(prof, r); if (!best || v > best.v) best = { v, name: NAMES[r] + ' ' + q }; }
  return best.name;
}
