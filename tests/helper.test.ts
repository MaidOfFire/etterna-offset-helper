import { describe, expect, it } from 'vitest';
import { chosenSimfile, findSong, headerTags, parseNowPlaying, songMatches } from '../src/nowPlaying';
import { additionalSongFolders, readOffset, withOffset } from '../src/offsetFile';

/** A folder tree standing in for directory handles: directories are objects, files are strings. */
type Tree = { [name: string]: Tree | string };
function fakeDir(name: string, tree: Tree): FileSystemDirectoryHandle {
  const child = (n: string) => {
    const v = tree[n];
    return typeof v === 'string' ? fakeFile(n, v) : fakeDir(n, v);
  };
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const n of Object.keys(tree)) yield [n, child(n)];
    },
    async getDirectoryHandle(n: string) {
      if (typeof tree[n] !== 'object') throw new DOMException('not found', 'NotFoundError');
      return child(n);
    },
    async getFileHandle(n: string) {
      if (typeof tree[n] !== 'string') throw new DOMException('not found', 'NotFoundError');
      return child(n);
    },
  } as unknown as FileSystemDirectoryHandle;
}
function fakeFile(name: string, text: string): FileSystemFileHandle {
  return { kind: 'file', name, getFile: async () => new File([text], name) } as unknown as FileSystemFileHandle;
}

const sm = (title: string, artist: string, offset = '-0.453') => `#TITLE:${title};\n#ARTIST:${artist};\n#OFFSET:${offset};\n#BPMS:0.000=145.000;\n#NOTES:\n dance-single:\n:\n:\n:\n:\n0000\n;\n`;

describe('Etterna now playing', () => {
  it('reads the line Etterna writes in gameplay and ignores the blank one', () => {
    const np = parseNowPlaying('Now playing Lost in Paradise by Someone in My Pack MSD: 23.45');
    expect(np?.msd).toBe(23.45);
    expect(np?.splits).toEqual([
      { song: 'Lost in Paradise by Someone', pack: 'My Pack' },
      { song: 'Lost', pack: 'Paradise by Someone in My Pack' },
    ]);
    expect(parseNowPlaying(' ')).toBeNull();
  });

  it('matches main or transliterated names, and picks the file Etterna loads', () => {
    const tags = headerTags('#TITLE:ザ;\n#TITLETRANSLIT:Za;\n#ARTIST:X;\n#NOTES:\n#TITLE:not this;');
    expect(tags.TITLE).toBe('ザ');
    expect(songMatches(tags, 'Za by X')).toBe(true);
    expect(songMatches(tags, 'ザ by X')).toBe(true);
    expect(songMatches(tags, 'Zb by X')).toBe(false);
    expect(chosenSimfile(['a.sm', 'a.ssc', 'a.mp3'])).toBe('a.ssc');
    expect(chosenSimfile(['a.SM', 'a.ogg'])).toBe('a.SM');
  });

  it('finds the song in its pack across songs folders', async () => {
    const install = fakeDir('Songs', { 'Other Pack': { Lost: { 'lost.sm': sm('Lost in Paradise', 'Someone') } } });
    const extra = fakeDir('Songs_solo', {
      'My Pack': {
        'Lost (copy)': { 'lost.sm': sm('Lost in Paradise', 'Someone'), 'lost.ssc': sm('Lost in Paradise', 'Someone') },
        Other: { 'other.sm': sm('Other', 'Someone') },
      },
    });
    const np = parseNowPlaying('Now playing Lost in Paradise by Someone in My Pack MSD: 23.45')!;
    const found = await findSong(np, [install, extra]);
    expect(found.map((f) => [f.pack, f.dir.name, f.simfile, f.simfiles])).toEqual([['My Pack', 'Lost (copy)', 'lost.ssc', ['lost.sm', 'lost.ssc']]]);
  });
});

describe('Changing the offset in a simfile', () => {
  const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  const text = (b: Uint8Array) => String.fromCharCode(...b);

  it('changes only the digits, keeping every other byte', () => {
    // A Shift-JIS title (bytes above 127) and a comment mentioning the tag stay as they are.
    const before = bytes('#TITLE:\x83\x55;\r\n// #OFFSET:1;\r\n#OFFSET:-0.453;\r\n#BPMS:0=145;\r\n');
    expect(readOffset(before)).toBe(-0.453);
    const edit = withOffset(before, -0.43868)!;
    expect(edit.old).toBe(-0.453);
    expect(text(edit.bytes)).toBe('#TITLE:\x83\x55;\r\n// #OFFSET:1;\r\n#OFFSET:-0.438680;\r\n#BPMS:0=145;\r\n');
  });

  it('moves .ssc chart offsets that follow the song, keeps ones that differ', () => {
    const ssc = '#OFFSET:0.100000;\n#NOTEDATA:;\n#OFFSET:0.100000;\n#NOTES:\n;\n#NOTEDATA:;\n#OFFSET:0.250000;\n#NOTES:\n;\n';
    const edit = withOffset(bytes(ssc), 0.09)!;
    expect(edit.kept).toBe(1);
    expect(text(edit.bytes)).toBe(ssc.replace(/0\.100000/g, '0.090000'));
  });

  it('reads the extra song folders from Preferences.ini', () => {
    const ini = '[Options]\nAdditionalFolders=\nAdditionalSongFolders=D:\\Games\\common song folder,E:\\Games\\Etterna\\Songs_solo\n';
    expect(additionalSongFolders(ini)).toEqual(['D:\\Games\\common song folder', 'E:\\Games\\Etterna\\Songs_solo']);
    expect(additionalSongFolders('AdditionalSongFolders=\n')).toEqual([]);
  });
});
