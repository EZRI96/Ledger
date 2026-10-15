// Minimal service worker. Its only job is to exist: browsers require one as proof the page can work
// offline-enough before they'll offer a real, consistent "Install" prompt. This app always needs the
// network (it talks to Google Sheets), so there is nothing to actually cache — fetch always goes
// straight to the network, same as a normal page load.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
