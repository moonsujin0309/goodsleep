// 사운드 합성 v2 — 순수 DSP. 브라우저 API를 쓰지 않는다 (node 로도 렌더된다).
//
// 파일 대신 합성하는 이유 (v1과 같다):
//   1) 라이선스 — 무료 라이브러리는 "소스 파일과 함께 재배포"를 금지한다. 합성은 라이선스가 없다.
//   2) 이음매 — mp3 <audio loop> 는 인코더 패딩 때문에 루프마다 툭 끊긴다. 여기는 없다.
//   3) 용량 — 저장소 0바이트.
//
// v1 → v2 에서 바뀐 것:
//   모노 22050Hz → 스테레오 44100Hz. 모노는 이어폰에서 소리가 머리 안에 갇히고,
//   22050Hz 는 11kHz 위가 아예 없어서 비·시냇물의 '공기'가 죽는다.
//   물방울·장작·풀벌레를 백색노이즈 버스트가 아니라 감쇠 사인(공명체)으로 만든다 —
//   실제 물방울 소리는 '탁'이 아니라 '통'이다.
//
// 루프 규칙:
//   주기 성분은 cyc()(루프당 정수 주기)로, 넓은 텍스처는 꼬리 크로스페이드로 잇는다.
//   이벤트(처프·종소리 등 성긴 것)는 크로스페이드 구간을 피해 배치한다 —
//   섞이면 유령 이벤트가 생긴다. 촘촘한 이벤트(빗방울)는 섞여도 티가 안 난다.

export const RATE = 44100;

export const LENGTHS = {
  rain: 36, waves: 44, fire: 36, wind: 36, stream: 28, crickets: 36,
  fan: 20, white: 12, pink: 12, brown: 12, chime: 9,
  // 천둥은 길게 — 한 바퀴에 우르릉이 두세 번뿐이라 짧으면 같은 자리에서 또 친다
  thunder: 60, cabin: 24, cave: 40,
};

const TAU = Math.PI * 2;
const w = () => Math.random() * 2 - 1;
const r01 = () => Math.random();

/** 감쇠 사인 하나를 버퍼에 더한다. 물방울·장작·종은 전부 이것이다.
 *  버퍼 끝을 넘는 꼬리는 앞으로 감긴다 — 이벤트 버퍼는 루프 길이(n)라서
 *  이음매 근처의 이벤트가 잘리지 않고 자연스럽게 이어진다. */
function ping(buf, at, freq, decaySec, amp, rate, attackSec = 0.002) {
  const len = Math.min(buf.length, Math.round(decaySec * 6 * rate));
  const atk = Math.max(1, Math.round(attackSec * rate));
  const k = 1 / (decaySec * rate);
  for (let j = 0; j < len; j++) {
    const env = (j < atk ? j / atk : 1) * Math.exp(-j * k);
    buf[(at + j) % buf.length] += Math.sin(TAU * freq * j / rate) * env * amp;
  }
}

/** 두 채널에 등파워 팬으로 이벤트를 넣는다. pan: -1(왼쪽)~1(오른쪽) */
function panPing(L, R, at, freq, decaySec, amp, rate, pan, attackSec) {
  const a = (pan + 1) * Math.PI / 4;              // 0..π/2
  ping(L, at, freq, decaySec, amp * Math.cos(a), rate, attackSec);
  ping(R, at, freq, decaySec, amp * Math.sin(a), rate, attackSec);
}

/**
 * 노이즈 클릭 — 장작 탁탁 같은 '깨지는' 소리.
 * 감쇠 사인만 쓰면 전자음 '삐' 가 된다. 부러지는 소리는 광대역이다.
 * bright: 0(둔탁)~1(날카로움). 원포울 필터 계수로 그대로 쓴다.
 */
function panNoise(L, R, at, lenSec, amp, rate, pan, bright = 0.5) {
  const len = Math.max(4, Math.round(lenSec * rate));
  const a = (pan + 1) * Math.PI / 4;
  const gL = Math.cos(a), gR = Math.sin(a);
  const k = 5 / len;
  let lp = 0;
  for (let j = 0; j < len; j++) {
    const env = (j < 3 ? j / 3 : 1) * Math.exp(-j * k);
    lp += bright * (w() - lp);
    const s = lp * env * amp;
    const idx = (at + j) % L.length;
    L[idx] += s * gL;
    R[idx] += s * gR;
  }
}

// ── 생성기 ────────────────────────────────────────────────
// 각 함수는 [bedL, bedR, evL?, evR?] 를 돌려준다.
//   bed — m 샘플(루프 n + 크로스페이드 f). 넓은 텍스처. 꼬리를 크로스페이드로 잇는다.
//   ev  — n 샘플 원형 버퍼. 빗방울·장작·처프 같은 이벤트. 꼬리가 루프 시작으로
//         감기므로 이음매에서 잘리지도, 크로스페이드에 지워지지도 않는다.
// 이 분리가 "루프가 급작스럽다"를 없애는 핵심이다 — 이벤트를 bed 에 섞고
// 크로스페이드하면 이음매 근처 이벤트가 반쯤 지워지며 티가 난다.

function genNoise(kind, m, rate) {
  const L = new Float32Array(m), R = new Float32Array(m);
  for (const d of [L, R]) {                       // 채널을 따로 돌린다 — 비상관이 곧 공간감
    if (kind === 'white') {
      for (let i = 0; i < m; i++) d[i] = w();
    } else if (kind === 'brown') {
      let b = 0;
      for (let i = 0; i < m; i++) { b = (b + 0.02 * w()) / 1.02; d[i] = b * 3.5; }
    } else {                                      // pink — Paul Kellet 근사
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < m; i++) {
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
    }
  }
  return [L, R];
}

function genRain(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);

  // 층 1 — 히스(빗줄기 전체). 하이패스한 백색을 위쪽만 살짝 눌러 디지털 쏘는 맛을 뺀다.
  // 층 2 — 중역 워시(젖은 길에 닿는 뭉개진 소리). 느린 너울(cyc)로 밀도가 숨쉰다.
  const swell = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    swell[i] = 0.8
      + 0.13 * Math.sin(TAU * 3 * i / n)
      + 0.07 * Math.sin(TAU * 7 * i / n + 2.1);
  }
  for (const d of [L, R]) {
    let hp = 0, lp = 0, mid = 0, rumble = 0;
    for (let i = 0; i < m; i++) {
      const x = w();
      hp += 0.06 * (x - hp);                      // ~450Hz 아래 제거용 추적값
      lp += 0.55 * ((x - hp) - lp);               // top 을 살짝 둥글린다
      mid += 0.018 * (x - mid);                   // ~130Hz 워시
      rumble = (rumble + 0.015 * w()) / 1.015;
      d[i] = (lp * 0.62 + mid * 1.4 + rumble * 0.5) * swell[i];
    }
  }

  // 층 3 — 개별 빗방울. '탁'(짧은 틱)과 '통'(공명 드립)을 섞는다. 원형 버퍼로.
  const evL = new Float32Array(n), evR = new Float32Array(n);
  const ticks = Math.round((n / rate) * 26);      // 초당 26개
  for (let e = 0; e < ticks; e++) {
    const at = Math.floor(r01() * n);
    panPing(evL, evR, at, 2600 + r01() * 5200, 0.004 + r01() * 0.01,
      0.05 + r01() * r01() * 0.16, rate, w(), 0.0006);
  }
  const drips = Math.round((n / rate) * 1.6);     // 처마 물방울 — 성기고 낮고 둥글게
  for (let e = 0; e < drips; e++) {
    const at = Math.floor(r01() * n);
    panPing(evL, evR, at, 620 + r01() * 1400, 0.03 + r01() * 0.05,
      0.05 + r01() * 0.07, rate, w() * 0.8, 0.003);
  }
  return [L, R, evL, evR];
}

function genWaves(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);

  // 파도 하나 = 빠르게 부서지고(히스) 천천히 물러난다(저역 워시).
  // 부서짐은 파도마다 좌우 위치가 다르다(해변을 따라 움직인다) — 채널별 포락선.
  // 물러나는 저역은 방향감이 없으므로 공유한다.
  // 포락선은 길이 n 원형 버퍼다 — 마지막 파도의 긴 꼬리가 루프 시작으로 감겨
  // 이음매에서 레벨이 뚝 떨어지지 않는다.
  const crashL = new Float32Array(n), crashR = new Float32Array(n);
  const washEnv = new Float32Array(n);
  const count = 5;
  let t = 0.05 + r01() * 0.03;
  for (let c = 0; c < count; c++) {
    const at = Math.min(Math.floor(t * n), n - 1);
    const pan = (c % 2 === 0 ? -1 : 1) * (0.25 + r01() * 0.35);
    const gL = Math.cos((pan + 1) * Math.PI / 4);
    const gR = Math.sin((pan + 1) * Math.PI / 4);
    const attack = Math.round((0.5 + r01() * 0.4) * rate);
    const kCrash = 1 / ((2.2 + r01() * 1.2) * rate);
    const kWash = 1 / ((4.5 + r01() * 1.5) * rate);
    const span = Math.min(n, Math.round(9 * rate));
    for (let j = 0; j < span; j++) {
      const a = j < attack ? Math.pow(j / attack, 2) : Math.exp(-(j - attack) * kCrash);
      const ww = j < attack ? Math.pow(j / attack, 1.5) : Math.exp(-(j - attack) * kWash);
      const idx = (at + j) % n;
      crashL[idx] += a * gL;
      crashR[idx] += a * gR;
      washEnv[idx] += ww;
    }
    // 다음 파도까지 6~10초 — 규칙적이면 기계가 된다
    t += (0.7 + r01() * 0.45) * (1 / count);
  }

  for (const [d, crash] of [[L, crashL], [R, crashR]]) {
    let b = 0, lp = 0, foam = 0;
    for (let i = 0; i < m; i++) {
      b = (b + 0.02 * w()) / 1.02;                // 먼바다 웅웅 — 항상 있다
      const x = w();
      foam += 0.42 * (x - foam);                  // 부서질 때만 커지는 밝은 거품
      lp += 0.05 * (x - lp);
      const wash = washEnv[i % n];                // 크로스페이드 구간도 같은 포락선을 본다
      d[i] = b * (1.1 + 2.2 * wash)
        + (x - foam) * 0.34 * crash[i % n]
        + lp * 0.5 * wash;
    }
  }
  return [L, R];
}

function genFire(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);

  for (const d of [L, R]) {                       // 층 1 — 낮은 화염 웅웅 + 옅은 히스
    let b = 0, lp = 0;
    for (let i = 0; i < m; i++) {
      b = (b + 0.02 * w()) / 1.02;
      const x = w();
      lp += 0.10 * (x - lp);
      d[i] = b * 1.6 + lp * 0.16;
    }
  }

  const evL = new Float32Array(n), evR = new Float32Array(n);
  // 층 2 — 잔가지 탁탁. 감쇠 사인으로 했더니 전자음 '삐' 가 됐다 —
  // 부러지는 소리는 광대역 노이즈 클릭이고, 울림은 그 뒤에 아주 약하게만 붙는다.
  const snaps = Math.round((n / rate) * 9);
  for (let e = 0; e < snaps; e++) {
    const at = Math.floor(r01() * n);
    const pan = w() * 0.9;
    const amp = 0.15 + r01() * r01() * 0.45;
    panNoise(evL, evR, at, 0.006 + r01() * 0.014, amp, rate, pan, 0.45 + r01() * 0.4);
    if (r01() < 0.35)                             // 가끔 나무 울림이 살짝 남는다
      panPing(evL, evR, at + 2, 1400 + r01() * 2400, 0.005 + r01() * 0.006, amp * 0.25, rate, pan, 0.001);
    if (r01() < 0.25)                             // 쩍- 하고 두 번 갈라지는 것
      panNoise(evL, evR, at + Math.round((0.015 + r01() * 0.03) * rate),
        0.005 + r01() * 0.008, amp * 0.6, rate, pan, 0.5);
  }
  // 층 3 — 옹이 터지는 중간 톡. 둔탁한 클릭 + 낮은 몸통 울림.
  const knots = Math.round((n / rate) * 1.2);
  for (let e = 0; e < knots; e++) {
    const at = Math.floor(r01() * n);
    const pan = w() * 0.7;
    panNoise(evL, evR, at, 0.03 + r01() * 0.04, 0.3 + r01() * 0.2, rate, pan, 0.18);
    panPing(evL, evR, at + 3, 320 + r01() * 380, 0.02 + r01() * 0.02, 0.10, rate, pan, 0.002);
  }
  // 층 4 — 드물게 큰 장작 무너짐: 저역 쿵 + 불티 촤르륵 (전부 노이즈 틱)
  const bigs = Math.max(2, Math.round(n / rate / 9));
  for (let e = 0; e < bigs; e++) {
    const at = Math.floor(r01() * n);
    const pan = w() * 0.5;
    panPing(evL, evR, at, 95 + r01() * 50, 0.14, 0.4, rate, pan, 0.005);
    panNoise(evL, evR, at, 0.12, 0.25, rate, pan, 0.12);
    for (let s = 0; s < 12; s++) {
      const off = Math.floor(r01() * r01() * 0.5 * rate);
      panNoise(evL, evR, at + off, 0.003 + r01() * 0.006,
        0.10 * (1 - s / 14), rate, pan + w() * 0.3, 0.75);
    }
  }
  return [L, R, evL, evR];
}

function genStream(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);
  // 시냇물 = 좁은 대역 몇 개가 제각기 흔들리며 보글거리는 것.
  // 공명체(2극 밴드패스)에 노이즈를 흘리고, 느린 워블로 밴드마다 밀도를 흔든다.
  const bands = [
    { f: 420, g: 0.9, pan: -0.5, w1: 5, w2: 13 },
    { f: 950, g: 1.0, pan: 0.4, w1: 7, w2: 11 },
    { f: 1900, g: 0.7, pan: -0.2, w1: 9, w2: 17 },
    { f: 3600, g: 0.45, pan: 0.55, w1: 11, w2: 19 },
    { f: 7200, g: 0.22, pan: 0.0, w1: 13, w2: 23 },
  ];
  for (const band of bands) {
    const rPole = 1 - TAU * band.f * 0.22 / rate;         // 대역폭 ~22%
    const c = 2 * rPole * Math.cos(TAU * band.f / rate);
    const r2 = rPole * rPole;
    const aL = Math.cos((band.pan + 1) * Math.PI / 4);
    const aR = Math.sin((band.pan + 1) * Math.PI / 4);
    let y1 = 0, y2 = 0;
    const ph = r01() * TAU;
    for (let i = 0; i < m; i++) {
      const wob = 0.62
        + 0.28 * Math.sin(TAU * band.w1 * i / n + ph)
        * Math.sin(TAU * band.w2 * i / n + ph * 2)
        + 0.10 * Math.sin(TAU * 3 * i / n + ph);
      const y = c * y1 - r2 * y2 + w() * 0.9;
      y2 = y1; y1 = y;
      const s = y * band.g * wob * 0.045;
      L[i] += s * aL;
      R[i] += s * aR;
    }
  }
  // 잔 물방울 — 아주 가끔, 아주 작게
  const evL = new Float32Array(n), evR = new Float32Array(n);
  const plips = Math.round((n / rate) * 0.8);
  for (let e = 0; e < plips; e++) {
    panPing(evL, evR, Math.floor(r01() * n), 900 + r01() * 1800,
      0.02 + r01() * 0.03, 0.04 + r01() * 0.04, rate, w() * 0.7, 0.002);
  }
  return [L, R, evL, evR];
}

function genCrickets(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);

  // 층 1 — 밤공기. 처프가 침묵 위에 뜨면 합성 티가 바로 난다.
  for (const d of [L, R]) {
    let lp = 0, lp2 = 0;
    for (let i = 0; i < m; i++) {
      const x = w();
      lp += 0.012 * (x - lp);
      lp2 += 0.10 * (x - lp2);
      d[i] = lp * 1.4 + (lp2 - lp) * 0.05;
    }
  }

  // 층 2 — 벌레들. 처프 = 짧은 펄스 3~4개 묶음. 실제와 다른 점을 없앤 것들:
  //   펄스마다 피치가 살짝 미끄러진다 / 묶음마다 세기가 다르다 /
  //   가끔 한 박자 쉰다 / 먼 녀석은 작고 어둡다(고역 감쇠 대신 진폭만 줄여도 충분).
  const bugs = [
    { f: 4200, period: 0.52, pulses: 3, amp: 0.30, pan: -0.6 },
    { f: 4800, period: 0.71, pulses: 4, amp: 0.24, pan: 0.55 },
    { f: 3700, period: 0.63, pulses: 3, amp: 0.27, pan: 0.15 },
    { f: 5300, period: 0.87, pulses: 3, amp: 0.10, pan: -0.25 },  // 먼 녀석
    { f: 4500, period: 1.13, pulses: 2, amp: 0.07, pan: 0.8 },    // 더 먼 녀석
  ];
  const pulseLen = Math.round(0.021 * rate);
  const gapLen = Math.round(0.013 * rate);
  const evL = new Float32Array(n), evR = new Float32Array(n);
  for (const bug of bugs) {
    const aL = Math.cos((bug.pan + 1) * Math.PI / 4);
    const aR = Math.sin((bug.pan + 1) * Math.PI / 4);
    let t = r01() * bug.period;
    while (t * rate < n) {
      if (r01() < 0.13) { t += bug.period; continue; }        // 가끔 쉰다
      const at = Math.round(t * rate);
      const loud = bug.amp * (0.7 + 0.3 * r01());
      for (let p = 0; p < bug.pulses; p++) {
        const start = at + p * (pulseLen + gapLen);
        const f = bug.f * (1 + 0.012 * p);                    // 펄스마다 살짝 올라간다
        for (let j = 0; j < pulseLen; j++) {
          const env = Math.pow(Math.sin((j / pulseLen) * Math.PI), 2);
          const s = Math.sin(TAU * f * j / rate) * env * loud;
          const idx = (start + j) % n;                        // 이음매를 넘는 처프는 감긴다
          evL[idx] += s * aL;
          evR[idx] += s * aR;
        }
      }
      t += bug.period * (0.93 + 0.14 * r01());
    }
  }
  return [L, R, evL, evR];
}

function genWind(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);
  // 돌풍 포락선은 두 채널이 공유한다(같은 바람) — 텍스처만 비상관.
  const gust = new Float32Array(m);
  const ph = r01() * TAU;
  for (let i = 0; i < m; i++) {
    gust[i] = 0.26 + 0.74
      * Math.pow(0.5 + 0.5 * Math.sin(TAU * 2 * i / n + ph), 2)
      * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(TAU * 5 * i / n + ph * 3)));
  }
  for (const [d, off] of [[L, 0], [R, 0.011]]) {
    let b = 0, lp = 0, res1 = 0, res2 = 0;
    const f0 = 640;
    const rPole = 1 - TAU * f0 * 0.5 / rate;
    const c = 2 * rPole * Math.cos(TAU * f0 / rate);
    const r2 = rPole * rPole;
    for (let i = 0; i < m; i++) {
      b = (b + 0.02 * w()) / 1.02;
      const g = gust[i];
      lp += (0.02 + (0.09 + off) * g) * (b * 3.2 - lp);      // 돌풍이 컷오프를 연다
      const y = c * res1 - r2 * res2 + w();
      res2 = res1; res1 = y;
      const whistle = y * 0.010 * Math.max(0, g - 0.62);     // 창틈 휘파람 — 봉우리에서만
      d[i] = lp * g * 1.5 + whistle;
    }
  }
  return [L, R];
}

function genFan(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);
  const hum1 = Math.round(100 * (n / rate));      // 모터 험 100Hz — 루프 정수배로 고정
  const hum2 = hum1 * 2;
  const blade = Math.round(21 * (n / rate));      // 날개 통과 ~21Hz
  for (const [d, hueOff] of [[L, 0], [R, 0.5]]) {
    let b = 0, lp = 0;
    for (let i = 0; i < m; i++) {
      b = (b + 0.02 * w()) / 1.02;
      lp += 0.08 * (b * 3.2 - lp);
      const hum = Math.sin(TAU * hum1 * i / n + hueOff) * 0.05
        + Math.sin(TAU * hum2 * i / n + hueOff * 2) * 0.02;
      const bl = 1 + 0.06 * Math.sin(TAU * blade * i / n + hueOff);
      d[i] = (lp * 1.7 + hum) * bl;
    }
  }
  return [L, R];
}

/** 알람 차임 — 부드러운 3음 아르페지오. 놀라서 깨는 소리가 아니라 열리는 소리. */
function genChime(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);
  const evL = new Float32Array(n), evR = new Float32Array(n);
  const notes = [
    { f: 523.25, t: 0.4, pan: -0.3 },   // C5
    { f: 659.25, t: 1.6, pan: 0.1 },    // E5
    { f: 783.99, t: 2.8, pan: 0.4 },    // G5
    { f: 659.25, t: 4.6, pan: -0.1 },   // E5 — 한 번 더, 조금 늦게
  ];
  for (const nt of notes) {
    const at = Math.round(nt.t * rate);
    for (const [mult, amp, dec] of [[1, 0.5, 2.2], [2, 0.14, 1.3], [3, 0.05, 0.8]]) {
      panPing(evL, evR, at, nt.f * mult, dec, amp, rate, nt.pan, 0.012);
    }
  }
  return [L, R, evL, evR];              // 나머지 ~3초는 침묵 — 루프마다 숨이 생긴다
}

/**
 * 먼 천둥 — 비 오는 밤의 깊이. 가까운 벼락이 아니다.
 * 번쩍하는 '쾅'(크랙)은 넣지 않는다. 놀라서 깨면 수면 앱이 아니다 —
 * 지평선 너머에서 굴러오는 저역만 남긴다.
 */
function genThunder(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);
  // 층 1 — 밤공기. 천둥이 무음 위에 뜨면 효과음처럼 들린다.
  for (const d of [L, R]) {
    let b = 0, lp = 0, air = 0;
    for (let i = 0; i < m; i++) {
      b = (b + 0.02 * w()) / 1.02;
      lp += 0.03 * (b * 3.2 - lp);
      air += 0.3 * (w() - air);
      d[i] = lp * 0.9 + air * 0.03;
    }
  }
  // 층 2 — 우르릉. 3중 저역통과 노이즈에 느린 진폭 흔들림을 얹으면 '구르는' 소리가 된다.
  const evL = new Float32Array(n), evR = new Float32Array(n);
  const rolls = Math.max(2, Math.round((n / rate) / 17));
  for (let e = 0; e < rolls; e++) {
    const at = Math.floor(r01() * n);
    const len = Math.round((3.4 + r01() * 3.6) * rate);
    const amp = 0.5 + r01() * 0.5;
    const pan = w() * 0.7;
    const a = (pan + 1) * Math.PI / 4;
    const gL = Math.cos(a), gR = Math.sin(a);
    const atk = Math.round(len * 0.09);           // 먼 소리는 시작이 뭉툭하다
    let p1 = 0, p2 = 0, p3 = 0;
    for (let j = 0; j < len; j++) {
      const t = j / len;
      const env = j < atk ? j / atk : Math.exp(-(j - atk) * 3.4 / len);
      const roll = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * 31 + Math.sin(t * 9) * 2.4));
      p1 += 0.02 * (w() - p1);
      p2 += 0.02 * (p1 - p2);
      p3 += 0.05 * (p2 - p3);
      // 28 — 42 로 하면 리미터를 타서 피크가 0.578 까지 붙고 정규화 RMS 가 오히려 내려간다
      const s = p3 * 28 * env * roll * amp;
      const idx = (at + j) % n;                   // 이음매를 넘는 천둥은 감긴다
      evL[idx] += s * gL;
      evR[idx] += s * gR;
    }
  }
  return [L, R, evL, evR];
}

/**
 * 기내 소음 — 비행기 안의 그 소리. 선풍기와 다른 점은 날개 통과음(주기적 '펄럭')이 없다는 것,
 * 브라운 노이즈와 다른 점은 동체 공명이 있어 "공간 안에 있다"고 들린다는 것.
 */
function genCabin(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);
  const drift = new Float32Array(m);              // 아주 느린 출력 변화. 완전히 고르면 기계 같다
  for (let i = 0; i < m; i++) {
    drift[i] = 0.9 + 0.1 * Math.sin(TAU * 2 * i / n) + 0.05 * Math.sin(TAU * 5 * i / n + 1.3);
  }
  for (const [d, off] of [[L, 0], [R, 0.004]]) {
    let b = 0, lp = 0, hiss = 0, res1 = 0, res2 = 0;
    const f0 = 118;                               // 동체 공명
    const rPole = 1 - TAU * f0 * 0.9 / rate;
    const c = 2 * rPole * Math.cos(TAU * f0 / rate);
    const r2 = rPole * rPole;
    for (let i = 0; i < m; i++) {
      b = (b + 0.02 * w()) / 1.02;
      lp += (0.035 + off) * (b * 3.2 - lp);
      hiss += 0.5 * (w() - hiss);                 // 환기구 공기
      const y = c * res1 - r2 * res2 + w() * 0.5;
      res2 = res1; res1 = y;
      d[i] = (lp * 1.5 + y * 0.02 + hiss * 0.05) * drift[i];
    }
  }
  return [L, R];
}

/**
 * 동굴 물방울 — 넓고 빈 돌 공간. 시냇물과 달리 물줄기가 없고, 방울 하나하나가 떨어져 있다.
 * 방울마다 0.2초쯤 뒤에 작은 반향을 하나 붙인다. 그게 "동굴"을 만드는 전부다.
 */
function genCave(m, rate, n) {
  const L = new Float32Array(m), R = new Float32Array(m);
  for (const d of [L, R]) {                       // 층 1 — 돌방의 공기. 거의 저역만 남는다
    let b = 0, lp = 0;
    for (let i = 0; i < m; i++) {
      b = (b + 0.02 * w()) / 1.02;
      lp += 0.014 * (b * 3.2 - lp);
      d[i] = lp * 1.1;
    }
  }
  const evL = new Float32Array(n), evR = new Float32Array(n);
  const drips = Math.round((n / rate) * 0.55);    // 2초에 한 방울쯤 — 성겨야 넓게 들린다
  for (let e = 0; e < drips; e++) {
    const at = Math.floor(r01() * n);
    const f = 480 + r01() * 900;
    const amp = 0.10 + r01() * r01() * 0.16;
    const pan = w() * 0.85;
    panPing(evL, evR, at, f, 0.10 + r01() * 0.13, amp, rate, pan, 0.0012);
    // 반향 — 반대쪽에서, 어둡고 작게
    panPing(evL, evR, (at + Math.round((0.17 + r01() * 0.12) * rate)) % n,
      f * 0.62, 0.16 + r01() * 0.14, amp * 0.3, rate, -pan * 0.7, 0.004);
  }
  return [L, R, evL, evR];
}

// ── 마감: 크로스페이드 · 정규화 · WAV ─────────────────────

const TARGET_RMS = 0.13;

/**
 * kind 하나를 즉시 재생 가능한 스테레오 소리로 렌더한다.
 *
 * 정규화는 피크가 아니라 RMS 기준 — 귀는 평균 에너지로 크기를 느낀다.
 * 피크로 맞추면 모닥불과 백색소음이 같은 슬라이더에서 7배 차이로 들린다.
 * 순간 피크는 tanh 로 눌러 준다. 0.58 헤드룸: 기기 샘플레이트로 리샘플링할 때
 * 보간이 파형 위로 넘치는 것을 실측으로 잡은 값이다.
 * 차임만 예외로 피크 정규화한다 — 성긴 종소리를 RMS 로 맞추면 찌그러진다.
 */
export function renderBed(kind, rate = RATE) {
  const seconds = LENGTHS[kind] || 20;
  const n = seconds * rate;
  const f = Math.floor(rate * 1.5);   // 텍스처 크로스페이드. 0.5초는 이음매가 귀에 걸렸다
  const m = n + f;

  const gen = {
    white: () => genNoise('white', m, rate),
    pink: () => genNoise('pink', m, rate),
    brown: () => genNoise('brown', m, rate),
    rain: () => genRain(m, rate, n),
    waves: () => genWaves(m, rate, n),
    fire: () => genFire(m, rate, n),
    stream: () => genStream(m, rate, n),
    crickets: () => genCrickets(m, rate, n),
    wind: () => genWind(m, rate, n),
    fan: () => genFan(m, rate, n),
    chime: () => genChime(m, rate, n),
    thunder: () => genThunder(m, rate, n),
    cabin: () => genCabin(m, rate, n),
    cave: () => genCave(m, rate, n),
  }[kind] || (() => genNoise('white', m, rate));

  const [srcL, srcR, evL, evR] = gen();
  const chans = [new Float32Array(n), new Float32Array(n)];
  [srcL, srcR].forEach((src, ci) => {
    const out = chans[ci];
    for (let i = 0; i < n; i++) out[i] = src[i];
    for (let j = 0; j < f; j++) {                 // 끝 f 샘플을 앞으로 감아 잇는다
      const t = j / f;
      out[j] = src[j] * t + src[n + j] * (1 - t);
    }
  });
  if (evL) {                                      // 이벤트는 크로스페이드를 거치지 않는다
    for (let i = 0; i < n; i++) { chans[0][i] += evL[i]; chans[1][i] += evR[i]; }
  }

  masterize(chans, kind === 'chime');
  return { left: chans[0], right: chans[1], rate };
}

/** DC 제거 + RMS 정규화 + tanh 리미터. 합성이든 실제 녹음이든 같은 규칙이라야
 *  같은 슬라이더에서 같은 크기로 들린다. peakNorm 은 차임처럼 성긴 소리 전용. */
function masterize(chans, peakNorm = false) {
  const n = chans[0].length;
  let mean = 0, sum = 0, peak = 0;
  for (const out of chans) for (let i = 0; i < n; i++) mean += out[i];
  mean /= n * 2;                                  // 브라운 노이즈는 DC 가 떠 있다
  for (const out of chans) for (let i = 0; i < n; i++) {
    out[i] -= mean;
    sum += out[i] * out[i];
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const rms = Math.sqrt(sum / (n * 2));

  if (peakNorm) {
    const gain = peak > 0 ? 0.5 / peak : 1;
    for (const out of chans) for (let i = 0; i < n; i++) out[i] *= gain;
  } else {
    const gain = rms > 0 ? TARGET_RMS / rms : 1;
    for (const out of chans) for (let i = 0; i < n; i++) {
      out[i] = Math.tanh(out[i] * gain * 1.5) * 0.58;
    }
  }
}

/**
 * 디코드한 실제 녹음을 이음매 없는 루프로 마감한다 — 꼬리 1.5초를 앞에 감아
 * 크로스페이드하고, 합성과 같은 규칙으로 정규화한다.
 * mp3 를 <audio loop> 로 바로 돌리면 인코더 패딩 때문에 루프마다 틈이 생긴다.
 * 그래서 파일은 디코드 → 여기서 재조립 → WAV Blob 으로 돌린다.
 */
export function loopify(srcL, srcR, rate) {
  const f = Math.min(Math.floor(rate * 1.5), Math.floor(srcL.length / 4));
  const n = srcL.length - f;
  const chans = [new Float32Array(n), new Float32Array(n)];
  [srcL, srcR].forEach((src, ci) => {
    const out = chans[ci];
    for (let i = 0; i < n; i++) out[i] = src[i];
    for (let j = 0; j < f; j++) {
      const t = j / f;
      out[j] = src[j] * t + src[n + j] * (1 - t);
    }
  });
  masterize(chans);
  return { left: chans[0], right: chans[1], rate };
}

/** 스테레오 16비트 WAV 바이트. 브라우저는 Blob 으로, node 는 파일로 감싼다. */
export function wavBytes({ left, right, rate }) {
  const n = left.length;
  const bytes = n * 4;                            // 2ch × 16bit
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, left[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, right[i])) * 32767, true);
  }
  return buf;
}
