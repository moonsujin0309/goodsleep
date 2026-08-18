// 오디오 엔진 — 믹서 · 나레이션 재생 · 백그라운드 유지
//
// 재생은 전부 HTMLAudioElement 로 한다. Web Audio 그래프가 아니다.
// 이유: 모바일에서 화면을 끄면 iOS 가 AudioContext 를 정지시킨다. 수면 앱에서
// 화면을 켜둘 수는 없으므로, 음악 앱처럼 미디어 엘리먼트로 재생해야 밤새 살아남는다.
// 볼륨 믹싱은 각 엘리먼트의 .volume 으로 충분해서 Web Audio 가 아예 필요 없다.

const FADE_TICK = 50;

/** 볼륨 페이드. setInterval 을 쓴다 — rAF 는 백그라운드에서 멈춘다.
 *  진행은 틱 수가 아니라 벽시계로 잰다. 백그라운드 탭은 인터벌이 1초로 스로틀되는데,
 *  틱 수로 세면 60초 알람 램프가 20분이 된다 — "알람이 안 울렸다"의 정체. */
export function fade(el, to, ms, onDone) {
  if (el._fade) clearInterval(el._fade);
  const from = el.volume;
  if (ms <= 0) {
    el.volume = clamp01(to);
    onDone?.();
    return;
  }
  const t0 = Date.now();
  el._fade = setInterval(() => {
    const t = Math.min(1, (Date.now() - t0) / ms);
    el.volume = clamp01(from + (to - from) * t);
    if (t >= 1) {
      clearInterval(el._fade);
      el._fade = null;
      onDone?.();
    }
  }, FADE_TICK);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ── 사운드 합성 ────────────────────────────────────────────
//
// 합성 DSP 는 전부 synth.js 에 있다 (순수 모듈 — node 로도 렌더돼 검수용 파일을 뽑는다).
// 여기서는 브라우저 Blob URL 로 감싸기만 한다.

import { renderBed, wavBytes } from './synth.js';

export function bedUrl(kind) {
  return URL.createObjectURL(new Blob([wavBytes(renderBed(kind))], { type: 'audio/wav' }));
}

/** 무음 루프. 사운드를 하나도 안 켜도 탭이 살아 있어야 알람이 운다. */
function silentUrl(seconds = 5, rate = 8000) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// ── 믹서 ──────────────────────────────────────────────────

export class Mixer {
  constructor() {
    this.layers = new Map(); // id -> { el, volume, available }
    this.ducked = false;
    this.keepAlive = null;
    this.unlocked = false;
  }

  /** 첫 사용자 제스처에서 호출. 이후 프로그램 재생이 허용된다. */
  async unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    if (!this.keepAlive) {
      const el = new Audio(silentUrl());
      el.loop = true;
      el.volume = 0.001;
      this.keepAlive = el;
    }
    try { await this.keepAlive.play(); } catch { /* 무시 — 소리는 나머지가 낸다 */ }
  }

  /** 매니페스트의 레이어를 등록한다. 파일이 없으면 available=false 로 남는다. */
  add(def) {
    if (this.layers.has(def.id)) return this.layers.get(def.id);
    const el = new Audio();
    el.loop = true;
    el.preload = 'none';
    el.volume = 0;
    // 합성 레이어는 볼륨을 처음 올릴 때 만든다. 10개를 미리 만들면 로딩이 멈춘다.
    if (!def.generate) el.src = def.file;
    const layer = { def, el, volume: 0, available: !!def.generate };
    if (!def.generate) {
      el.addEventListener('canplay', () => { layer.available = true; layer.onstate?.(); }, { once: true });
      el.addEventListener('error', () => { layer.available = false; layer.onstate?.(); }, { once: true });
      el.preload = 'metadata';
      el.load();
    }
    this.layers.set(def.id, layer);
    return layer;
  }

  /** 슬라이더값 → 실제 엘리먼트 볼륨. 제곱 커브 — 귀는 로그로 듣는다.
   *  선형이면 슬라이더 초입부터 너무 크다 ("기본 배경음이 너무 커"의 원인). */
  _target(layer) {
    return layer.volume * layer.volume * (this.ducked ? 0.45 : 1);
  }

  setVolume(id, v) {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.volume = clamp01(v);
    if (layer.volume > 0) {
      if (layer.def.generate && !layer.el.src) layer.el.src = bedUrl(layer.def.generate);
      if (layer.el.paused) {
        layer.el.volume = 0;
        layer.el.play().catch(() => { layer.available = false; layer.onstate?.(); });
      }
      fade(layer.el, this._target(layer), 400);
    } else {
      fade(layer.el, 0, 500, () => layer.el.pause());
    }
  }

  /** 나레이션이 나오는 동안 배경을 낮춘다. */
  duck(on) {
    this.ducked = on;
    for (const l of this.layers.values()) {
      if (l.volume > 0) fade(l.el, this._target(l), 1200);
    }
  }

  activeIds() {
    return [...this.layers.values()].filter((l) => l.volume > 0).map((l) => l.def.id);
  }

  fadeAllOut(ms = 8000) {
    for (const l of this.layers.values()) {
      if (!l.el.paused) fade(l.el, 0, ms, () => l.el.pause());
    }
  }

  stopAll() {
    for (const l of this.layers.values()) {
      if (l._fade) clearInterval(l._fade);
      l.el.pause();
      l.volume = 0;
      l.el.volume = 0;
    }
    this.keepAlive?.pause();
  }
}

// ── 나레이션 재생 ─────────────────────────────────────────

/**
 * 문장을 나눈다.
 *
 * 이게 수면 나레이션의 핵심이다. TTS 모델은 대화용으로 최적화돼 있어서
 * 문장 사이 긴 침묵을 오류로 보고 자동으로 줄인다. 한 덩어리로 읽히면
 * 수면 유도가 아니라 오디오북이 된다.
 * 그래서 문장 단위로 끊어 읽히고 침묵은 우리가 직접 넣는다.
 * 어떤 엔진을 쓰든 이 방식이면 침묵이 정확히 원하는 길이로 들어간다.
 */
export function splitSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?。])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const CLAUSE_MIN = 8;     // 이보다 짧은 토막은 앞에 붙인다
const CLAUSE_SPLIT = 22;  // 이보다 긴 문장은 쉼표에서 나눈다
// 연결어미 쪼개기는 시도했다가 버렸다. 문법적으로는 맞는 호흡 자리인데
// 실제로 들으면 툭툭 끊긴다. 0 이면 끈다 (tools/chunking.py 와 같은 값이어야 한다).
const CONNECT_SPLIT = 0;

// 연결어미 뒤 — 한국어에서 원래 숨을 쉬는 자리다.
// '서'는 뺐다 ('에서', '으로서' 같은 조사에서 잘못 끊긴다).
// '~다고', '~라고' 는 인용이라 제외한다 — 끊으면 서술어가 반토막 난다.
const CONNECTIVE = /(면|고|며|는데|지만|다가|거나|니까)(\s+)/g;
const isHangul = (c) => c >= '가' && c <= '힣';

/** tools/chunking.py 의 _split_connective 와 같은 알고리즘이어야 한다. */
function splitConnective(s) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(CONNECTIVE)) {
    const head = m.index;
    if (head === 0 || !isHangul(s[head - 1])) continue;
    if (m[1] === '고' && (s[head - 1] === '다' || s[head - 1] === '라')) continue;
    out.push(s.slice(last, head + m[1].length).trim());
    last = head + m[0].length;
  }
  out.push(s.slice(last).trim());
  return out.filter(Boolean);
}

const mergeShort = (parts) => parts.reduce((acc, p) => {
  if (acc.length && p.length < CLAUSE_MIN) acc[acc.length - 1] += ' ' + p;
  else acc.push(p);
  return acc;
}, []);

const clean = (arr) => arr.map((p) => p.trim()).filter(Boolean);

/**
 * 문장을 다시 쉼표와 연결어미에서 나눈다. tools/chunking.py 와 같은 규칙이다.
 *
 * 말 속도에는 바닥이 있다 — 0.69 아래로 내리면 자음 조음이 뭉개져 혀 꼬인 소리가 난다.
 * 그래서 남은 느림은 전부 쉼에서 가져와야 한다.
 *
 * end=true 면 문장이 끝난 자리(긴 쉼), false 면 문장 안(짧은 쉼)이다.
 */
export function splitChunks(text) {
  const out = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.length <= CLAUSE_SPLIT) {
      out.push({ text: sentence, end: true });
      continue;
    }
    const parts = mergeShort(clean(sentence.split(/(?<=,)\s+/)));
    const finer = [];
    for (const p of parts) {
      if (CONNECT_SPLIT && p.length > CONNECT_SPLIT) finer.push(...mergeShort(splitConnective(p)));
      else finer.push(p);
    }
    finer.forEach((p, i) => out.push({ text: p, end: i === finer.length - 1 }));
  }
  return out;
}

/**
 * 문장 길이에 따른 침묵 배수.
 *
 * 처음엔 len/24 로 비례시켰다. 그건 틀렸다 — 대본은 뒤로 갈수록 문장이 짧아지도록
 * 설계돼 있어서, 침묵이 가장 길어야 할 구간(이완·심상·소실)에서 오히려 줄어들었다.
 * 짧게 끊어야 할 것은 "걱정." 같은 한두 단어 열거뿐이므로 거기만 따로 잘라낸다.
 */
export function sentenceScale(text = '') {
  const n = text.length;
  if (n < 7) return 0.45;                       // "걱정." 같은 열거
  return Math.min(1, Math.max(0.82, n / 26));
}

/**
 * 층마다 침묵이 길어진다. 이게 "점점 느려진다"는 감각을 만드는 진짜 장치다.
 * 말의 속도를 늦추면 타임스트레치라 음질이 망가지지만 침묵은 아무것도 망가뜨리지 않는다.
 * 정착 1.0 에서 소실 2.5 까지 2.5배로 벌어지는 동안 듣는 사람은 자기가 느려진다고 느낀다.
 */
export const LAYER_GAP = {
  settle: 1.0, breath: 1.2, release: 1.45, drift: 1.75, fade: 2.1,
  intro: 1.0, body: 1.2, outro: 1.45,      // 아직 3층인 상태들
};

/** 기기에 있는 한국어 음성 목록. 기기마다 크게 다르다. */
export function koreanVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('ko'));
}

/**
 * 조각을 순서대로 재생하고 사이에 침묵을 둔다.
 * files 가 있으면 문장별 오디오, file 이면 통 오디오, 없으면 브라우저 내장 TTS.
 * TTS 는 오디오 파일이 채워지기 전까지의 임시 경로다 — 백그라운드 재생은 안 된다.
 */
export class NarrationPlayer {
  constructor({ gapSeconds = 6, sentenceGap = 3.2, volume = 0.9, voiceURI = null, rate = 0.82, pitch = 0.9 } = {}) {
    this.gapSeconds = gapSeconds;
    this.sentenceGap = sentenceGap;
    this.volume = volume;
    this.voiceURI = voiceURI;
    this.rate = rate;
    this.pitch = pitch;
    this.el = new Audio();
    this.el.preload = 'auto';
    this.stopped = false;
    this._timer = null;
  }

  async play(picks, { onPiece, onEnd } = {}) {
    this.stopped = false;
    for (let i = 0; i < picks.length; i++) {
      if (this.stopped) return;
      onPiece?.(picks[i], i, picks.length);
      await this._speak(picks[i]);
      if (this.stopped) return;
      if (i < picks.length - 1) await this._wait(this.gapSeconds * 1000);
    }
    if (!this.stopped) onEnd?.();
  }

  _wait(ms) {
    return new Promise((r) => { this._timer = setTimeout(r, ms); });
  }

  /**
   * 조각 하나 = 문장 여러 개. 문장 사이에 짧은 침묵을 둔다.
   *
   * 침묵 길이는 방금 읽은 문장 길이에 비례한다. "걱정. 계획. 후회." 같은
   * 한 단어짜리 열거 뒤에 온전한 2.4초를 넣으면 리듬이 끊긴다 —
   * 짧은 것 뒤엔 한 박자, 긴 문장 뒤엔 한 호흡.
   */
  async _speak(piece) {
    const useFiles = !!(piece.files?.length || piece.file);
    // 침묵은 원문 토막으로 계산한다 — 파일 경로 길이는 아무 뜻이 없다.
    // 생성기(tools/tts.py)도 같은 규칙으로 쪼개므로 파일과 토막이 1:1 로 맞는다.
    const chunks = splitChunks(piece.text);
    const parts = piece.files?.length ? piece.files
      : piece.file ? [piece.file]
      : chunks.map((c) => c.text);
    const layerGap = LAYER_GAP[piece.layer] ?? 1;

    for (let i = 0; i < parts.length; i++) {
      if (this.stopped) return;
      await (useFiles ? this._file(parts[i]) : this._tts(parts[i]));
      if (this.stopped) return;
      if (i < parts.length - 1) {
        const c = chunks[i] || { text: '', end: true };
        // 문장 안의 쉼표는 문장 끝보다 짧게 쉰다
        const kind = c.end ? 1 : 0.45;
        await this._wait(this.sentenceGap * sentenceScale(c.text) * layerGap * kind * 1000);
      }
    }
  }

  _file(src) {
    return new Promise((resolve) => {
      const el = this.el;
      el.src = src;
      el.volume = this.volume;
      const done = () => {
        el.removeEventListener('ended', done);
        el.removeEventListener('error', done);
        resolve();
      };
      el.addEventListener('ended', done);
      el.addEventListener('error', done);
      el.play().catch(done);
    });
  }

  _tts(text) {
    return new Promise((resolve) => {
      if (!text || !('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = this.rate;     // 수면 나레이션은 느리게
      u.pitch = this.pitch;
      u.volume = this.volume;
      const voices = koreanVoices();
      const picked = voices.find((v) => v.voiceURI === this.voiceURI) || voices[0];
      if (picked) u.voice = picked;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._timer);
    if (this.el._fade) clearInterval(this.el._fade);
    this.el.pause();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}

// ── 알람 ──────────────────────────────────────────────────

/** 무음에서 60초에 걸쳐 올라온다. 놀라서 깨는 것과 자연히 깨는 것은 다르다.
 *  소리는 노이즈가 아니라 차임 — 9초 루프에 3음 아르페지오 + 침묵. */
export function createAlarm() {
  const el = new Audio(bedUrl('chime'));
  el.loop = true;
  el.volume = 0;
  return {
    el,
    start(rampMs = 60000) {
      // 0.02 로 시작하면 첫 1분이 사실상 무음이라 "알람이 안 울렸다"가 된다.
      // 속삭임 정도(0.15)에서 시작해 램프한다 — 자연히 깨되, 들리기는 바로 들리게.
      el.volume = 0.15;
      el.play().catch(() => {});
      fade(el, 1, rampMs);
    },
    stop() {
      if (el._fade) clearInterval(el._fade);
      el.pause();
      el.volume = 0;
    },
  };
}

// ── 잠금화면 연동 ─────────────────────────────────────────

export function setMediaSession({ title, artist, onPause, onPlay }) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist });
  try {
    navigator.mediaSession.setActionHandler('pause', onPause || null);
    navigator.mediaSession.setActionHandler('play', onPlay || null);
  } catch { /* 일부 브라우저는 미지원 */ }
}
