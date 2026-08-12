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
let draft = { stateId: null, hours: 8, napMinutes: 30 };
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

const HOUR_CHOICES = [5, 6, 7, 8, 9];

function openPrepare(stateId) {
  draft.stateId = stateId;
  $('#prep-state').textContent = manifest.states[stateId].label;

  // 자다 깬 경우는 알람을 다시 잡지 않는다. 새벽 3시에 깬 사람의 알람을 날려먹으면 안 된다.
  const resuming = stateId === 'awoken' && store.pending;
  $('#prep-h').textContent = resuming ? '다시 잠들기' : '몇 시간 잘까요?';
  $('#hours-chips').hidden = resuming;
  if (resuming) {
    $('#prep-wake').textContent = `알람은 ${fmtClock(store.pending.alarmAt)} 그대로입니다.`;
  }

  renderHourChips();
  renderSceneChips();
  renderMixer();
  updateWakeLabel();
  go('prepare');
}

function renderHourChips() {
  const box = $('#hours-chips');
  box.innerHTML = '';
  for (const h of HOUR_CHOICES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = `${h}시간`;
    b.setAttribute('aria-pressed', String(h === draft.hours));
    b.addEventListener('click', () => {
      draft.hours = h;
      renderHourChips();
      updateWakeLabel();
    });
    box.appendChild(b);
  }
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
      mixer.unlock().then(() => mixer.setVolume(def.id, v));
    });

    row.classList.toggle('is-on', saved > 0);
    box.appendChild(row);
  }
}

function updateWakeLabel() {
  if (draft.stateId === 'awoken' && store.pending) return;
  const at = Date.now() + draft.hours * HOUR;
  $('#prep-wake').textContent = `${fmtClock(at)}에 깨워 드립니다.`;
}

$('#start-btn').addEventListener('click', () => startSession(draft.stateId, draft.hours, false));

// ── 낮 ────────────────────────────────────────────────────

const NAP_CHOICES = [20, 30, 45, 60];

$$('[data-day]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.day === 'calm') return startSession('calm', 0, false);
  renderNapChips();
  $('#nap-length').hidden = false;
  $('#nap-length').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}));

function renderNapChips() {
  const box = $('#nap-chips');
  box.innerHTML = '';
  for (const m of NAP_CHOICES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = `${m}분`;
    b.setAttribute('aria-pressed', String(m === draft.napMinutes));
    b.addEventListener('click', () => { draft.napMinutes = m; renderNapChips(); });
    box.appendChild(b);
  }
}

$('#nap-start').addEventListener('click', () => startSession('nap', draft.napMinutes / 60, true));

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

  const [nar, snd] = await Promise.all([
    loadManifest(),
    fetch('data/sounds.json').then((r) => r.json()),
  ]);
  manifest = { ...nar, sounds: snd.layers };

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
