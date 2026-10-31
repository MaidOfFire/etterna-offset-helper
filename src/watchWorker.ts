// Reads nowplaying.txt every second and the in-game part's OffsetHelper/request.txt four times a
// second, and reports when either changes. A worker keeps that pace while the tab is in the
// background, where Chrome slows a page's own timers to once a minute.

let dir: FileSystemDirectoryHandle | null = null;
let seen = '';
let seenRequest = '';

self.onmessage = (e: MessageEvent<{ dir: FileSystemDirectoryHandle }>) => {
  dir = e.data.dir;
  seen = '';
  seenRequest = '';
};

async function pollNowPlaying(): Promise<void> {
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

async function pollRequest(): Promise<void> {
  if (!dir) return;
  try {
    const file = await (await (await dir.getDirectoryHandle('OffsetHelper')).getFileHandle('request.txt')).getFile();
    const key = `${file.lastModified}:${file.size}`;
    if (key === seenRequest) return;
    // The request already there when watching starts is an old one (maybe an apply): only new ones count.
    const first = seenRequest === '';
    seenRequest = key;
    if (!first && file.size) postMessage({ request: await file.text() });
  } catch {
    // Not installed, or nothing asked yet: whatever appears next is new.
    seenRequest = 'none';
  }
}

(async () => {
  for (let tick = 0; ; ++tick) {
    if (tick % 4 === 0) await pollNowPlaying();
    await pollRequest();
    await new Promise((r) => setTimeout(r, 250));
  }
})();
