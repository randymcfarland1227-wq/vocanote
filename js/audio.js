// Vocanote — playback engine. Plays the uploaded audio, or a small built-in synth for MIDI / Ableton sets.

const hz = p => 440 * Math.pow(2, (p - 69) / 12);

export class Engine {
  constructor() {
    this.ctx = null; this.buffer = null; this.bpm = 120; this.offset = 0;
    this.events = []; this.guide = []; this.guideOn = true;
    this.playing = false; this.pos = 0; this.loop = null; this.total = 16; this.vol = 0.8;
    this.onend = null;
  }
  ac() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain(); this.master.gain.value = this.vol;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, len);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  setVol(v) { this.vol = v; if (this.master) this.master.gain.value = v; }
  beat() { return this.playing ? this.b0 + (this.ctx.currentTime - this.t0) * this.bpm / 60 : this.pos; }
  stopNodes() {
    clearInterval(this.timer);
    if (this.bus) {
      const b = this.bus, now = this.ctx.currentTime;
      b.gain.setTargetAtTime(0, now, 0.012);
      setTimeout(() => { try { b.disconnect(); } catch (e) {} }, 150);
      this.bus = null;
    }
    if (this.src) { try { this.src.stop(); } catch (e) {} this.src = null; }
  }
  play(from = this.pos) {
    const ctx = this.ac();
    this.stopNodes();
    if (from >= this.total - 0.01) from = 0;
    this.bus = ctx.createGain(); this.bus.connect(this.master);
    this.b0 = from; this.t0 = ctx.currentTime + 0.06;
    if (this.buffer) {
      const src = ctx.createBufferSource(); src.buffer = this.buffer; src.connect(this.bus);
      const sec = this.offset + from * 60 / this.bpm;
      if (sec >= 0) src.start(this.t0, Math.min(sec, this.buffer.duration)); else src.start(this.t0 - sec, 0);
      this.src = src;
    }
    const first = arr => { let i = 0; while (i < arr.length && arr[i].t < from - 1e-4) i++; return i; };
    this.idx = first(this.events); this.gidx = first(this.guide);
    this.playing = true;
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
  }
  pause() { if (!this.playing) return; this.pos = Math.max(0, this.beat()); this.playing = false; this.stopNodes(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(b) { b = Math.max(0, Math.min(this.total, b)); if (this.playing) this.play(b); else this.pos = b; }
  tick() {
    const b = this.beat();
    if (this.loop && b >= this.loop[1] - 0.005) { this.play(this.loop[0]); return; }
    if (b >= this.total) { this.pause(); this.pos = 0; this.onend && this.onend(); return; }
    const ahead = b + 0.2 * this.bpm / 60, when = t => this.t0 + (t - this.b0) * 60 / this.bpm;
    const lim = this.loop ? this.loop[1] - 1e-4 : Infinity;
    if (!this.buffer) while (this.idx < this.events.length && this.events[this.idx].t < ahead) {
      const e = this.events[this.idx++];
      if (e.t < lim) this.voice(e, when(e.t));
    }
    while (this.gidx < this.guide.length && this.guide[this.gidx].t < ahead) {
      const e = this.guide[this.gidx++];
      if (this.guideOn && e.t < lim) this.tone(e.p, when(e.t), Math.max(0.12, e.d * 60 / this.bpm), 0.16);
    }
  }
  env(g, t, peak, dur, rel = 0.06) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.setValueAtTime(peak, t + Math.max(0.01, dur - rel));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.01);
  }
  osc(type, f, t, dur, dest) {
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    o.connect(dest); o.start(t); o.stop(t + dur + 0.05);
    return o;
  }
  nz(t, dur, type, freq, peak, out) {
    const ctx = this.ctx, s = ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, Math.random()); s.stop(t + dur + 0.02);
  }
  tone(p, t, dur, peak, out) {
    const ctx = this.ac(), g = ctx.createGain();
    g.connect(out || this.bus || this.master);
    this.env(g, t, peak, dur, 0.08);
    this.osc('sine', hz(p), t, dur, g);
    const g2 = ctx.createGain(); g2.gain.value = 0.35; g2.connect(g);
    this.osc('triangle', hz(p) * 2, t, dur, g2);
  }
  blip(p) { const ctx = this.ac(); this.tone(p, ctx.currentTime + 0.01, 0.28, 0.2, this.master); }
  voice(e, t) {
    const ctx = this.ctx, out = this.bus, v = (e.v || 100) / 127, spb = 60 / this.bpm;
    if (t < ctx.currentTime) t = ctx.currentTime;
    if (e.r === 'drum') {
      const k = e.k;
      if (k === 'kick') {
        const g = ctx.createGain(); g.connect(out);
        g.gain.setValueAtTime(0.9 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        const o = this.osc('sine', 150, t, 0.3, g); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      } else if (k === 'snare') {
        this.nz(t, 0.16, 'bandpass', 1900, 0.5 * v, out);
        const g = ctx.createGain(); g.connect(out);
        g.gain.setValueAtTime(0.3 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        this.osc('triangle', 190, t, 0.1, g);
      } else if (k === 'clap') this.nz(t, 0.14, 'bandpass', 1300, 0.5 * v, out);
      else if (k === 'hat') this.nz(t, 0.045, 'highpass', 7500, 0.22 * v, out);
      else if (k === 'openhat') this.nz(t, 0.26, 'highpass', 7000, 0.2 * v, out);
      else if (k === 'ride' || k === 'crash') this.nz(t, k === 'crash' ? 0.9 : 0.35, 'highpass', 5500, 0.16 * v, out);
      else if (k === 'tom') {
        const g = ctx.createGain(); g.connect(out);
        g.gain.setValueAtTime(0.6 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
        const o = this.osc('sine', 190, t, 0.26, g); o.frequency.exponentialRampToValueAtTime(95, t + 0.2);
      } else {
        const g = ctx.createGain(); g.connect(out);
        g.gain.setValueAtTime(0.25 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
        this.osc('triangle', 820, t, 0.08, g);
      }
      return;
    }
    const dur = Math.min(Math.max(0.08, e.d * spb), 8);
    const g = ctx.createGain(), f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.connect(g); g.connect(out);
    if (e.r === 'bass') {
      f.frequency.value = 520; this.env(g, t, 0.26 * v, dur);
      this.osc('sawtooth', hz(e.p), t, dur, f); this.osc('sine', hz(e.p), t, dur, f);
    } else {
      f.frequency.value = 1700; this.env(g, t, 0.05 * v, dur, 0.1);
      const a = this.osc('sawtooth', hz(e.p), t, dur, f); a.detune.value = -6;
      const b = this.osc('triangle', hz(e.p), t, dur, f); b.detune.value = 6;
    }
  }
}
