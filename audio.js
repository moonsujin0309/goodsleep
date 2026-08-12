// 오디오 엔진 — 믹서 · 나레이션 재생 · 백그라운드 유지
//
// 재생은 전부 HTMLAudioElement 로 한다. Web Audio 그래프가 아니다.
// 이유: 모바일에서 화면을 끄면 iOS 가 AudioContext 를 정지시킨다. 수면 앱에서
// 화면을 켜둘 수는 없으므로, 음악 앱처럼 미디어 엘리먼트로 재생해야 밤새 살아남는다.
// 볼륨 믹싱은 각 엘리먼트의 .volume 으로 충분해서 Web Audio 가 아예 필요 없다.

const FADE_TICK = 50;

/** 볼륨 페이드. setInterval 을 쓴다 — rAF 는 백그라운드에서 멈춘다. */
export function fade(el, to, ms, onDone) {
  if (el._fade) clearInterval(el._fade);
  const from = el.volume;
  const steps = Math.max(1, Math.round(ms / FADE_TICK));
  let i = 0;
  if (ms <= 0) {
    el.volume = clamp01(to);
    onDone?.();
    return;
  }
  el._fade = setInterval(() => {
    i++;
    const t = Math.min(1, i / steps);
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
// 소리를 파일로 받지 않고 만든다. 이유가 셋 있다.
//   1) 라이선스. Mixkit·Pixabay 같은 무료 라이브러리는 "소스 파일과 함께 재배포"를
//      금지한다 — 공개 저장소에 mp3 를 올리는 것이 정확히 거기 걸린다.
//      합성한 소리는 라이선스가 아예 존재하지 않는다.
//   2) 이음매. 녹음 루프는 몇 분마다 툭 끊긴다. 조용한 방에서 그게 제일 거슬린다.
//      아래 파형은 끝과 시작이 수학적으로 이어지므로 이음매가 없다.
//   3) 용량. 밖에서 모바일 데이터로 여는 앱이다. 0바이트가 가장 빠르다.
//
// 주기 성분은 전부 cyc() 로 만든다 — 루프 길이당 정수 배 주기라 파형이 감길 때
// 위상이 정확히 맞는다. 이게 없으면 물결·팬 소리에서 주기마다 턱이 생긴다.

const LENGTHS = { waves: 30, fire: 30, crickets: 30 };   // 나머지는 20초

function generateBed(kind, n) {
  const d = new Float32Array(n);
  const TAU = Math.PI * 2;
  const cyc = (k, i) => (TAU * k * i) / n;      // 루프당 정확히 k 주기
  const w = () => Math.random() * 2 - 1;
  let b = 0, lp = 0, lp2 = 0, env = 0;

  switch (kind) {
    case 'white':
      for (let i = 0; i < n; i++) d[i] = w();
      break;

    case 'brown':
      for (let i = 0; i < n; i++) { b = (b + 0.02 * w()) / 1.02; d[i] = b * 3.5; }
      break;

    case 'pink': {                                // Paul Kellet 근사
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const x = w();
        b0 = 0.99886 * b0 + x * 0.0555179;
        b1 = 0.99332 * b1 + x * 0.0750759;
        b2 = 0.969 * b2 + x * 0.153852;
        b3 = 0.8665 * b3 + x * 0.3104856;
        b4 = 0.55 * b4 + x * 0.5329522;
        b5 = -0.7616 * b5 - x * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11;
        b6 = x * 0.115926;
      }
      break;
    }

    case 'rain':                                  // 하이패스 히스 + 물방울 클릭
      for (let i = 0; i < n; i++) {
        const x = w();
        lp2 += 0.004 * (x - lp2);
        lp += 0.35 * (x - lp2 - lp);
        let s = lp * 0.9;
        if (env <= 0 && Math.random() < 0.0018) env = 1;
        if (env > 0) { s += w() * env * env * 0.45; env -= 0.022; }
        d[i] = s;
      }
      break;

    case 'waves':                                 // 브라운 노이즈에 느린 너울
      for (let i = 0; i < n; i++) {
        b = (b + 0.02 * w()) / 1.02;
        const a = Math.pow(0.5 + 0.5 * Math.sin(cyc(2, i) - Math.PI / 2), 1.9);
        const c = Math.pow(0.5 + 0.5 * Math.sin(cyc(3, i) + 1.1), 2);
        const swell = 0.2 + 0.8 * (0.65 * a + 0.35 * c);
        const x = w();
        lp += 0.3 * (x - lp);
        d[i] = (b * 3.0 + (x - lp) * 0.35 * swell) * swell;   // 마루에서 부서지는 거품
      }
      break;

    case 'wind':                                  // 돌풍에 따라 컷오프가 움직인다
      for (let i = 0; i < n; i++) {
        b = (b + 0.02 * w()) / 1.02;
        const gust = 0.28 + 0.72
          * Math.pow(0.5 + 0.5 * Math.sin(cyc(2, i) + 0.4), 2)
          * (0.6 + 0.4 * (0.5 + 0.5 * Math.sin(cyc(5, i))));
        lp += (0.03 + 0.1 * gust) * (b * 3.2 - lp);
        d[i] = lp * gust * 1.5;
      }
      break;

    case 'fire': {                                // 낮은 웅웅 + 불규칙한 탁탁
      let crack = 0, big = 0;
      for (let i = 0; i < n; i++) {
        b = (b + 0.02 * w()) / 1.02;
        const x = w();
        lp += 0.12 * (x - lp);
        let s = b * 1.9 + lp * 0.25;
        if (crack <= 0 && Math.random() < 0.0026) crack = 1;
        if (crack > 0) { s += w() * crack * crack * 0.8; crack -= 0.06; }
        if (big <= 0 && Math.random() < 0.00012) big = 1;
        if (big > 0) { s += w() * big * big * 1.6; big -= 0.012; }
        d[i] = s;
      }
      break;
    }

    case 'stream':                                // 밝은 대역 + 물 흐르는 흔들림
      for (let i = 0; i < n; i++) {
        const x = w();
        lp += 0.5 * (x - lp);
        lp2 += 0.02 * (x - lp2);
        const gurgle = 0.78 + 0.22 * Math.sin(cyc(7, i)) * Math.sin(cyc(11, i));
        d[i] = (lp - lp2) * 1.1 * gurgle;
      }
      break;

    case 'crickets': {                            // 세 마리가 서로 다른 박자로
      const bugs = [
        { k: 62, f: 4300, o: 0.0 },
        { k: 74, f: 4900, o: 0.33 },
        { k: 49, f: 3800, o: 0.66 },
      ];
      const rate = n / (LENGTHS.crickets || 30);
      for (const bug of bugs) {
        const period = n / bug.k;
        const pulse = Math.round(rate * 0.018);   // 처프 하나 18ms
        for (let i = 0; i < n; i++) {
          const t = (i + bug.o * period) % period;
          const idx = Math.floor(t / pulse);
          if (idx > 5 || idx % 2 === 1) continue; // 3연속 처프 후 침묵
          const local = t - idx * pulse;
          const shape = Math.sin((local / pulse) * Math.PI);
          d[i] += Math.sin((TAU * bug.f * i) / rate) * shape * shape * 0.22;
        }
      }
      break;
    }

    case 'fan': {                                 // 넓은 바람 + 낮은 험 + 날개
      const rate = n / 20;
      for (let i = 0; i < n; i++) {
        b = (b + 0.02 * w()) / 1.02;
        lp += 0.08 * (b * 3.2 - lp);
        const hum = Math.sin(cyc(Math.round((n / rate) * 100), i)) * 0.06;
        const blade = 1 + 0.07 * Math.sin(cyc(Math.round((n / rate) * 22), i));
        d[i] = (lp * 1.7 + hum) * blade;
      }
      break;
    }

    default:
      for (let i = 0; i < n; i++) d[i] = w();
  }
  return d;
}

const TARGET_RMS = 0.13;

/**
 * 이음매 없는 루프용 WAV. 끝 f 샘플을 앞으로 감아 크로스페이드한다.
 *
 * 정규화는 피크가 아니라 RMS 기준이다. 피크로 맞추면 모닥불(RMS 0.05)과
 * 백색 소음(RMS 0.385)이 같은 슬라이더 값에서 7배 차이로 들린다 —
 * 사람 귀는 피크가 아니라 평균 에너지로 크기를 느낀다.
 * 대신 모닥불의 탁탁 같은 순간 피크가 튀므로 tanh 로 부드럽게 눌러 준다.
 * 여유를 0.68 까지 두는 이유: 22050Hz 를 기기 샘플레이트로 리샘플링할 때
 * 보간이 원 파형 위로 넘친다. 꽉 채우면 재생 시점에 클리핑된다.
 */
export function bedUrl(kind, seconds = LENGTHS[kind] || 20, rate = 22050) {
  const n = seconds * rate;
  const f = Math.floor(rate * 0.5);
  const src = generateBed(kind, n + f);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = src[i];
  for (let j = 0; j < f; j++) {
    const t = j / f;
    out[j] = src[j] * t + src[n + j] * (1 - t);
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;                                    // 브라운 노이즈는 DC 가 떠 있다
  let sum = 0;
  for (let i = 0; i < n; i++) { out[i] -= mean; sum += out[i] * out[i]; }
  const rms = Math.sqrt(sum / n);
  const gain = rms > 0 ? TARGET_RMS / rms : 1;
  // 0.58: 모닥불의 탁탁 같은 날카로운 과도 신호는 리샘플링에서 20% 가까이 넘친다.
  // 0.68 로 두면 재생 시점에 피크가 1.08 까지 올라가 클리핑됐다.
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i] * gain * 1.5) * 0.58;

  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, out[i])) * 32767, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
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

  setVolume(id, v) {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.volume = clamp01(v);
    const target = layer.volume * (this.ducked ? 0.45 : 1);
    if (layer.volume > 0) {
      if (layer.def.generate && !layer.el.src) layer.el.src = bedUrl(layer.def.generate);
      if (layer.el.paused) {
        layer.el.volume = 0;
        layer.el.play().catch(() => { layer.available = false; layer.onstate?.(); });
      }
      fade(layer.el, target, 400);
    } else {
      fade(layer.el, 0, 500, () => layer.el.pause());
    }
  }

  /** 나레이션이 나오는 동안 배경을 낮춘다. */
  duck(on) {
    this.ducked = on;
    for (const l of this.layers.values()) {
      if (l.volume > 0) fade(l.el, l.volume * (on ? 0.45 : 1), 1200);
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
 * 조각을 순서대로 재생하고 사이에 침묵을 둔다.
 * file 이 있으면 오디오, 없으면 브라우저 내장 TTS 로 읽는다.
 * TTS 는 오디오 파일이 채워지기 전까지의 임시 경로다 — 백그라운드 재생은 안 된다.
 */
export class NarrationPlayer {
  constructor({ gapSeconds = 6, volume = 0.9 } = {}) {
    this.gapSeconds = gapSeconds;
    this.volume = volume;
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

  _speak(piece) {
    if (piece.file) {
      return new Promise((resolve) => {
        const el = this.el;
        el.src = piece.file;
        el.volume = this.volume;
        const done = () => { cleanup(); resolve(); };
        const cleanup = () => {
          el.removeEventListener('ended', done);
          el.removeEventListener('error', done);
        };
        el.addEventListener('ended', done);
        el.addEventListener('error', done);
        el.play().catch(done);
      });
    }
    return this._tts(piece.text);
  }

  _tts(text) {
    return new Promise((resolve) => {
      if (!text || !('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = 0.78;   // 수면 나레이션은 느리게
      u.pitch = 0.92;
      u.volume = this.volume;
      const ko = speechSynthesis.getVoices().find((v) => v.lang?.startsWith('ko'));
      if (ko) u.voice = ko;
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

/** 무음에서 60초에 걸쳐 올라온다. 놀라서 깨는 것과 자연히 깨는 것은 다르다. */
export function createAlarm() {
  const el = new Audio(bedUrl('pink', 8, 22050));
  el.loop = true;
  el.volume = 0;
  return {
    el,
    start(rampMs = 60000) {
      el.volume = 0.02;
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
