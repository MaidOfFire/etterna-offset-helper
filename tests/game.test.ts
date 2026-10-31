import { describe, expect, it } from 'vitest';
import { LOAD_LINE, formatFields, parseFields, parseRequest, songPath, withLoadLine, withoutLoadLine } from '../src/game';

const DECORATIONS = `local t = Def.ActorFrame {}

t[#t + 1] = LoadActor("tabs")
t[#t + 1] = LoadActor("stepsdisplay")

t[#t + 1] = LoadActor("../_mousewheelscroll")
collectgarbage()
return t
`;

describe('talking to the in-game part', () => {
  it('reads the requests the theme writes', () => {
    expect(parseRequest('id=1234\naction=apply\ndir=/Songs/Pack/Song/\nfile=/Songs/Pack/Song/a.sm\nchoice=2\n')).toEqual({ id: '1234', action: 'apply', dir: '/Songs/Pack/Song/', choice: 2 });
    expect(parseRequest('id=1\r\naction=measure\r\ndir=/AdditionalSongs/P/S/\r\n')).toEqual({ id: '1', action: 'measure', dir: '/AdditionalSongs/P/S/', choice: undefined });
    expect(parseRequest('id=1\naction=delete\ndir=/Songs/P/S/\n')).toBeNull();
    expect(parseRequest('')).toBeNull();
  });

  it('writes results the theme can read back, one value per line', () => {
    const text = formatFields({ id: 7, status: 'error', message: 'two\nlines', skipped: undefined });
    expect(text).toBe('id=7\nstatus=error\nmessage=two lines\n');
    expect(parseFields(text)).toEqual({ id: '7', status: 'error', message: 'two lines' });
  });

  it('finds which songs folder a song is in', () => {
    expect(songPath('/Songs/My Pack/My Song/')).toEqual({ root: 'Songs', pack: 'My Pack', song: 'My Song' });
    expect(songPath('/AdditionalSongs/P/S/')).toEqual({ root: 'AdditionalSongs', pack: 'P', song: 'S' });
    expect(songPath('/Themes/x/y/')).toBeNull();
    expect(songPath('/Songs/P/')).toBeNull();
  });

  it("adds the in-game part to Til' Death's song select once, and takes it out again", () => {
    const patched = withLoadLine(DECORATIONS)!;
    expect(patched).toContain(`t[#t + 1] = LoadActor("../_mousewheelscroll")\n${LOAD_LINE}\ncollectgarbage()\nreturn t\n`);
    expect(withLoadLine(patched)).toBe(patched);
    expect(withoutLoadLine(patched)).toBe(DECORATIONS);
    // Windows line endings, and a file without collectgarbage().
    const crlf = 'local t = Def.ActorFrame {}\r\nt[#t + 1] = LoadActor("tabs")\r\nreturn t\r\n';
    expect(withLoadLine(crlf)).toBe(`local t = Def.ActorFrame {}\r\nt[#t + 1] = LoadActor("tabs")\r\n${LOAD_LINE}\r\nreturn t\r\n`);
    expect(withoutLoadLine(withLoadLine(crlf)!)).toBe(crlf);
    expect(withLoadLine('return something_else')).toBeNull();
  });
});
