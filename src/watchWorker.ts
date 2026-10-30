// Reads nowplaying.txt every second and reports when it changes. A worker keeps that pace while
// the tab is in the background, where Chrome slows a page's own timers to once a minute.

let dir: FileSystemDirectoryHandle | null = null;
let seen = '';

self.onmessage = (e: MessageEvent<{ dir: FileSystemDirectoryHandle }>) => {
  dir = e.data.dir;
  seen = '';
};

async function poll(): Promise<void> {
  if (!dir) return;
  try {
    const file = await (await dir.getFileHandle('nowplaying.txt')).getFile();
    const key = `${file.lastModified}:${file.size}`;
    if (key === seen) return;
    seen = key;
    postMessage({ text: await file.text() });
  } catch (err) {
    const name = (err as DOMException).name;
    const key = `error:${name}`;
    if (key === seen) return;
    seen = key;
    postMessage({ error: name === 'NotFoundError' ? 'missing' : name === 'NotAllowedError' ? 'denied' : String(err) });
  }
}

(async () => {
  for (;;) {
    await poll();
    await new Promise((r) => setTimeout(r, 1000));
  }
})();
