// OTTOV 예약 (폰 웹앱): 화면 파일만 저장해 둔다. 예약·계정은 늘 서버에서 새로 받는다.
const CACHE = "ottov-m-v5";
const SHELL = ["./", "index.html", "app.css", "app.js", "ai.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
// 같은 주소의 화면 파일: 먼저 인터넷에서 (새 버전), 안 되면 저장해 둔 것
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    // no-cache: GitHub Pages가 10분 동안 옛 파일을 주지 않게, 늘 새 파일인지 확인한다
    fetch(e.request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))),
  );
});
