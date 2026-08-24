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

import { renderBed, wavBytes, loopify } from './synth.js';

/**
 * **아이폰에서는 볼륨이 안 먹는다.**
 *
 * iOS Safari 는 `HTMLMediaElement.volume` 이 읽기 전용이다 — 대입해도 예외 없이 조용히
 * 무시되고 항상 1 이다. 이 믹서는 전부 `el.volume` 위에 지어져 있어서, 아이폰에서는
 * 슬라이더도 덕킹도 하나도 듣지 않았다. 배경음이 늘 최대치로 나오고 나레이션(RMS 0.034 짜리
 * 속삭임)이 그 밑에 깔렸다 — "최소로 해도 너무너무 크고 목소리가 안 들린다"의 정체.
 *
 * Web Audio 의 GainNode 로 가면 될 일이지만 그 길은 막혀 있다 —
 * 화면을 끄면 iOS 가 AudioContext 를 정지시킨다 (CLAUDE.md 의 첫 번째 결정).
 * 그래서 그런 기기에서는 **볼륨을 파형에 구워서** 만든다.
 */
export const VOLUME_SETTABLE = (() => {
  try {
    const a = new Audio();
    a.volume = 0.5;
    return Math.abs(a.volume - 0.5) < 0.01;
  } catch { return false; }
})();

// DSP 는 종류당 한 번만 돌린다 (파도 44초 렌더가 200ms 넘는다).
// 볼륨을 바꿀 때는 이 PCM 을 다시 인코딩만 한다 — 그쪽이 훨씬 싸다.
const pcmCache = new Map();

export function bedUrl(kind, gain = 1) {
  let pcm = pcmCache.get(kind);
  if (!pcm) { pcm = renderBed(kind); pcmCache.set(kind, pcm); }
  return URL.createObjectURL(new Blob([wavBytes(pcm, gain)], { type: 'audio/wav' }));
}

/**
 * 실제 녹음 파일 → 이음매 없는 루프 Blob.
 * mp3 를 <audio loop> 로 바로 돌리면 인코더 패딩 때문에 루프마다 틈이 생긴다.
 * 디코드해서 꼬리를 감아 붙이고(synth.loopify) 합성과 같은 크기로 정규화한다.
 * 디코드는 재생이 아니라서 화면이 꺼져도 상관없다 — 재생은 여전히 <audio> 다.
 */
async function filePcm(src) {
  let pcm = pcmCache.get(src);
  if (pcm) return pcm;
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ac = new OfflineAudioContext(2, 8, 44100);   // 디코드 전용. 44.1k 로 리샘플된다
  const buf = await ac.decodeAudioData(await res.arrayBuffer());
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  pcm = loopify(L, R, buf.sampleRate);
  pcmCache.set(src, pcm);
  return pcm;
}

const pcmUrl = (pcm, gain = 1) =>
  URL.createObjectURL(new Blob([wavBytes(pcm, gain)], { type: 'audio/wav' }));

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

// ── 이음매 없는 루프 ──────────────────────────────────────

/**
 * `<audio loop>` 는 되감을 때 브라우저가 몇 ms~수십 ms 를 흘린다.
 * 파형의 꼬리와 머리는 이미 크로스페이드해 뒀는데도(synth.renderBed) 파도 44초·바람 36초마다
 * "뚝" 하고 끊겼다 다시 시작하는 것처럼 들리는 정체가 이것이다 — 백색소음은 아주 짧은
 * 무음도 클릭으로 들린다.
 *
 * 그래서 같은 소스를 엘리먼트 두 개로 번갈아 돌리고 끝나기 전에 등파워로 넘긴다.
 * Web Audio 그래프는 여전히 안 쓴다 — 화면이 꺼지면 iOS 가 AudioContext 를 정지시킨다.
 *
 * 바깥에서는 `<audio>` 하나처럼 보인다 (volume · play · pause · paused · src).
 */
const HANDOFF = 1.2;   // 넘겨주는 구간(초). 한 소리에 30~40초에 한 번뿐이라 넉넉히 준다

export class SeamlessLoop {
  constructor() {
    this.els = [new Audio(), new Audio()];
    this.i = 0;
    this._volume = 0;
    this._src = '';
    this._x = null;
    for (const el of this.els) {
      el.preload = 'none';
      el.volume = 0;
      el.loop = true;                 // 넘기기를 놓쳐도 무음으로 떨어지지 않게 하는 안전망
      el.addEventListener('timeupdate', () => this._tick());
    }
  }

  get paused() { return this.els[0].paused && this.els[1].paused; }
  get src() { return this._src; }
  set src(v) { this._src = v; for (const el of this.els) el.src = v; }

  /** 소스를 만들기 전에 목표 볼륨을 알려 둔다 — 0 으로 구웠다가 곧바로 다시 굽지 않게. */
  prime(v) { this._volume = clamp01(v); }

  /** 소스를 만드는 법을 받아 둔다 — 볼륨을 구워야 하는 기기에서 다시 부른다. */
  open(make) {
    this.make = make;
    this._baked = VOLUME_SETTABLE ? 1 : this._volume;
    this.src = make(this._baked);
  }

  get volume() { return this._volume; }
  set volume(v) {
    this._volume = clamp01(v);
    if (!VOLUME_SETTABLE) { this._bake(); return; }   // 아이폰 — 파형에 굽는다
    if (this._x) return;              // 넘겨주는 중 — 인터벌이 반영한다
    const el = this.els[this.i];
    if (!el.paused) el.volume = this._volume;
  }

  /**
   * 볼륨을 파형에 구워 소스를 갈아 끼운다. 같은 자리에서 이어 붙이므로 흐름은 유지된다.
   *
   * fade() 는 50ms 마다 볼륨을 쓰므로 그대로 받으면 초당 20번 다시 인코딩한다.
   * 그래서 멈춘 뒤 한 번만 굽는다 — 이 기기에서 페이드는 계단 하나가 된다.
   * 슬라이더·덕킹처럼 드물게 일어나는 일이라 그걸로 충분하다.
   */
  _bake() {
    clearTimeout(this._bt);
    this._bt = setTimeout(() => {
      if (!this.make || this._baked === this._volume) return;
      if (this._volume <= 0) return;              // 어차피 pause 로 끈다. 굽지 않는다
      this._baked = this._volume;
      const el = this.els[this.i];
      const at = el.currentTime || 0;
      const playing = !el.paused;
      const old = this._src;
      const ready = () => {
        el.removeEventListener('loadedmetadata', ready);
        if (Number.isFinite(el.duration) && el.duration > 0) el.currentTime = at % el.duration;
        if (playing) el.play().catch(() => {});
      };
      el.addEventListener('loadedmetadata', ready);
      this.src = this.make(this._volume);
      if (old) URL.revokeObjectURL(old);
    }, 150);
  }

  play() {
    const el = this.els[this.i];
    el.volume = this._volume;
    return el.play();
  }

  pause() {
    if (this._x) { clearInterval(this._x); this._x = null; }
    for (const el of this.els) { el.pause(); el.volume = 0; }
  }

  /** 끝이 다가오면 다음 엘리먼트를 띄우고 겹치는 동안 넘긴다. */
  _tick() {
    // 볼륨이 안 먹는 기기에서는 겹치기가 오히려 해가 된다 —
    // 둘 다 최대치로 나와서 넘기는 1.2초 동안 소리가 두 배가 된다.
    // 그런 기기는 el.loop 안전망에 맡긴다 (되감기 틈은 남지만 두 배보다 낫다).
    if (!VOLUME_SETTABLE) return;
    if (this._x) return;
    const cur = this.els[this.i];
    if (cur.paused || !Number.isFinite(cur.duration)) return;
    if (cur.duration - cur.currentTime > HANDOFF) return;

    const next = this.els[1 - this.i];
    next.currentTime = 0;
    next.volume = 0;
    next.play().catch(() => {});
    this.i = 1 - this.i;

    // 등파워(√) 로 넘긴다 — 무상관 노이즈를 선형으로 겹치면 가운데가 파인다.
    const t0 = Date.now();
    this._x = setInterval(() => {
      const t = Math.min(1, (Date.now() - t0) / (HANDOFF * 1000));
      next.volume = clamp01(this._volume * Math.sqrt(t));
      cur.volume = clamp01(this._volume * Math.sqrt(1 - t));
      if (t >= 1) {
        clearInterval(this._x);
        this._x = null;
        cur.pause();
        cur.currentTime = 0;
        next.volume = this._volume;
      }
    }, FADE_TICK);
  }
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
    const el = new SeamlessLoop();
    // 소리는 볼륨을 처음 올릴 때 만든다 — 10개를 미리 만들면 로딩이 멈춘다.
    const layer = { def, el, volume: 0, available: !!(def.generate || def.file), loading: null };
    this.layers.set(def.id, layer);
    return layer;
  }

  /** 소스 준비. file(실제 녹음) 우선, 실패하면 generate(합성)로 조용히 내려간다. */
  async _ensure(layer) {
    if (layer.el.src) return true;
    if (layer.loading) return layer.loading;
    const d = layer.def;
    layer.loading = (async () => {
      if (d.file) {
        try {
          const pcm = await filePcm(d.file);
          layer.el.open((g) => pcmUrl(pcm, g));
          return true;
        } catch { /* 오프라인 첫 방문 등 — 합성이 받친다 */ }
      }
      if (d.generate) {
        layer.el.open((g) => bedUrl(d.generate, g));
        return true;
      }
      layer.available = false;
      layer.onstate?.();
      return false;
    })();
    return layer.loading;
  }

  /** 슬라이더값 → 실제 엘리먼트 볼륨. 제곱 커브 — 귀는 로그로 듣는다.
   *  선형이면 슬라이더 초입부터 너무 크다 ("기본 배경음이 너무 커"의 원인).
   *  0.15 는 전체 마스터. "지금의 절반이면 되겠다"는 요청으로 0.30 에서 반으로 내렸다.
   *  수면 배경음은 "들리는 듯 마는 듯"이 맞고, 크게 듣고 싶으면 기기 볼륨이 있다.
   *
   *  덕킹 0.08 — 왜 이렇게까지 깊은가. VoxCPM 목소리는 속삭임이라 파일이 아주 작다:
   *  나레이션 mp3 의 RMS 가 0.027~0.109(중앙값 0.034), 피크는 0.15~0.40 밖에 안 된다.
   *  합성 배경음은 RMS 0.108 로 맞춰져 있으니 같은 볼륨이면 목소리가 배경의 1/3이다.
   *  게다가 광대역 소음은 속삭임을 RMS 비율보다 훨씬 심하게 덮는다 — 말은 짧은 봉우리에
   *  에너지가 몰려 있고 소음은 끊기지 않기 때문이다. 0.22 로도 "목소리가 안 들린다"가 두 번 나왔다. */
  _target(layer) {
    return layer.volume * layer.volume * 0.15 * (this.ducked ? 0.08 : 1);
  }

  setVolume(id, v) {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.volume = clamp01(v);
    if (layer.volume > 0) {
      if (!VOLUME_SETTABLE) layer.el.prime(this._target(layer));
      this._ensure(layer).then((ok) => {
        if (!ok || layer.volume <= 0) return;   // 준비되는 사이 꺼졌으면 재생하지 않는다
        if (layer.el.paused) {
          layer.el.volume = 0;
          // play() 거부를 전부 "음원 없음"으로 보면 안 된다. 슬라이더를 0 으로 내리자마자
          // 다시 올리면 AbortError, 자동재생이 아직 안 풀렸으면 NotAllowedError 가 나는데
          // 둘 다 소리가 없다는 뜻이 아니다. 그런데 여기서 available 을 내려 버려서
          // 프리셋에 든 레이어만 슬라이더가 영영 잠겼다 — "포함 안 된 것만 조절된다"의 정체.
          // 소스를 못 쓰는 경우(NotSupportedError)만 진짜 없는 것이다.
          layer.el.play().catch((e) => {
            if (e?.name !== 'NotSupportedError') return;
            layer.available = false;
            layer.onstate?.();
          });
        }
        fade(layer.el, this._target(layer), 1500);   // 400ms 는 소리가 "켜졌다". 스며들게 한다
      });
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
// 숫자 하나당 정확히 1.0초 (발화 + 침묵). 고정 침묵 0.5초로 했더니 발화 ~0.6초와
// 합쳐 1.1초가 되어 초읽기보다 느렸고, 호흡 게이지(1초)와도 어긋났다 —
// 방금 재생한 파일의 실제 길이를 빼서 남는 만큼만 쉰다.
const COUNT_CADENCE = 1.0;
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

// 숫자 세기("하나, 둘, 셋, 넷")는 특별 취급한다 — 실제 초처럼 한 박자에 하나씩
// 들려야 하므로, 문장 길이와 무관하게 쉼표에서 쪼개고 앞말에 붙이지 않는다.
// tools/chunking.py 의 COUNT 와 같은 목록이어야 한다.
const COUNT_WORDS = new Set(['하나', '둘', '셋', '넷', '다섯', '여섯']);
export const isCount = (t = '') => COUNT_WORDS.has(t.trim().replace(/[.,!?]+$/, ''));

const mergeShort = (parts) => parts.reduce((acc, p) => {
  if (acc.length && p.length < CLAUSE_MIN && !isCount(p) && !isCount(acc[acc.length - 1])) {
    acc[acc.length - 1] += ' ' + p;
  } else acc.push(p);
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
    const raw = clean(sentence.split(/(?<=,)\s+/));
    const hasCount = raw.some(isCount);
    if (sentence.length <= CLAUSE_SPLIT && !hasCount) {
      out.push({ text: sentence, end: true });
      continue;
    }
    const parts = mergeShort(raw);
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
  constructor({ gapSeconds = 6, sentenceGap = 4.2, volume = 0.9, voiceURI = null, rate = 0.82, pitch = 0.9 } = {}) {
    this.gapSeconds = gapSeconds;
    this.sentenceGap = sentenceGap;
    this.volume = volume;
    this.voiceURI = voiceURI;
    this.rate = rate;
    this.pitch = pitch;
    this.el = new Audio();
    this.el.preload = 'auto';
    this.stopped = false;
    this.paused = false;
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

  /** 침묵. 일시정지에 대비해 남은 시간을 들고 있는다 —
   *  멈췄다 이어 들을 때 남은 침묵부터 다시 흘러야 리듬이 안 깨진다. */
  _wait(ms) {
    return new Promise((r) => {
      this._resume = r;
      this._deadline = Date.now() + ms;
      this._timer = setTimeout(() => { this._resume = null; r(); }, ms);
    });
  }

  /** 말과 침묵을 그 자리에서 멈춘다. stop() 과 달리 이어 들을 수 있다. */
  pause() {
    if (this.paused || this.stopped) return;
    this.paused = true;
    this.el.pause();
    if (this._resume) {
      clearTimeout(this._timer);
      this._remain = Math.max(0, this._deadline - Date.now());
    }
    if ('speechSynthesis' in window) speechSynthesis.pause();
  }

  resume() {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    if (this._resume) {
      const r = this._resume;
      this._timer = setTimeout(() => { this._resume = null; r(); }, this._remain || 0);
    } else if (this.el.src) {
      this.el.play().catch(() => {});   // 파일 재생 중이었다 — ended 리스너가 그대로 받는다
    }
    if ('speechSynthesis' in window) speechSynthesis.resume();
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
      this.onChunk?.(chunks[i]?.text || '');
      await (useFiles ? this._file(parts[i]) : this._tts(parts[i]));
      if (this.stopped) return;
      if (i < parts.length - 1) {
        const c = chunks[i] || { text: '', end: true };
        // 다음 토막이 숫자면 세는 중이다 — 발화 길이를 빼고 정확히 1초 주기로 맞춘다
        if (chunks[i + 1] && isCount(chunks[i + 1].text)) {
          await this._wait(Math.max(0.2, COUNT_CADENCE - (this._lastDur || 0.55)) * 1000);
          continue;
        }
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
        // 숫자 세기 박자 계산용 — 방금 토막이 실제로 몇 초였는지
        this._lastDur = Number.isFinite(el.duration) ? el.duration : 0;
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
    this.paused = false;
    this._resume = null;
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
