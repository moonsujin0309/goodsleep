// 오프라인 지원. 밤중에 네트워크가 끊겨도 앱과 이미 들은 나레이션은 나와야 한다.
//
// 전략 두 갈래:
//   앱 파일(html/css/js/json) — 네트워크 우선, 실패하면 캐시.
//     배포가 즉시 반영되고, 끊겼을 때만 캐시가 받친다. 버전 올리기를 잊어도 안전.
//   나레이션 mp3 — 캐시 우선.
//     한 번 들은 조각은 다시 받지 않는다. 내용이 바뀌는 배포에서만 VER 을 올린다.
const VER = 'goodsleep-v6';   // 2026-08-25 아이폰 볼륨 굽기 — 낡은 앱 파일이 남지 않게 캐시를 비운다
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.json',
  'app.js', 'audio.js', 'narration.js', 'sleep.js', 'scenes.js',
  'data/narration.json', 'data/sounds.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.endsWith('.mp3') || url.pathname.endsWith('.mp4')) {
    e.respondWith(caches.open(VER).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(e.request);
      // 206(Range 응답)은 cache.put 이 던진다 — 온전한 200만 저장한다.
      if (res.status === 200) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }

  // cache: 'reload' — 이게 없으면 브라우저 HTTP 캐시가 낡은 앱 파일을 그대로 돌려줘서
  // "네트워크 우선"이 이름뿐이 된다 (배포해도 화면이 안 바뀌는 정체). 실측으로 걸렸다.
  e.respondWith(
    fetch(new Request(e.request, { cache: 'reload' })).then((res) => {
      if (res.status === 200) caches.open(VER).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
