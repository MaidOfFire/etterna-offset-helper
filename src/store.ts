// The folders the helper was given, kept in IndexedDB so they are there after a reload (the
// browser still asks once per visit before reading them again, unless allowed on every visit).

export interface SongsFolder {
  /** The path from Etterna's Preferences.ini, or the folder's name when added by hand. */
  path: string;
  handle: FileSystemDirectoryHandle;
}

export interface Folders {
  install: FileSystemDirectoryHandle | null;
  extra: SongsFolder[];
  /** Etterna's Preferences.ini chosen by hand, when the one in Save could not be read. */
  prefsFile?: FileSystemFileHandle;
  /** The now-playing file chosen by hand, for themes that write it somewhere else than nowplaying.txt in the Etterna folder. */
  nowPlayingFile?: FileSystemFileHandle;
}

const DB = 'etterna-offset-helper';
const STORE = 'state';

function open(): Promise<IDBDatabase | null> {
  if (!('indexedDB' in globalThis)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function loadFolders(): Promise<Folders> {
  const db = await open();
  const empty: Folders = { install: null, extra: [] };
  if (!db) return empty;
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get('folders');
    req.onsuccess = () => resolve((req.result as Folders | undefined) ?? empty);
    req.onerror = () => resolve(empty);
  }).finally(() => db.close()) as Promise<Folders>;
}

export async function saveFolders(folders: Folders): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(folders, 'folders');
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
  db.close();
}
