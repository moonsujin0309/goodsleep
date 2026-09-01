// node test.js
// 프레임워크 없음. 계산이 틀리면 여기서 죽는다.

import assert from 'node:assert/strict';
import { sleepDebt, nightHours, dailySeries, nightDateKey, upsertNight, HOUR, DAY } from './sleep.js';
import { pickWithHistory, pushHistory, buildSequence } from './narration.js';
import { fadeEdges } from './synth.js';

const NOW = new Date('2026-08-12T09:00:00').getTime();
const ONSET = 15; // 분

/** daysAgo 일 전에 actualH 시간 잔 밤 하나. */
const night = (daysAgo, actualH) => {
  const wakeAt = NOW - daysAgo * DAY;
  return { date: `d-${daysAgo}`, bedAt: wakeAt - (actualH + ONSET / 60) * HOUR, wakeAt };
};
const nap = (daysAgo, minutes) => ({ date: `d-${daysAgo}`, at: NOW - daysAgo * DAY, minutes });
const debt = (nights, naps = []) => sleepDebt({ nights, naps, now: NOW, sleepOnsetMin: ONSET });

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`\n  FAIL  ${name}\n        ${e.message}\n`);
    process.exitCode = 1;
  }
};
const approx = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} !== ${b}`);

// ── 수면부채 ──────────────────────────────────────────────

test('14일 전부 8시간이면 부채 0', () => {
  const nights = Array.from({ length: 14 }, (_, i) => night(i, 8));
  approx(debt(nights), 0, '부채');
});

test('6시간씩 5일이면 부채 10시간', () => {
  const nights = Array.from({ length: 5 }, (_, i) => night(i, 6));
  approx(debt(nights), 10, '부채');
});

test('부채는 20시간에서 잘린다', () => {
  const nights = Array.from({ length: 14 }, (_, i) => night(i, 1));
  approx(debt(nights), 20, '부채'); // 실제 98시간
});

test('잉여 수면이 부채를 갚는다', () => {
  approx(debt([night(0, 4), night(1, 4), night(2, 12)]), 4, '부채'); // 4+4-4
});

test('기록 없는 날은 부채에 잡히지 않는다', () => {
  approx(debt([night(0, 6)]), 2, '부채'); // 13일치 8시간이 붙으면 안 된다
});

test('창(14일) 밖의 밤은 무시된다', () => {
  approx(debt([night(20, 2)]), 0, '부채');
});

test('wakeAt < bedAt 인 잘못된 기록은 무시된다', () => {
  assert.equal(nightHours({ bedAt: NOW, wakeAt: NOW - HOUR }), null);
  approx(debt([{ date: 'x', bedAt: NOW, wakeAt: NOW - HOUR }, night(0, 6)]), 2, '부채');
});

test('잠드는 시간이 실제 수면에서 빠진다', () => {
  const wakeAt = NOW;
  const n = { date: 'a', bedAt: wakeAt - 8 * HOUR, wakeAt }; // 침대에 8시간
  approx(nightHours(n, 15), 7.75, '실제 수면');
  approx(nightHours(n, 0), 8, '실제 수면');
});

test('실제 수면은 음수로 내려가지 않는다', () => {
  const wakeAt = NOW;
  approx(nightHours({ date: 'a', bedAt: wakeAt - 5 * 60000, wakeAt }, 60), 0, '실제 수면');
});

// ── 낮잠 ──────────────────────────────────────────────────

test('낮잠이 부채를 차감한다', () => {
  approx(debt([night(0, 6)], [nap(0, 60)]), 1, '부채'); // 2 − 1
});

test('하루 낮잠 2건은 합산된다', () => {
  approx(debt([night(0, 6)], [nap(0, 30), nap(0, 30)]), 1, '부채');
});

test('밤 기록이 없는 날의 낮잠도 반영된다', () => {
  // 분리 저장의 핵심 이유. 밤 기록에 붙여뒀다면 이 낮잠은 저장할 곳이 없다.
  approx(debt([night(0, 6)], [nap(5, 90)]), 0.5, '부채'); // 2 − 1.5
});

test('창 밖의 낮잠은 차감되지 않는다', () => {
  approx(debt([night(0, 6)], [nap(20, 120)]), 2, '부채');
});

test('낮잠만 있고 밤 기록이 없으면 부채는 0 (음수로 안 내려감)', () => {
  approx(debt([], [nap(0, 120)]), 0, '부채');
});

// ── 리포트 ────────────────────────────────────────────────

test('dailySeries 는 14칸을 오래된 순으로 낸다', () => {
  const s = dailySeries([], [], NOW);
  assert.equal(s.length, 14);
  assert.ok(new Date(s[0].date) < new Date(s[13].date), '오래된 순이어야 한다');
  assert.ok(s.every((d) => !d.hasData), '데이터가 없으면 hasData 는 false');
});

test('dailySeries 가 밤과 낮잠을 분리해 담는다', () => {
  const today = nightDateKey(NOW);
  const nights = [{ date: today, bedAt: NOW - 6.25 * HOUR, wakeAt: NOW }];
  const naps = [{ date: today, at: NOW, minutes: 30 }];
  const cell = dailySeries(nights, naps, NOW).find((d) => d.date === today);
  approx(cell.nightH, 6, '밤');
  approx(cell.napH, 0.5, '낮잠');
  assert.ok(cell.hasData);
});

test('새벽 3시 취침은 전날 밤으로 기록된다', () => {
  assert.equal(nightDateKey(new Date('2026-08-12T03:00:00').getTime()), '2026-08-11');
  assert.equal(nightDateKey(new Date('2026-08-12T23:30:00').getTime()), '2026-08-12');
});

test('같은 날짜의 밤 기록은 덮어쓴다', () => {
  // 하루에 둘이면 부채는 둘 다 더하는데 차트는 하나만 그려서 숫자가 어긋난다
  const a = { date: '2026-08-11', bedAt: 1, wakeAt: 2 };
  const b = { date: '2026-08-11', bedAt: 9, wakeAt: 10 };
  const out = upsertNight([a], b);
  assert.equal(out.length, 1);
  assert.equal(out[0].bedAt, 9);
});

test('다른 날짜의 밤 기록은 유지된다', () => {
  const a = { date: '2026-08-10', bedAt: 1, wakeAt: 2 };
  const b = { date: '2026-08-11', bedAt: 9, wakeAt: 10 };
  assert.equal(upsertNight([a], b).length, 2);
});

test('날짜당 하나가 보장되어 부채와 차트가 어긋나지 않는다', () => {
  const wake = NOW;
  let nights = [];
  // 같은 밤을 두 번 기록해도 6시간짜리 하나로 남는다
  for (const h of [3, 6]) {
    nights = upsertNight(nights, { date: nightDateKey(wake), bedAt: wake - (h + 0.25) * HOUR, wakeAt: wake });
  }
  approx(debt(nights), 2, '부채');
  const cell = dailySeries(nights, [], NOW).find((d) => d.date === nightDateKey(wake));
  approx(cell.nightH, 6, '차트');
});

// ── 나레이션 중복 회피 ────────────────────────────────────

const pool = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));

test('풀이 1개면 항상 그것을 반환한다', () => {
  const p = pool(1);
  for (let i = 0; i < 20; i++) assert.equal(pickWithHistory(p, ['p0']).id, 'p0');
});

test('연속으로 같은 조각이 나오지 않는다', () => {
  const p = pool(3);
  let history = [];
  let prev = null;
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const got = pickWithHistory(p, history);
    assert.ok(got, '항상 무언가를 반환해야 한다');
    assert.notEqual(got.id, prev, `${i}번째에서 연속 중복`);
    seen.add(got.id);
    history = pushHistory(history, got.id);
    prev = got.id;
  }
  assert.equal(seen.size, 3, '모든 조각이 결국 등장해야 한다');
});

test('풀이 작아도 데드락에 빠지지 않는다', () => {
  // 이력이 풀보다 길어서 모든 후보가 배제되는 상황
  const p = pool(2);
  const history = ['p0', 'p1', 'p0', 'p1', 'p0', 'p1'];
  for (let i = 0; i < 20; i++) assert.ok(pickWithHistory(p, history), '반드시 하나는 나와야 한다');
});

test('풀에 없는 id 가 이력에 남아 있어도 정상 동작한다', () => {
  const p = pool(3);
  assert.ok(pickWithHistory(p, ['사라진조각', '또다른조각']));
});

test('pushHistory 는 중복 없이 앞에 쌓고 8개로 자른다', () => {
  let h = [];
  for (let i = 0; i < 12; i++) h = pushHistory(h, `x${i}`);
  assert.equal(h.length, 8);
  assert.equal(h[0], 'x11');
  h = pushHistory(h, 'x11');
  assert.equal(h.filter((x) => x === 'x11').length, 1, '중복이 쌓이면 안 된다');
});

// ── 시퀀스 조립 ───────────────────────────────────────────

const state = (sequence) => ({
  id: 's',
  sequence,
  intro: pool(3).map((p) => ({ ...p, id: 'i' + p.id })),
  body: pool(4).map((p) => ({ ...p, id: 'b' + p.id })),
  outro: pool(3).map((p) => ({ ...p, id: 'o' + p.id })),
});

test('시퀀스는 매니페스트가 정한 층만 재생한다', () => {
  const short = buildSequence(state(['intro', 'outro']), {});
  assert.deepEqual(short.picks.map((p) => p.layer), ['intro', 'outro'], '깼을 때는 body 없음');

  const napSeq = buildSequence(state(['intro', 'body']), {});
  assert.deepEqual(napSeq.picks.map((p) => p.layer), ['intro', 'body'], '낮잠은 outro 없음');

  const full = buildSequence(state(['intro', 'body', 'outro']), {});
  assert.deepEqual(full.picks.map((p) => p.layer), ['intro', 'body', 'outro']);
});

test('시퀀스 조립이 층별 이력을 갱신한다', () => {
  const s = state(['intro', 'body', 'outro']);
  const { picks, nextHistory } = buildSequence(s, {});
  for (const p of picks) assert.equal(nextHistory[`s.${p.layer}`][0], p.id);
});

test('빈 층은 건너뛴다', () => {
  const s = { id: 's', sequence: ['intro', 'body', 'outro'], intro: pool(2), body: [], outro: pool(2) };
  assert.equal(buildSequence(s, {}).picks.length, 2);
});

test('연속 재생해도 같은 조합이 바로 반복되지 않는다', () => {
  const s = state(['intro', 'body', 'outro']);
  let history = {};
  const combos = new Set();
  let prev = null;
  for (let i = 0; i < 50; i++) {
    const r = buildSequence(s, history);
    const key = r.picks.map((p) => p.id).join('+');
    assert.notEqual(key, prev, `${i}번째에서 조합이 그대로 반복됨`);
    combos.add(key);
    history = r.nextHistory;
    prev = key;
  }
  assert.ok(combos.size > 20, `조합 다양성이 부족하다 (${combos.size}종)`);
});

// ── 루프 겹치기 페이드 ────────────────────────────────────
// 아이폰은 재생 중 볼륨을 못 바꿔서, 크로스페이드를 소스 양 끝에 미리 구워 둔다.
// 두 벌을 겹쳐 트는 것만으로 소리 크기가 일정해야 한다 — 안 그러면 루프마다 부풀거나 파인다.

test('페이드를 구운 두 벌을 겹치면 파워가 일정하다', () => {
  const rate = 100;
  const n = rate * 5;
  const flat = { left: new Float32Array(n).fill(1), right: new Float32Array(n).fill(1), rate };
  const sec = 1.2;
  const w = fadeEdges(flat, sec);
  const f = Math.floor(rate * sec);

  // 겹치는 구간: 새 벌의 머리 i 번째와 옛 벌의 꼬리가 같은 순간에 만난다.
  // 무상관 노이즈라 파워(제곱)가 더해진다 — 합이 1 이어야 크기가 안 변한다.
  for (let i = 0; i < f; i++) {
    const head = w.left[i];
    const tail = w.left[n - f + i];
    approx(head * head + tail * tail, 1, `겹침 ${i}번째 파워`);
  }
  // 가운데는 손대지 않는다
  approx(w.left[Math.floor(n / 2)], 1, '가운데 이득');
  approx(flat.left[0], 1, '원본이 그대로 남아 있어야 한다');
});

test('페이드 구간이 소스보다 길면 잘려서 들어간다', () => {
  const rate = 100;
  const n = 90;                       // 0.9초짜리 — 1.2초 페이드는 못 넣는다
  const flat = { left: new Float32Array(n).fill(1), right: new Float32Array(n).fill(1), rate };
  const w = fadeEdges(flat, 1.2);
  assert.ok(w.left[Math.floor(n / 2)] === 1, '가운데는 온전해야 한다');
  assert.ok(w.left[0] < 1 && w.left[n - 1] < 1, '양 끝은 깎여 있어야 한다');
});

console.log(`\n  ${passed}개 통과${process.exitCode ? ' — 실패 있음' : ''}\n`);
