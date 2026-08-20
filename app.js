// 화면 전환 · 전역 상태 · 저장
import { Mixer, NarrationPlayer, createAlarm, setMediaSession, koreanVoices, splitSentences } from './audio.js';
import { loadManifest, buildSequence } from './narration.js';
import { SceneRenderer, sceneList } from './scenes.js';
import {
  DEFAULTS, HOUR, sleepDebt, nightHours, dailySeries, dateKey, nightDateKey,
  upsertNight, fmtHours, fmtClock, createAlarmWatcher,
} from './sleep.js';

// 표시 이름은 여기 한 곳에만 있다. 이름을 바꾸면 이 줄만 고치면 된다.
const APP_NAME = '굿슬립';

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ── 저장 ──────────────────────────────────────────────────

const KEY = 'goodsleep';
const load = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(`${KEY}.${k}`)) ?? fallback; }
  catch { return fallback; }
};
const save = (k, v) => localStorage.setItem(`${KEY}.${k}`, JSON.stringify(v));

const store = {
  settings: {
    ...DEFAULTS,
    // 말은 자연 속도(-5%)로 둔다. 느린 느낌은 여기 침묵이 만든다 —
    // rate 를 낮추면 타임스트레치라 억양이 뭉개지지만 침묵은 아무것도 망가뜨리지 않는다.
    // 말 속도는 0.69 가 바닥이다 — 그 아래는 자음이 뭉개져 혀 꼬인 소리가 난다.
    // 그래서 느림은 전부 여기서 가져온다.
    gapSeconds: 6, sentenceGap: 3.6, narrationVolume: 0.9,
    voiceURI: null, voiceRate: 0.72, voicePitch: 0.9,
    ...load('settings', {}),
  },
  nights: load('nights', []),
  naps: load('naps', []),
  history: load('history', {}),
  mixer: load('mixer', {}),
  preset: load('preset', null),
  scene: load('scene', 'stars'),
  pending: load('pending', null),   // 진행 중인 밤 (취침 기록 + 알람 시각)
};

// ── 런타임 ────────────────────────────────────────────────

const mixer = new Mixer();
const scenes = new SceneRenderer($('#scene'));
const alarm = createAlarm();
const watcher = createAlarmWatcher(fireAlarm);
let narration = null;
let manifest = null;
let session = null;         // { stateId, hours, isNap, bedAt, alarmAt }
let draft = { stateId: null, mode: null, wakeAt: 0, napMinutes: 30, custom: false, customMin: 30 };
let napFormMinutes = 30;
let dimTimer = null;
let breathTimer = null;
let breathTick = null;

// ── 화면 ──────────────────────────────────────────────────

function go(name) {
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === `s-${name}`));
  if (name === 'report') renderReport();
  window.scrollTo(0, 0);
}

$$('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
$$('[data-back]').forEach((b) => b.addEventListener('click', () => go(b.dataset.back)));

// ── 홈 ────────────────────────────────────────────────────

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const timeWord = (h) => h < 5 ? '깊은 밤' : h < 11 ? '아침' : h < 17 ? '낮' : h < 21 ? '저녁' : '밤';

function tickClock() {
  const d = new Date();
  $('#home-clock').textContent = fmtClock(d.getTime());
  $('#home-date').textContent =
    `${d.getMonth() + 1}월 ${d.getDate()}일 ${DOW[d.getDay()]}요일 · ${timeWord(d.getHours())}`;
}

/**
 * 오늘 달의 위상. 그림자 원을 옆으로 밀어 그믐→초승→보름을 그린다.
 * 기준: 2000-01-06 18:14 UTC 새달, 삭망월 29.5306일. 장식용이라 이 정밀도면 충분하다.
 */
function setMoonPhase() {
  const synodic = 29.53058867;
  const days = ((Date.now() / 86400000 - 10957.76) % synodic + synodic) % synodic;
  const p = days / synodic;                       // 0 새달 · 0.5 보름
  const cx = p <= 0.5 ? 32 - 136 * p : 32 + 136 * (1 - p);
  $('#moon-shadow').setAttribute('cx', cx.toFixed(1));
}

// 상태마다 고유한 점 색 — 목록이 한 가지 보라색이면 다섯 줄이 한 덩어리로 보인다.
const STATE_HUES = {
  racing: '#8A78C4', anxious: '#6FA8B8', wired: '#C98B62',
  awoken: '#7C88C9', unknown: '#A79FB4',
};

function renderStates() {
  const list = $('#state-list');
  list.innerHTML = '';
  for (const id of manifest.order) {
    const st = manifest.states[id];
    const b = document.createElement('button');
    b.className = 'state';
    b.style.setProperty('--dot', STATE_HUES[id] || 'var(--violet)');
    b.style.setProperty('--dot-soft', (STATE_HUES[id] || '#8A78C4') + '29');
    b.innerHTML = `<span class="dot"></span><span>${st.label}</span>
                   <svg class="icon arrow"><use href="#i-next"/></svg>`;
    b.addEventListener('click', () => openPrepare(id));
    list.appendChild(b);
  }
}

// ── 준비 ──────────────────────────────────────────────────

// 밤과 낮잠이 같은 화면을 쓰지만 고르는 방식이 다르다.
//   밤   — 일어날 시각만 고른다 (30분 단위). 몇 시간 잘지는 계산해서 보여준다.
//   낮잠 — 길이로 고른다. 낮잠은 "몇 시에"가 아니라 "몇 분"이 자연스럽다.
const DURATION = {
  night: { unit: '시간', head: '몇 시에 일어날까요?', min: 30, max: 900 },
  nap:   { presets: [20, 30, 45, 60], unit: '분', head: '얼마나 잘까요?', min: 5, max: 240 },
};

const durMode = () => (manifest.states[draft.stateId]?.night === false ? 'nap' : 'night');

// 밤은 절대 시각(wakeAt)으로 들고 있는다. 길이(분)로 저장하면 1초가 지날 때마다
// 표시 시각이 뒤로 밀려 09:00 이 08:59 가 된다 — 사용자가 고른 건 시각이지 길이가 아니다.
const draftMinutes = () => durMode() === 'night'
  ? Math.max(1, Math.round((draft.wakeAt - Date.now()) / 60000))
  : draft.custom ? draft.customMin : draft.napMinutes;

/** 30분 단위로 맞춘 기상 시각. 지금이 01:05 이고 8시간이면 09:00 이 된다. */
function roundedWakeAt(fromNowMin = 480) {
  const at = new Date(Date.now() + fromNowMin * 60000);
  at.setSeconds(0, 0);
  at.setMinutes(Math.round(at.getMinutes() / 30) * 30);
  return at.getTime();
}

function wakeInputValue() {
  const at = new Date(draft.wakeAt);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function openPrepare(stateId) {
  draft.stateId = stateId;
  const state = manifest.states[stateId];
  $('#prep-state').textContent = state.label;

  // 밤에서 "직접 06:30"(=365분)을 고른 뒤 낮잠으로 넘어오면 그 값이 딸려온다.
  // 낮잠에 6시간이 뜨면 안 되므로 단위가 바뀌면 직접 입력을 놓아준다.
  const mode = durMode();
  if (mode !== draft.mode) {
    draft.mode = mode;
    draft.custom = false;
    draft.customMin = draft.napMinutes;
  }
  // 밤에 들어올 때마다 지금 시각 기준으로 다시 잡는다 — 어제 열어둔 값이 남아 있으면 안 된다.
  if (mode === 'night') draft.wakeAt = roundedWakeAt(store.settings.needHours * 60);

  // 자다 깬 경우는 알람을 다시 잡지 않는다. 새벽 3시에 깬 사람의 알람을 날려먹으면 안 된다.
  const resuming = stateId === 'awoken' && store.pending;
  const cfg = DURATION[durMode()];
  $('#prep-h').textContent = resuming ? '다시 잠들기' : cfg.head;
  $('#duration-block').hidden = resuming;
  if (resuming) $('#prep-wake').textContent = `알람은 ${fmtClock(store.pending.alarmAt)} 그대로입니다.`;

  renderDurationChips();
  renderPresets();
  renderSceneChips();
  renderMixer();
  updateWakeLabel();
  go('prepare');
}

function renderDurationChips() {
  const isNight = durMode() === 'night';
  $('#custom-time-row').hidden = !isNight;
  $('#nap-duration').hidden = isNight;

  if (isNight) {
    $('#wake-input').value = wakeInputValue();
    return;
  }

  const cfg = DURATION.nap;
  const box = $('#hours-chips');
  box.innerHTML = '';
  for (const v of cfg.presets) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = `${v}${cfg.unit}`;
    b.setAttribute('aria-pressed', String(!draft.custom && draft.napMinutes === v));
    b.addEventListener('click', () => { draft.custom = false; draft.napMinutes = v; syncDuration(); });
    box.appendChild(b);
  }
  const custom = document.createElement('button');
  custom.className = 'chip';
  custom.textContent = '직접';
  custom.setAttribute('aria-pressed', String(draft.custom));
  custom.addEventListener('click', () => {
    draft.custom = true;
    draft.customMin = draftMinutes();
    syncDuration();
  });
  box.appendChild(custom);

  $('#custom-min-row').hidden = !draft.custom;
  if (draft.custom) $('#minutes-input').value = draft.customMin;
}

function syncDuration() {
  renderDurationChips();
  updateWakeLabel();
}

/** 고른 시각이 이미 지났으면 다음 날이다 — 자정을 넘겨 자는 게 정상이다. */
$('#wake-input').addEventListener('change', (e) => {
  const [h, m] = e.target.value.split(':').map(Number);
  if (Number.isNaN(h)) return;
  const at = new Date();
  at.setHours(h, m, 0, 0);
  if (at.getTime() <= Date.now() + 60000) at.setDate(at.getDate() + 1);
  draft.wakeAt = at.getTime();
  updateWakeLabel();
});

$$('[data-wake-step]').forEach((b) => b.addEventListener('click', () => {
  const { min, max } = DURATION.night;
  const next = draft.wakeAt + Number(b.dataset.wakeStep) * 60000;
  const from = Math.round((next - Date.now()) / 60000);
  if (from < min || from > max) return;      // 30분 미만이나 15시간 초과로는 못 간다
  draft.wakeAt = next;
  $('#wake-input').value = wakeInputValue();
  updateWakeLabel();
}));

const clampMin = (v) => {
  const cfg = DURATION[durMode()];
  return Math.max(cfg.min, Math.min(cfg.max, v));
};

$('#minutes-input').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (!Number.isFinite(v) || v <= 0) return;
  draft.customMin = clampMin(v);
  updateWakeLabel();
});
$('#minutes-input').addEventListener('blur', () => { $('#minutes-input').value = draft.customMin; });

$$('[data-dur-step]').forEach((b) => b.addEventListener('click', () => {
  draft.customMin = clampMin(draft.customMin + Number(b.dataset.durStep));
  $('#minutes-input').value = draft.customMin;
  updateWakeLabel();
}));

// ── 사운드 프리셋 ─────────────────────────────────────────

// 카드 그림 — 이미지 파일 없이 인라인 SVG 로 그린다 (사진은 라이선스가 걸린다).
// 색은 프리셋의 --glow 를 물려받아 카드마다 분위기가 달라진다.
const ART = {
  waves: `<svg viewBox="0 0 160 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <circle cx="116" cy="22" r="11" fill="var(--glow)" opacity=".9"/>
    <g stroke="var(--glow)" stroke-width="2" stroke-linecap="round" opacity=".45">
      <path d="M108 56h16M112 68h10M110 80h14"/></g>
    <g fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2" stroke-linecap="round">
      <path d="M-4 52 Q12 46 28 52 T60 52 T92 52 T124 52 T156 52" opacity=".75"/>
      <path d="M-8 66 Q8 60 24 66 T56 66 T88 66 T120 66 T152 66" opacity=".5"/>
      <path d="M0 80 Q16 74 32 80 T64 80 T96 80 T128 80 T160 80" opacity=".3"/></g></svg>`,
  rain: `<svg viewBox="0 0 160 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g stroke="rgba(210,230,255,.5)" stroke-width="1.6" stroke-linecap="round">
      <path d="M28 8l-7 18M64 4l-7 18M100 10l-7 18M132 2l-7 18M46 30l-6 16M84 28l-6 16M118 32l-6 16M22 52l-5 14M58 54l-5 14M96 52l-5 14M134 50l-5 14"/></g>
    <g fill="rgba(220,238,255,.75)">
      <circle cx="36" cy="74" r="2.4"/><circle cx="74" cy="80" r="1.8"/><circle cx="112" cy="76" r="2.1"/></g>
    <ellipse cx="80" cy="88" rx="46" ry="3" fill="none" stroke="rgba(210,230,255,.28)" stroke-width="1.4"/></svg>`,
  fire: `<svg viewBox="0 0 160 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g stroke="rgba(122,82,52,.9)" stroke-width="5" stroke-linecap="round">
      <path d="M54 84l52 -6M58 78l46 10"/></g>
    <path d="M80 24 C64 44 62 58 70 68 C74 73 86 74 90 68 C98 58 96 42 80 24Z" fill="var(--glow)" opacity=".9"/>
    <path d="M80 42 C73 52 72 60 77 66 C80 69 85 69 87 65 C91 58 88 50 80 42Z" fill="#FFE9C2" opacity=".85"/>
    <g fill="var(--glow)"><circle cx="64" cy="26" r="1.6" opacity=".8"/><circle cx="98" cy="18" r="1.3" opacity=".6"/><circle cx="88" cy="9" r="1" opacity=".45"/></g></svg>`,
  stars: `<svg viewBox="0 0 160 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g fill="rgba(255,255,255,.8)">
      <circle cx="24" cy="16" r="1.3"/><circle cx="58" cy="10" r="1"/><circle cx="96" cy="18" r="1.4"/><circle cx="128" cy="8" r="1"/><circle cx="144" cy="26" r="1.2"/></g>
    <g fill="var(--glow)"><circle cx="52" cy="54" r="2.2" opacity=".95"/><circle cx="104" cy="46" r="1.8" opacity=".7"/><circle cx="78" cy="62" r="1.5" opacity=".85"/></g>
    <g fill="none" stroke="rgba(163,196,142,.55)" stroke-width="1.8" stroke-linecap="round">
      <path d="M12 92 C14 80 12 74 8 68M28 92 C30 78 34 72 32 62M52 92 C50 80 54 74 58 66M88 92 C90 82 86 76 84 70M116 92 C118 80 122 74 120 64M142 92 C140 82 144 76 148 70"/></g></svg>`,
  stream: `<svg viewBox="0 0 160 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g fill="rgba(255,255,255,.15)">
      <ellipse cx="28" cy="82" rx="16" ry="8"/><ellipse cx="128" cy="84" rx="18" ry="9"/><ellipse cx="84" cy="88" rx="12" ry="6"/></g>
    <g fill="none" stroke="var(--glow)" stroke-width="2" stroke-linecap="round">
      <path d="M-4 58 C24 54 30 66 56 62 S96 52 118 60 S150 66 164 60" opacity=".75"/>
      <path d="M-4 72 C20 68 34 78 60 74 S98 64 122 72 S150 78 164 72" opacity=".5"/></g>
    <g stroke="rgba(255,255,255,.6)" stroke-width="1.6" stroke-linecap="round">
      <path d="M48 56l6 -2M100 66l6 -2M70 76l6 -2"/></g></svg>`,
  fan: `<svg viewBox="0 0 160 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <circle cx="80" cy="40" r="26" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2"/>
    <g fill="var(--glow)" opacity=".55">
      <path d="M80 40 C70 24 74 16 84 14 C92 13 94 24 88 34Z"/>
      <path d="M80 40 C96 44 102 52 96 60 C90 66 80 58 78 48Z"/>
      <path d="M80 40 C66 50 56 48 54 40 C53 32 64 28 74 34Z"/></g>
    <circle cx="80" cy="40" r="4" fill="rgba(255,255,255,.6)"/>
    <path d="M80 66v14M64 84h32" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="3" stroke-linecap="round"/></svg>`,
  snow: `<svg viewBox="0 0 160 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <g fill="rgba(255,255,255,.85)">
      <circle cx="26" cy="18" r="2"/><circle cx="62" cy="10" r="1.5"/><circle cx="98" cy="22" r="2.2"/><circle cx="132" cy="12" r="1.6"/>
      <circle cx="42" cy="42" r="1.7"/><circle cx="82" cy="36" r="1.4"/><circle cx="118" cy="46" r="1.9"/><circle cx="148" cy="38" r="1.3"/>
      <circle cx="30" cy="66" r="1.5"/><circle cx="70" cy="60" r="2"/><circle cx="108" cy="68" r="1.4"/><circle cx="140" cy="62" r="1.7"/></g>
    <path d="M0 86 C30 80 60 88 90 84 S140 80 160 84 V92 H0Z" fill="rgba(255,255,255,.22)"/></svg>`,
  plain: `<svg viewBox="0 0 160 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <path d="M0 70 H160" stroke="rgba(255,255,255,.22)" stroke-width="1.5"/>
    <ellipse cx="80" cy="70" rx="34" ry="10" fill="var(--glow)" opacity=".3"/>
    <circle cx="80" cy="66" r="5" fill="var(--glow)" opacity=".8"/></svg>`,
};

function renderPresets() {
  const rail = $('#preset-rail');
  if (rail.childElementCount) { markPreset(); return; }
  for (const p of manifest.presets) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.preset = p.id;
    b.setAttribute('aria-pressed', 'false');
    b.style.setProperty('--from', p.art.from);
    b.style.setProperty('--to', p.art.to);
    b.style.setProperty('--glow', p.art.glow);
    // 사진이 있으면 사진(SVG 위에 얹힘), 못 불러오면 img 가 스스로 빠져 SVG 가 남는다
    const photo = p.img
      ? `<img class="ph" src="${p.img}" alt="" loading="lazy" onerror="this.remove()">` : '';
    b.innerHTML = `<span class="art" aria-hidden="true">${ART[p.art.motif] || ''}${photo}</span>
      <span class="body"><span class="name">${p.label}</span><span class="note">${p.note}</span></span>`;
    b.addEventListener('click', () => applyPreset(p));
    rail.appendChild(b);
  }
  markPreset();
}

function applyPreset(p) {
  store.mixer = { ...p.mix };
  save('mixer', store.mixer);
  store.preset = p.id;
  save('preset', p.id);
  if (p.scene) { store.scene = p.scene; save('scene', p.scene); scenes.set(p.scene); renderSceneChips(); }

  mixer.unlock().then(() => {
    for (const l of mixer.layers.values()) mixer.setVolume(l.def.id, store.mixer[l.def.id] || 0);
  });
  syncMixerUI();
  markPreset();
}

function markPreset() {
  $$('#preset-rail .preset').forEach((el) => {
    el.setAttribute('aria-pressed', String(el.dataset.preset === store.preset));
  });
}

/** 프리셋을 고르면 슬라이더도 따라 움직여야 한다. 안 그러면 두 UI 가 서로 거짓말을 한다. */
function syncMixerUI() {
  $$('#mixer .mix-row').forEach((row) => {
    const id = row.dataset.layer;
    const v = Math.round((store.mixer[id] || 0) * 100);
    row.querySelector('input').value = v;
    row.querySelector('.val').textContent = v || '';
    row.classList.toggle('is-on', v > 0);
  });
}

function renderSceneChips() {
  const box = $('#scene-chips');
  box.innerHTML = '';
  for (const s of sceneList) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = s.label;
    b.setAttribute('aria-pressed', String(s.id === store.scene));
    b.addEventListener('click', () => {
      store.scene = s.id;
      save('scene', s.id);
      scenes.set(s.id);
      renderSceneChips();
    });
    box.appendChild(b);
  }
}

function renderMixer() {
  const box = $('#mixer');
  if (box.childElementCount) return;   // 한 번만 짓는다
  for (const def of manifest.sounds) {
    const layer = mixer.add(def);
    const row = document.createElement('div');
    row.className = 'mix-row';
    row.dataset.layer = def.id;
    const saved = store.mixer[def.id] ?? 0;
    row.innerHTML = `
      <span class="name" id="lb-${def.id}">${def.label}</span>
      <input type="range" min="0" max="100" value="${Math.round(saved * 100)}"
             aria-labelledby="lb-${def.id}">
      <span class="val num">${Math.round(saved * 100) || ''}</span>`;
    const input = row.querySelector('input');
    const val = row.querySelector('.val');

    const sync = () => {
      row.classList.toggle('is-off', !layer.available);
      input.disabled = !layer.available;
      if (!layer.available) { input.value = 0; val.textContent = ''; row.classList.remove('is-on'); }
    };
    layer.onstate = sync;
    sync();

    input.addEventListener('input', () => {
      const v = input.value / 100;
      store.mixer[def.id] = v;
      val.textContent = input.value > 0 ? input.value : '';
      row.classList.toggle('is-on', v > 0);
      save('mixer', store.mixer);
      // 손으로 만졌으면 더 이상 그 프리셋이 아니다
      store.preset = null;
      save('preset', null);
      markPreset();
      mixer.unlock().then(() => mixer.setVolume(def.id, v));
    });

    row.classList.toggle('is-on', saved > 0);
    box.appendChild(row);
  }
}

function updateWakeLabel() {
  if (draft.stateId === 'awoken' && store.pending) return;
  const min = draftMinutes();
  const at = Date.now() + min * 60000;
  $('#prep-wake').textContent = `${fmtHours(min / 60)} 뒤, ${fmtClock(at)}에 깨워 드립니다.`;
  $('#start-btn').textContent = durMode() === 'nap' ? '낮잠 시작' : '시작';
}

$('#start-btn').addEventListener('click', () =>
  startSession(draft.stateId, draftMinutes() / 60, draft.stateId === 'nap'));

// ── 낮 ────────────────────────────────────────────────────
// 낮잠도 밤과 같은 준비 화면을 쓴다 — 프리셋·배경·직접 입력을 그대로 물려받는다.
$$('[data-day]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.day === 'calm') return startSession('calm', 0, false);
  openPrepare('nap');
}));

// ── 세션 ──────────────────────────────────────────────────

async function startSession(stateId, hours, isNap) {
  const state = manifest.states[stateId];
  if (!state) return;

  await mixer.unlock();
  for (const [id, v] of Object.entries(store.mixer)) if (v > 0) mixer.setVolume(id, v);

  const now = Date.now();
  const resuming = stateId === 'awoken' && store.pending;
  const alarmAt = resuming ? store.pending.alarmAt
                : hours > 0 ? now + hours * HOUR
                : null;

  session = { stateId, isNap, bedAt: resuming ? store.pending.bedAt : now, alarmAt };

  if (alarmAt) {
    store.pending = { bedAt: session.bedAt, alarmAt, isNap, stateId };
    save('pending', store.pending);
    watcher.set(alarmAt);
  }

  $('#play-meta').textContent = alarmAt ? `알람 ${fmtClock(alarmAt)}` : '';
  $('#app').classList.remove('is-dim');
  scenes.start();
  startBreathing();
  setMediaSession({
    title: state.label,
    artist: APP_NAME,
    onPause: () => { narration?.stop(); mixer.duck(false); },
  });

  go('play');
  playNarration(state);
}

function playNarration(state) {
  const { picks, nextHistory } = buildSequence(state, store.history);
  store.history = nextHistory;
  save('history', nextHistory);

  narration?.stop();
  narration = new NarrationPlayer(voiceOpts());
  mixer.duck(true);

  // 나레이션이 "하나"를 말하는 순간 게이지를 같은 위상으로 되감는다.
  // 직전 토막(또는 같은 토막)의 동사가 들숨인지 날숨인지 알려 준다 —
  // 뒤에 나온 동사가 세기와 더 가깝다.
  let prevChunk = '';
  narration.onChunk = (text) => {
    if (/하나[.,!?]?$/.test(text.trim())) {
      const src = prevChunk + ' ' + text;
      const inAt = src.lastIndexOf('들이쉬');
      const outAt = Math.max(src.lastIndexOf('내쉬'), src.lastIndexOf('내쉽'));
      if (inAt > outAt && breathAlignFn) breathAlignFn(0);        // 들이쉬기
      else if (outAt > inAt && breathAlignFn) breathAlignFn(2);   // 내쉬기
    }
    prevChunk = text;
  };

  const caption = $('#play-caption');
  narration.play(picks, {
    onPiece: (p) => {
      caption.classList.add('is-fading');
      setTimeout(() => {
        caption.textContent = p.text || '';
        caption.classList.remove('is-fading');
      }, 500);
    },
    onEnd: () => {
      mixer.duck(false);
      caption.classList.add('is-fading');
      // 나레이션이 끝나면 화면을 거의 끈다. 밤새 밝은 화면은 그 자체로 방해다.
      dimTimer = setTimeout(() => $('#app').classList.add('is-dim'), 4000);
    },
  });
}

// 4-2-6 — 나레이션 breath 층("넷을 세며 들이쉽니다 · 여섯을 세며 내쉽니다")과 같은 박자다.
// 숫자도 나레이션처럼 올려 센다.
const BREATH_PHASES = [
  { label: '들이쉬기', secs: 4, cls: 'is-in' },
  { label: '멈추기', secs: 2, cls: 'is-hold' },
  { label: '내쉬기', secs: 6, cls: 'is-out' },
];
const RING_C = 540.4;   // 2πr (r=86) — style.css 의 stroke-dasharray 와 같아야 한다

let breathAlignFn = null;   // 나레이션이 숫자를 세기 시작하면 게이지를 그 위상으로 맞춘다

function startBreathing() {
  clearTimeout(breathTimer);
  clearInterval(breathTick);
  const root = $('.breath');
  const prog = root.querySelector('.prog');
  const label = $('#breath-label');
  const count = $('#breath-count');
  let i = 0;
  const run = () => {
    clearInterval(breathTick);            // 이전 단계의 카운터가 살아남으면 안 된다
    const p = BREATH_PHASES[i];
    for (const q of BREATH_PHASES) root.classList.toggle(q.cls, q === p);
    root.style.setProperty('--dur', `${p.secs}s`);
    label.textContent = p.label;
    // 링을 전환 없이 0으로 되감은 뒤, 이번 단계 길이만큼 선형으로 채운다.
    // 진행 표시라 선형이 맞다 — 시간이 고르게 흐르는 게 보여야 한다.
    prog.style.transition = 'none';
    prog.style.strokeDashoffset = RING_C;
    void prog.getBoundingClientRect();
    prog.style.transition = `stroke-dashoffset ${p.secs}s linear, stroke 300ms ease-out`;
    prog.style.strokeDashoffset = '0';
    let s = 1;
    count.textContent = s;
    breathTick = setInterval(() => { s += 1; if (s <= p.secs) count.textContent = s; }, 1000);
    breathTimer = setTimeout(() => { i = (i + 1) % BREATH_PHASES.length; run(); }, p.secs * 1000);
  };
  breathAlignFn = (idx) => {
    clearTimeout(breathTimer);
    i = idx;
    run();
  };
  run();
}

function endSession() {
  narration?.stop();
  clearTimeout(dimTimer);
  clearTimeout(breathTimer);
  clearInterval(breathTick);
  mixer.duck(false);
  scenes.stop();
  $('#app').classList.remove('is-dim');
}

$('#stop-btn').addEventListener('click', () => {
  endSession();
  mixer.fadeAllOut(1500);
  watcher.cancel();
  store.pending = null;
  save('pending', null);
  session = null;
  go('home');
});

// 딤 상태에서 화면을 건드리면 잠깐 밝아진다
$('#s-play').addEventListener('click', () => {
  const app = $('#app');
  if (!app.classList.contains('is-dim')) return;
  app.classList.remove('is-dim');
  clearTimeout(dimTimer);
  dimTimer = setTimeout(() => app.classList.add('is-dim'), 12000);
});

// ── 알람 ──────────────────────────────────────────────────

function fireAlarm() {
  const p = store.pending;
  endSession();
  mixer.fadeAllOut(4000);
  alarm.start(60000);
  $('#alarm-clock').textContent = fmtClock(Date.now());
  $('#alarm-sub').textContent = p?.isNap ? '낮잠이 끝났습니다.' : '';
  go('alarm');
  if (navigator.vibrate) navigator.vibrate([400, 300, 400, 300, 400]);
}

$('#alarm-off').addEventListener('click', () => {
  alarm.stop();
  const p = store.pending;
  const wakeAt = Date.now();          // 알람을 끄는 순간이 기상 시각이다
  if (p) {
    if (p.isNap) {
      const minutes = Math.round((wakeAt - p.bedAt) / 60000);
      if (minutes > 0) {
        store.naps.push({ date: dateKey(new Date(wakeAt)), minutes, at: wakeAt, source: 'timer' });
        save('naps', store.naps);
      }
    } else {
      store.nights = upsertNight(store.nights, {
        date: nightDateKey(p.bedAt), bedAt: p.bedAt, wakeAt, state: p.stateId,
      });
      save('nights', store.nights);
    }
  }
  store.pending = null;
  save('pending', null);
  mixer.stopAll();
  session = null;
  go('report');
});

// ── 리포트 ────────────────────────────────────────────────

function renderReport() {
  const s = store.settings;
  const debt = sleepDebt({ ...s, nights: store.nights, naps: store.naps });

  $('#debt-value').textContent = debt < 1 / 60 ? '없음' : fmtHours(debt);
  $('#debt-note').textContent = debt < 1 / 60 ? '잘 자고 있습니다' : '최근 14일';
  $('#debt-fill').style.width = `${Math.min(100, (debt / s.capHours) * 100)}%`;

  const last = [...store.nights].sort((a, b) => b.wakeAt - a.wakeAt)[0];
  if (last) {
    const h = nightHours(last, s.sleepOnsetMin);
    const diff = h - s.needHours;
    $('#last-night').textContent = fmtHours(h);
    $('#last-diff').textContent =
      Math.abs(diff) < 1 / 60 ? '목표와 같음'
      : diff > 0 ? `목표보다 ${fmtHours(diff)} 더` : `목표보다 ${fmtHours(-diff)} 부족`;
  } else {
    $('#last-night').textContent = '기록 없음';
    $('#last-diff').textContent = '';
  }

  renderChart(dailySeries(store.nights, store.naps, Date.now(), s.windowDays, s.sleepOnsetMin));
  renderNapList();
  renderVoiceSettings();
  $('#need-h').textContent = fmtHours(s.needHours);
  $('#onset-m').textContent = `${s.sleepOnsetMin}분`;
  $('#nap-min').textContent = `${napFormMinutes}분`;
}

function renderChart(series) {
  const box = $('#chart');
  box.innerHTML = '';
  const max = Math.max(10, ...series.map((d) => d.nightH + d.napH));
  for (const d of series) {
    const col = document.createElement('div');
    if (!d.hasData) {
      col.className = 'col empty';
      col.title = `${d.label} 기록 없음`;
    } else {
      col.className = 'col';
      col.title = `${d.label} 밤 ${fmtHours(d.nightH)}${d.napH ? ` · 낮잠 ${fmtHours(d.napH)}` : ''}`;
      if (d.napH) {
        const nap = document.createElement('div');
        nap.className = 'bar nap';
        nap.style.height = `${(d.napH / max) * 100}%`;
        col.appendChild(nap);
      }
      const night = document.createElement('div');
      night.className = 'bar night';
      night.style.height = `${(d.nightH / max) * 100}%`;
      col.appendChild(night);
    }
    box.appendChild(col);
  }
}

function renderNapList() {
  const box = $('#nap-list');
  const recent = [...store.naps].sort((a, b) => b.at - a.at).slice(0, 5);
  box.innerHTML = recent.length ? '' : '<p class="empty-note">기록된 낮잠이 없습니다.</p>';
  for (const n of recent) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="num">${n.minutes}분</span>
                     <span class="when num">${n.date} ${fmtClock(n.at)}</span>`;
    box.appendChild(row);
  }
}

$$('[data-nap-step]').forEach((b) => b.addEventListener('click', () => {
  napFormMinutes = Math.max(5, Math.min(240, napFormMinutes + Number(b.dataset.napStep)));
  $('#nap-min').textContent = `${napFormMinutes}분`;
}));

$('#nap-add').addEventListener('click', () => {
  const now = Date.now();
  store.naps.push({ date: dateKey(new Date(now)), minutes: napFormMinutes, at: now, source: 'manual' });
  save('naps', store.naps);
  renderReport();
});

// ── 목소리 ────────────────────────────────────────────────
// 기기마다 쓸 수 있는 음성이 완전히 다르다. 어느 게 나은지는 기기에서 들어봐야 안다.

const voiceOpts = () => ({
  gapSeconds: store.settings.gapSeconds,
  sentenceGap: store.settings.sentenceGap,
  volume: store.settings.narrationVolume,
  voiceURI: store.settings.voiceURI,
  rate: store.settings.voiceRate,
  pitch: store.settings.voicePitch,
});

function renderVoiceSettings() {
  const s = store.settings;
  const sel = $('#voice-select');
  const voices = koreanVoices();

  sel.innerHTML = '';
  // 한국어 음성이 없으면 영어 음성이 한글을 읽어 소리가 뭉개진다. 조용히 두면 안 된다.
  $('#voice-warning').hidden = voices.length > 0;
  if (!voices.length) {
    sel.innerHTML = '<option>한국어 음성 없음</option>';
    sel.disabled = true;
  } else {
    sel.disabled = false;
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = v.name;
      o.selected = v.voiceURI === s.voiceURI;
      sel.appendChild(o);
    }
    if (!voices.some((v) => v.voiceURI === s.voiceURI)) sel.selectedIndex = 0;
  }

  $('#voice-rate').value = Math.round(s.voiceRate * 100);
  $('#voice-pitch').value = Math.round(s.voicePitch * 100);
  $('#voice-rate-v').textContent = `${Math.round(s.voiceRate * 100)}%`;
  $('#voice-pitch-v').textContent = s.voicePitch.toFixed(2);
  $('#sentence-gap').textContent = `${s.sentenceGap.toFixed(1)}초`;
}

$('#voice-select').addEventListener('change', (e) => {
  store.settings.voiceURI = e.target.value;
  save('settings', store.settings);
});
$('#voice-rate').addEventListener('input', (e) => {
  store.settings.voiceRate = e.target.value / 100;
  $('#voice-rate-v').textContent = `${e.target.value}%`;
  save('settings', store.settings);
});
$('#voice-pitch').addEventListener('input', (e) => {
  store.settings.voicePitch = e.target.value / 100;
  $('#voice-pitch-v').textContent = store.settings.voicePitch.toFixed(2);
  save('settings', store.settings);
});
$$('[data-gap-step]').forEach((b) => b.addEventListener('click', () => {
  const [key, delta] = b.dataset.gapStep.split(':');
  store.settings[key] = Math.max(0, Math.min(10, +(store.settings[key] + Number(delta)).toFixed(1)));
  save('settings', store.settings);
  $('#sentence-gap').textContent = `${store.settings.sentenceGap.toFixed(1)}초`;
}));

// 두 문장짜리 견본. 문장 사이 침묵이 실제로 어떻게 들리는지 확인하려면 한 문장으로는 안 된다.
$('#voice-test').addEventListener('click', () => {
  const btn = $('#voice-test');
  if (narration) { narration.stop(); narration = null; btn.textContent = '들어보기'; return; }
  narration = new NarrationPlayer(voiceOpts());
  btn.textContent = '멈추기';
  narration.play(
    [{ id: 't', text: '눈을 감아 보세요. 오늘은 여기까지입니다. 아무것도 하지 않아도 됩니다.' }],
    { onEnd: () => { narration = null; btn.textContent = '들어보기'; } },
  );
});

$$('[data-set-step]').forEach((b) => b.addEventListener('click', () => {
  const [key, delta] = b.dataset.setStep.split(':');
  const bounds = { needHours: [4, 12], sleepOnsetMin: [0, 90] }[key];
  store.settings[key] = Math.max(bounds[0], Math.min(bounds[1], store.settings[key] + Number(delta)));
  save('settings', store.settings);
  renderReport();
}));

// ── 시작 ──────────────────────────────────────────────────

async function init() {
  $$('[data-app-name]').forEach((el) => (el.textContent = APP_NAME));
  document.title = APP_NAME;

  const [nar, snd, pre] = await Promise.all([
    loadManifest(),
    fetch('data/sounds.json').then((r) => r.json()),
    fetch('data/presets.json').then((r) => r.json()),
  ]);
  manifest = { ...nar, sounds: snd.layers, presets: pre.presets };

  // 소리가 전부 0인 채로 시작하면 무엇을 골라야 할지 알 수 없다. 첫 프리셋을 기본으로 둔다.
  if (!Object.values(store.mixer).some((v) => v > 0)) {
    const first = manifest.presets[0];
    store.mixer = { ...first.mix };
    store.preset = first.id;
    store.scene = first.scene || store.scene;
    save('mixer', store.mixer); save('preset', store.preset); save('scene', store.scene);
  }

  renderStates();
  tickClock();
  setMoonPhase();
  setInterval(tickClock, 20000);
  scenes.set(store.scene);

  // 음성 목록은 비동기로 채워진다 — 처음엔 빈 배열이 돌아온다
  if ('speechSynthesis' in window) {
    speechSynthesis.addEventListener('voiceschanged', renderVoiceSettings);
  }

  // 앱이 죽었다 살아났는데 알람 시각이 남아 있으면 이어받는다.
  if (store.pending) {
    if (Date.now() >= store.pending.alarmAt) fireAlarm();
    else {
      watcher.set(store.pending.alarmAt);
      $('#home-sub').textContent = `알람이 ${fmtClock(store.pending.alarmAt)}에 맞춰져 있습니다.`;
    }
  }
}

init().catch((e) => {
  console.error(e);
  $('#home-sub').textContent = '데이터를 불러오지 못했습니다. 로컬 서버로 열어 주세요.';
});
