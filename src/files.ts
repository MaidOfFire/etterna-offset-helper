// Folder access (File System Access API, Chrome and Edge) and finding files in a song folder.

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker?: (opts?: {
      id?: string;
      startIn?: FileSystemHandle;
      types?: { description: string; accept: Record<string, string[]> }[];
    }) => Promise<FileSystemFileHandle[]>;
  }
  interface FileSystemHandle {
    queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  }
}

const AUDIO_EXTS = ['.ogg', '.mp3', '.wav', '.flac', '.oga', '.opus', '.m4a', '.aac'];

/** A file or folder in a folder by name, ignoring case; null when there is none. */
export async function findChild<K extends 'file' | 'directory'>(
  dir: FileSystemDirectoryHandle,
  name: string,
  kind: K,
): Promise<(K extends 'file' ? FileSystemFileHandle : FileSystemDirectoryHandle) | null> {
  type Out = K extends 'file' ? FileSystemFileHandle : FileSystemDirectoryHandle;
  try {
    return (kind === 'file' ? await dir.getFileHandle(name) : await dir.getDirectoryHandle(name)) as Out;
  } catch {
    for await (const [n, h] of dir.entries()) if (h.kind === kind && n.toLowerCase() === name.toLowerCase()) return h as Out;
    return null;
  }
}

/** A file by a simfile's path to it (case-insensitive, sub-folders allowed), or null. */
export async function findFile(dir: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  let at = dir;
  for (let i = 0; i < parts.length; ++i) {
    let found: FileSystemHandle | null = null;
    for await (const [n, h] of at.entries()) {
      if (n.toLowerCase() === parts[i].toLowerCase()) {
        found = h;
        break;
      }
    }
    if (!found) return null;
    if (i === parts.length - 1) return found.kind === 'file' ? (found as FileSystemFileHandle).getFile() : null;
    if (found.kind !== 'directory') return null;
    at = found as FileSystemDirectoryHandle;
  }
  return null;
}

/** The first audio file in a folder, for songs whose #MUSIC names a file that is not there. */
export async function firstAudio(dir: FileSystemDirectoryHandle): Promise<File | null> {
  for await (const [n, h] of dir.entries()) {
    const dot = n.lastIndexOf('.');
    if (h.kind === 'file' && dot >= 0 && AUDIO_EXTS.includes(n.slice(dot).toLowerCase())) return (h as FileSystemFileHandle).getFile();
  }
  return null;
}
