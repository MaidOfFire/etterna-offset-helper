# Etterna offset helper

A web page that stays open in a tab while you play Etterna and recommends an offset for whatever
song is playing, with a button to write it into the simfile.

Live: **https://maidoffire.github.io/etterna-offset-helper/** (Chrome or Edge, for folder access)

## Using it

1. Choose the Etterna folder (where Etterna.exe is) and allow editing. The helper reads the extra
   song folders from `Save/Preferences.ini`; add each of those once (pages cannot open a folder by
   its path). The folders are remembered; after a browser restart one click allows them again.
2. Play a song. Etterna's Til' Death and Rebirth themes write `nowplaying.txt` (title, artist,
   pack) when gameplay starts; the helper finds that song and measures it in a second or two.
3. It shows the offset now, the recommended one and the sync map (the music's attacks around the
   chart's beats along the song, as in Better Arrow Vortex's Adjust sync). **Apply offset**
   changes only the `#OFFSET` value in the song's `.ssc`/`.sm`, byte for byte (Undo puts it back).
   Back on song select with the song selected, **Ctrl+Shift+R** makes Etterna read it again.

Chart keys in Etterna hash the notes and BPMs, not the offset, so scores stay with the chart. The
global offset in Etterna's settings is separate and is never touched. If the sync wanders along the
song (BPMs off), one offset cannot fix it: use Fix offset + BPMs in the sync map of
[Better Arrow Vortex](https://maidoffire.github.io/better-arrow-vortex/).

## In game (Til' Death)

The helper can also put a line into Til' Death's song select, just above the banner: **Sync**
measures the selected song, **Apply** writes the recommended offset and reloads the song (as
Ctrl+Shift+R does), **Undo** puts it back, and hovering the result shows the sync map over the
banner. When the helper is not sure, the line offers each choice instead of Apply.

Install it from the helper page (In game card): it adds `offsethelper.lua` to
`Themes/Til Death/BGAnimations/ScreenSelectMusic decorations/` and one line,
`t[#t + 1] = LoadActor("offsethelper")`, to `default.lua` there; the original `default.lua` is
kept in `OffsetHelper/backup/`, and Uninstall takes the line and the file out again. Restart
Etterna after installing.

The measuring runs in game: `OffsetHelper/offsethelper.dll` (Windows), loaded through LuaJIT's
FFI, opens the selected song's music (Etterna's Lua cannot pass binary data) and decodes it the way Etterna plays it, measuring it exactly as this page does,
so no browser is needed while you play. The theme finds the music on disk (Etterna's folder, or the extra song folders in its Preferences.ini) and
takes the beat times from Etterna's timing data, writes `#OFFSET` itself and keeps the original
for Undo. Without the DLL (or its FFI), the line asks this page instead, which must then be open:
the two talk through `OffsetHelper/request.txt` and `OffsetHelper/result.txt` plus `map-*.png`.

**By hand** (any browser, e.g. Firefox or Zen): download `etterna-offset-helper-ingame.zip` from
the page, extract it into the Etterna folder and add the one line to `default.lua` as its
INSTALL.txt says.

### The native part

`native/` is the DLL's source: `offsethelper.c` is a line-for-line port of the measuring in
`src/recommend.ts` and `src/analysis/`, `mp3.c` decodes MP3 with
[minimp3](https://github.com/lieff/minimp3) and `ogg.c` OGG with
[stb_vorbis](https://github.com/nothings/stb) (both public domain, in `native/vendor/`).
`native/build.sh` builds a Mac test tool and, with mingw-w64, the Windows DLL, which is copied to
`public/offsethelper.dll` for the page to install.

Checked on a jumpstream pack (47 songs): the decoders land on Etterna's timeline to the sample
(every MP3 against ffmpeg plus the lead-in Etterna plays, every OGG against libvorbisfile, which
Etterna uses), and the C measuring gives the same choices as the TypeScript on the same samples
(94 measurements, as charted and moved 70 ms).

## How it measures

The same way as Better Arrow Vortex's sync map: a sharp onset curve of the music (log spectral
flux, ~12 ms windows every ~1.5 ms), summed around the chart's beats over stretches of 8 beats,
and the median of where those peaks sit is how far the offset is off. It runs on the timeline
Etterna plays: browsers cut an MP3's encoder lead-in and skip its "Info" header frame, which
Etterna plays as silence, so that time is put back first (25 ms for a LAME VBR file, 51 ms for
CBR at 44.1 kHz).

## When it is not sure

Fast music often has an attack on every 16th note (54-79 ms apart at 190-280 BPM), so a chart far
enough off looks like one in sync a 16th away. The attacks are summed over the whole song out to
±100 ms around the beats; when another place is at least 80% as strong as the chosen one, the
helper says it is not sure and lists the places (strongest first), each with its own Apply. On a
jumpstream pack (44 songs) with offsets moved 40-75 ms on purpose, the right fix was the first
choice 234 times out of 264 and among the choices 260 times; charts as they were (in sync) got
the warning twice out of 44, both songs whose 16ths are 80-93% as strong as their beats. A chart
more than 100 ms off is beyond what it looks at.

The decoding matches Etterna's: Chrome decodes OGG exactly as libvorbisfile (Etterna's decoder)
and ffmpeg do, sample for sample, and MP3s as ffmpeg does once the lead-in is put back.

## Running

```bash
npm install
npm run dev      # http://localhost:5174
npm test
npm run build    # dist/
```

Pushing to main publishes the site to GitHub Pages (`.github/workflows/deploy.yml`).

## Layout

```
src/main.ts         the page: folders, watching, results, Apply / Undo
src/watchWorker.ts  reads nowplaying.txt every second (a worker keeps that pace in a background tab)
src/nowPlaying.ts   reading nowplaying.txt and finding the song folder
src/offsetFile.ts   changing #OFFSET in place; Etterna's extra song folders
src/recommend.ts    the recommended offset for a song, and the other places the beat could be
src/store.ts        the chosen folders, kept in IndexedDB
src/game.ts         the in-game part's requests and answers; adding it to Til' Death
src/theme/          offsethelper.lua, the in-game part (tests/theme/harness.lua runs it against
                    stand-ins for Etterna's Lua functions and a fake DLL: `lua tests/theme/harness.lua`)
native/             the DLL that measures in game (C), its decoders and a test tool
scripts/            manual-zip.sh: the in-game part as a zip, built with the site
src/analysis/       onset curve, sync map, sync fix and MP3 lead-in
src/model/          simfile types, parser and timing
tests/              vitest unit tests
```

`src/analysis` and `src/model` are copied from
[Better Arrow Vortex](https://github.com/MaidOfFire/better-arrow-vortex) (each file says where
from), so a change to how that editor measures sync can be carried over file by file.
