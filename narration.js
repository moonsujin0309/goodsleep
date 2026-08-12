// 나레이션 조립 엔진
// 이 앱의 핵심: 통짜 트랙이 아니라 층별 조각을 뽑아 이어 붙인다.
// 조각 6 × 10 × 5 = 21개로 조합 300개. 여기에 최근 이력 배제를 얹어 반복 체감을 없앤다.

const HISTORY_KEEP = 8;

/**
 * 풀에서 하나 고르되 최근에 나온 건 피한다.
 *
 * 배제 폭이 왜 풀의 1/3인가:
 * 처음엔 pool.length - 1 개를 배제했다. 그러면 후보가 항상 하나만 남아
 * 선택이 결정론적 순환이 된다 — 조합 36개짜리 상태가 12개만 돌았다.
 * 반복을 막으려던 규칙이 반복을 만든 셈이다.
 * 1/3만 배제하면 직전 것은 여전히 확실히 걸러지면서(연속 중복 없음)
 * 후보가 여럿 남아 실제로 무작위가 된다.
 *
 * 풀이 작아도 데드락에 빠지지 않는다 — 후보가 전부 배제되면
 * 이력의 오래된 쪽부터 되살려서 반드시 하나를 반환한다.
 */
export function pickWithHistory(pool, history = [], rand = Math.random) {
  if (!pool || pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  const keep = Math.min(Math.max(Math.round(pool.length / 3), 1), 5);
  let recent = history.slice(0, keep);
  let candidates = pool.filter((p) => !recent.includes(p.id));

  while (candidates.length === 0 && recent.length > 0) {
    recent = recent.slice(0, -1); // 가장 오래된 것부터 놓아준다
    candidates = pool.filter((p) => !recent.includes(p.id));
  }
  if (candidates.length === 0) candidates = pool;

  return candidates[Math.floor(rand() * candidates.length)];
}

export function pushHistory(history = [], id) {
  return [id, ...history.filter((h) => h !== id)].slice(0, HISTORY_KEEP);
}

/**
 * 상태 하나에 대해 재생할 조각 시퀀스를 만든다.
 * 시퀀스 구성은 매니페스트의 sequence 가 정한다 — 코드에 상태별 분기를 두지 않는다.
 *   밤:   ["intro","body","outro"]
 *   깼을 때: ["intro","outro"]        (짧게)
 *   낮잠:  ["intro","body"]           (깊이 들어가면 안 되므로 마무리 없음)
 */
export function buildSequence(state, history = {}, rand = Math.random) {
  const layers = state.sequence || ['intro', 'body', 'outro'];
  const picks = [];
  const nextHistory = { ...history };

  for (const layer of layers) {
    const pool = state[layer];
    if (!pool || pool.length === 0) continue;
    const key = `${state.id}.${layer}`;
    const chosen = pickWithHistory(pool, history[key] || [], rand);
    if (!chosen) continue;
    picks.push({ ...chosen, layer });
    nextHistory[key] = pushHistory(history[key] || [], chosen.id);
  }

  return { picks, nextHistory };
}

/** 매니페스트를 로드하고 각 상태에 id 를 심는다. */
export async function loadManifest(url = 'data/narration.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`나레이션 매니페스트를 불러오지 못했습니다 (${res.status})`);
  const raw = await res.json();
  const states = {};
  for (const [id, s] of Object.entries(raw.states)) states[id] = { ...s, id };
  return { states, order: raw.order || Object.keys(states) };
}
