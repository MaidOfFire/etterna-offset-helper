import { describe, expect, it } from 'vitest';
import { LOAD_LINE, OVERLAY_SCREEN, formatFields, overlayState, parseFields, parseRequest, songPath, withLoadLine, withOverlay, withoutLoadLine, withoutOverlay } from '../src/game';

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

  it("loads the in-game part from Rebirth's song select overlay", () => {
    // Rebirth's BGAnimations/ScreenSelectMusic overlay/default.lua, which ends without a newline.
    const overlay = `local t = Def.ActorFrame {}

t[#t+1] = LoadActor("../_mouse.lua")

-- header
t[#t+1] = LoadActorWithParams("../playerInfoFrame/main.lua", {visualizer = themeConfig:get_data().global.ShowVisualizer, screen = "ScreenSelectMusic"})
updateDiscordStatusForMenus()
updateNowPlaying()

return t`;
    const patched = withLoadLine(overlay)!;
    expect(patched).toBe(overlay.replace('updateNowPlaying()\n', `updateNowPlaying()\n${LOAD_LINE}\n`));
    expect(withoutLoadLine(patched)).toBe(overlay);
  });
});

// As in Etterna's Themes/_fallback/metrics.ini and Themes/Rebirth/metrics.ini (shortened).
const FALLBACK = `[Global]
FallbackTheme=

[Common]
# Screens that show over everything else.
OverlayScreens="ScreenSystemLayer,ScreenSyncOverlay,ScreenStatsOverlay,ScreenDebugOverlay,ScreenInstallOverlay,ScreenChatOverlay"
PercentScoreDecimalPlaces=2

[ScreenSelectMusic]
OverlayScreens="not this one"
`;
const REBIRTH = '[Common]\r\nScreenHeight=720\r\nOverlayScreens="ScreenSystemLayer,ScreenToolTipOverlay"\r\n\r\n[ComboGraph]\r\nBodyWidth=1\r\n';

describe('the overlay screen in metrics.ini', () => {
  it('puts the helper first in [Common] OverlayScreens and adds its section to _fallback', () => {
    const out = withOverlay(FALLBACK, true);
    expect(out).toContain(`OverlayScreens="${OVERLAY_SCREEN},ScreenSystemLayer,ScreenSyncOverlay,ScreenStatsOverlay,ScreenDebugOverlay,ScreenInstallOverlay,ScreenChatOverlay"`);
    expect(out).toContain('OverlayScreens="not this one"');
    expect(out).toMatch(/\n\n\[ScreenOffsetHelper\]\n#[^\n]*\nClass="ScreenWithMenuElementsBasic"\nFallback="Screen"\n[\s\S]*TimerMetricsGroup=\n$/);
    expect(overlayState(out)).toEqual({ lists: 1, withUs: 1, section: true });
    expect(overlayState(FALLBACK)).toEqual({ lists: 1, withUs: 0, section: false });
    expect(withOverlay(out, true)).toBe(out);
  });

  it('adds only the name to a theme with its own list, keeping its line endings', () => {
    const out = withOverlay(REBIRTH, false);
    expect(out).toBe(REBIRTH.replace('OverlayScreens="', `OverlayScreens="${OVERLAY_SCREEN},`));
    expect(overlayState(out)).toEqual({ lists: 1, withUs: 1, section: false });
    expect(withOverlay('[Common]\nScreenHeight=480\n', false)).toBe('[Common]\nScreenHeight=480\n');
  });

  it('takes it out again, leaving the rest (and other add-ons in the list) as they were', () => {
    expect(withoutOverlay(withOverlay(FALLBACK, true))).toBe(FALLBACK);
    expect(withoutOverlay(withOverlay(REBIRTH, false))).toBe(REBIRTH);
    const other = FALLBACK.replace('ScreenChatOverlay"', 'ScreenChatOverlay,ScreenSomeAddon"');
    expect(withoutOverlay(withOverlay(other, true))).toBe(other);
    expect(withoutOverlay(FALLBACK)).toBe(FALLBACK);
    const noNewline = FALLBACK.trimEnd();
    expect(withoutOverlay(withOverlay(noNewline, true))).toBe(noNewline + '\n');
  });
});
