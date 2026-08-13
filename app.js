// 화면 전환 · 전역 상태 · 저장
import { Mixer, NarrationPlayer, createAlarm, setMediaSession } from './audio.js';
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
  settings: { ...DEFAULTS, gapSeconds: 6, narrationVolume: 0.9, ...load('settings', {}) },
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
let draft = { stateId: null, mode: null, hours: 8, napMinutes: 30, custom: false, customMin: 480 };
let napFormMinutes = 30;
let dimTimer = null;
let breathTimer = null;

// ── 화면 ──────────────────────────────────────────────────

function go(name) {
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === `s-${name}`));
  if (name === 'report') renderReport();
  if (name === 'day') { $('#nap-length').hidden = true; }
  window.scrollTo(0, 0);
}

$$('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
$$('[data-back]').forEach((b) => b.addEventListener('click', () => go(b.dataset.back)));

// ── 홈 ────────────────────────────────────────────────────

function tickClock() {
  $('#home-clock').textContent = fmtClock(Date.now());
}

function renderStates() {
  const list = $('#state-list');
  list.innerHTML = '';
  for (const id of manifest.order) {
    const st = manifest.states[id];
    const b = document.createElement('button');
    b.className = 'state';
    b.innerHTML = `<span class="dot"></span><span>${st.label}</span>
                   <svg class="icon arrow"><use href="#i-next"/></svg>`;
    b.addEventListener('click', () => openPrepare(id));
    list.appendChild(b);
  }
}

// ── 준비 ──────────────────────────────────────────────────

// 밤과 낮잠이 같은 화면·같은 컨트롤을 쓴다. 다른 건 프리셋 값과 단위뿐이다.
const DURATION = {
  night: { presets: [5, 6, 7, 8, 9], unit: '시간', head: '몇 시간 잘까요?', min: 30, max: 720 },
  nap:   { presets: [20, 30, 45, 60], unit: '분',  head: '얼마나 잘까요?',   min: 5,  max: 240 },
};

const durMode = () => (manifest.states[draft.stateId]?.night === false ? 'nap' : 'night');
/** 선택한 길이를 분으로. 밤 프리셋은 시간 단위라 60을 곱한다. */
const draftMinutes = () => draft.custom ? draft.customMin
  : durMode() === 'night' ? draft.hours * 60 : draft.napMinutes;

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
    draft.customMin = mode === 'night' ? draft.hours * 60 : draft.napMinutes;
  }

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
  const cfg = DURATION[durMode()];
  const box = $('#hours-chips');
  box.innerHTML = '';

  for (const v of cfg.presets) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = `${v}${cfg.unit}`;
    const on = !draft.custom
      && (durMode() === 'night' ? draft.hours === v : draft.napMinutes === v);
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', () => {
      draft.custom = false;
      if (durMode() === 'night') draft.hours = v; else draft.napMinutes = v;
      syncDuration();
    });
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

  // 밤은 "몇 시에 일어날지"가 자연스럽고, 낮잠은 "몇 분"이 자연스럽다.
  const isNight = durMode() === 'night';
  $('#custom-duration').hidden = !draft.custom;
  $('#custom-time-row').hidden = !isNight;
  $('#custom-min-row').hidden = isNight;
  if (draft.custom) {
    if (isNight) {
      const at = new Date(Date.now() + draft.customMin * 60000);
      $('#wake-input').value = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    } else {
      $('#minutes-input').value = draft.customMin;
    }
  }
}

function syncDuration() {
  renderDurationChips();
  updateWakeLabel();
}

// 일어날 시각 → 길이. 이미 지난 시각이면 다음 날로 넘긴다 (자정을 넘겨 자는 게 정상이다).
$('#wake-input').addEventListener('change', (e) => {
  const [h, m] = e.target.value.split(':').map(Number);
  if (Number.isNaN(h)) return;
  const at = new Date();
  at.setHours(h, m, 0, 0);
  if (at.getTime() <= Date.now() + 60000) at.setDate(at.getDate() + 1);
  draft.customMin = Math.round((at.getTime() - Date.now()) / 60000);
  updateWakeLabel();
});

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
    b.innerHTML = `<span class="art art-${p.art.motif}" aria-hidden="true"></span>
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
  narration = new NarrationPlayer({
    gapSeconds: store.settings.gapSeconds,
    volume: store.settings.narrationVolume,
  });
  mixer.duck(true);

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

function startBreathing() {
  clearInterval(breathTimer);
  const label = $('#breath-label');
  const phases = [['들이쉬기', 4000], ['멈추기', 2000], ['내쉬기', 6000]];
  let i = 0;
  const next = () => {
    label.textContent = phases[i][0];
    breathTimer = setTimeout(() => { i = (i + 1) % phases.length; next(); }, phases[i][1]);
  };
  next();
}

function endSession() {
  narration?.stop();
  clearTimeout(dimTimer);
  clearInterval(breathTimer);
  clearTimeout(breathTimer);
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
  setInterval(tickClock, 20000);
  scenes.set(store.scene);

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
