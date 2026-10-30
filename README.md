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
src/analysis/       onset curve, sync map, sync fix and MP3 lead-in
src/model/          simfile types, parser and timing
tests/              vitest unit tests
```

`src/analysis` and `src/model` are copied from
[Better Arrow Vortex](https://github.com/MaidOfFire/better-arrow-vortex) (each file says where
from), so a change to how that editor measures sync can be carried over file by file.
