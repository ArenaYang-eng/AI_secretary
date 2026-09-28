/* AI 隨身小秘書 Service Worker
   1. 網路優先快取（離線時用備份）
   2. 接收 Web Push，顯示系統通知（iPhone 背景 / 鎖定畫面也能響） */

const CACHE = 'secretary-v4'; // 版本號往上加，才會清掉舊快取
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CORE_ASSETS))
      .catch(() => {})
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // 只處理同網域，不快取推播後端 API 或其他網站
  if (new URL(e.request.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(r => r || caches.match('./index.html'))
      )
  );
});

/* ---------- Web Push ---------- */

// iOS 規定：每次 push 事件「一定」要顯示通知，否則訂閱會被系統撤銷
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  const title = d.title || '⏰ 小秘書提醒';
  e.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || '有一則提醒時間到了',
      icon: './icon-192.png',
      badge: './icon-192.png',
      // 每次用不同 tag，確保重推時每次都會重新發出提示音
      tag: 'rem-' + (d.id || '') + '-' + (d.n || 1),
      data: { id: d.id || '' },
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', e => {
  const id = e.notification.data && e.notification.data.id;
  e.notification.close();
  e.waitUntil((async () => {
    // 關掉同一筆提醒的其他通知
    const all = await self.registration.getNotifications();
    all.filter(n => n.data && n.data.id === id).forEach(n => n.close());

    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return clients.openWindow('./index.html');
  })());
});
