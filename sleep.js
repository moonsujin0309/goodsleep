// 수면 타이머 · 알람 · 수면부채
// 계산 로직은 전부 순수 함수다. test.js 가 이 파일만 불러서 검증한다.

export const HOUR = 3600000;
export const DAY = 86400000;

export const DEFAULTS = {
  needHours: 8,        // 필요 수면
  sleepOnsetMin: 15,   // 잠드는 데 걸리는 시간 (감지 불가 → 사용자 조절)
  windowDays: 14,
  capHours: 20,        // 부채 상한. 무한히 쌓이면 사용자가 앱을 지운다
};

/** 하룻밤 실제 수면 시간(h). 기록이 잘못됐으면 null. */
export function nightHours(night, sleepOnsetMin = DEFAULTS.sleepOnsetMin) {
  if (!night || typeof night.bedAt !== 'number' || typeof night.wakeAt !== 'number') return null;
  if (!(night.wakeAt > night.bedAt)) return null;
  const h = (night.wakeAt - night.bedAt) / HOUR - sleepOnsetMin / 60;
  return h > 0 ? h : 0;
}

/** 창(window) 안에 드는 밤만 추린다. 기준은 기상 시각. */
export function nightsInWindow(nights = [], now = Date.now(), windowDays = DEFAULTS.windowDays) {
  const since = now - windowDays * DAY;
  return nights.filter((n) => nightHours(n) !== null && n.wakeAt >= since);
}

export function napsInWindow(naps = [], now = Date.now(), windowDays = DEFAULTS.windowDays) {
  const since = now - windowDays * DAY;
  return naps.filter((n) => typeof n.at === 'number' && n.at >= since && n.minutes > 0);
}

/**
 * 누적 수면부채(h).
 *   부채 = clamp( Σ(창 안의 밤) (필요 − 실제) − Σ(창 안의 낮잠), 0, 상한 )
 *
 * 밤별로 0에서 자르지 않는다 — 많이 잔 날의 잉여가 부채를 갚는다.
 * 기록이 없는 날은 아예 계산에 들어가지 않는다 (앱을 안 쓴 날을 부채로 잡으면 안 된다).
 */
export function sleepDebt({
  nights = [],
  naps = [],
  needHours = DEFAULTS.needHours,
  sleepOnsetMin = DEFAULTS.sleepOnsetMin,
  now = Date.now(),
  windowDays = DEFAULTS.windowDays,
  capHours = DEFAULTS.capHours,
} = {}) {
  let debt = 0;
  for (const n of nightsInWindow(nights, now, windowDays)) {
    debt += needHours - nightHours(n, sleepOnsetMin);
  }
  for (const nap of napsInWindow(naps, now, windowDays)) {
    debt -= nap.minutes / 60;
  }
  return Math.min(capHours, Math.max(0, debt));
}

/** 리포트 막대용. 오늘부터 거꾸로 windowDays 일치, 오래된 순. */
export function dailySeries(nights = [], naps = [], now = Date.now(), windowDays = DEFAULTS.windowDays, sleepOnsetMin = DEFAULTS.sleepOnsetMin) {
  const out = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const key = dateKey(d);
    const night = nights.find((n) => n.date === key);
    const napMin = naps.filter((n) => n.date === key).reduce((s, n) => s + n.minutes, 0);
    out.push({
      date: key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      nightH: night ? nightHours(night, sleepOnsetMin) : 0,
      napH: napMin / 60,
      hasData: !!night || napMin > 0,
    });
  }
  return out;
}

export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 밤 기록의 date 는 "잠든 날짜"다.
 * 새벽 3시에 자면 그건 전날 밤이므로 오전 5시 이전은 하루 뒤로 밀지 않는다.
 */
export function nightDateKey(bedAt) {
  const d = new Date(bedAt);
  if (d.getHours() < 5) d.setDate(d.getDate() - 1);
  return dateKey(d);
}

/**
 * 밤 기록을 날짜 기준으로 넣거나 덮어쓴다.
 *
 * 하루에 밤 기록이 둘이면 부채는 둘 다 더하는데 차트는 하나만 그려서 숫자가 어긋난다.
 * 날짜당 하나로 강제한다. 밤중에 깨서 다시 자는 경우는 원래 bedAt 과 알람을
 * 그대로 이어받으므로(자다가 깼어요 흐름) 여기서 잘려 나가지 않는다.
 */
export function upsertNight(nights = [], night) {
  return [...nights.filter((n) => n.date !== night.date && n.bedAt !== night.bedAt), night];
}

export function fmtHours(h) {
  const total = Math.max(0, Math.round(h * 60));
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (hh === 0) return `${mm}분`;
  if (mm === 0) return `${hh}시간`;
  return `${hh}시간 ${mm}분`;
}

export function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 알람 감시자.
 * setTimeout 을 믿지 않는다 — 백그라운드에서 스로틀링되고 드리프트한다.
 * 대신 벽시계(Date.now)를 주기적으로 + 화면이 돌아올 때마다 다시 확인한다.
 */
export function createAlarmWatcher(onFire) {
  let target = null;
  let timer = null;

  const check = () => {
    if (target && Date.now() >= target) {
      const t = target;
      target = null;
      stop();
      onFire(t);
    }
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    document.removeEventListener('visibilitychange', check);
  };

  return {
    set(at) {
      target = at;
      stop();
      timer = setInterval(check, 15000);
      document.addEventListener('visibilitychange', check);
      check();
    },
    cancel() {
      target = null;
      stop();
    },
    get target() {
      return target;
    },
  };
}
