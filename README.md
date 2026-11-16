# Etterna offset helper

Measures how far a song's `#OFFSET` is off and fixes it, right in Etterna's song select or from a browser tab.

**https://maidoffire.github.io/etterna-offset-helper/**

## In game (Til' Death or Rebirth, Windows)

The helper adds an Offset line to song select (above the banner in Til' Death, in the header in Rebirth). **Sync** measures the selected song, and **Apply** writes the fix and reloads the song. **Undo** puts the old offset back, even after you select another song or restart Etterna. Hover over the result to see the sync map. No browser is needed while you play.

### Install with Chrome or Edge

1. Close Etterna.
2. Open the [helper page](https://maidoffire.github.io/etterna-offset-helper/).
3. Choose your Etterna folder (the one with `Songs` and `Themes`) and allow editing.
4. Click **Install into Til' Death** or **Install into Rebirth**. The original theme file is backed up, and **Uninstall** restores it.
5. Start Etterna.

When the page shows **Update**, click it to get the latest version.

### Install by hand (Firefox, Zen or any other browser)

1. Download [etterna-offset-helper-ingame.zip](https://maidoffire.github.io/etterna-offset-helper/etterna-offset-helper-ingame.zip).
2. Extract it into the Etterna folder.
3. Copy `offsethelper.lua` into your theme and add one line, as `INSTALL.txt` describes.

## Browser only (any theme)

Keep the [helper page](https://maidoffire.github.io/etterna-offset-helper/) open in Chrome or Edge while you play. Choose the Etterna folder (and any extra song folders it asks for). The page then follows `nowplaying.txt` and measures each song as it starts. **Apply offset** writes the fix. Back on song select, press **Ctrl+Shift+R** to reload the song.

If your theme writes `nowplaying.txt` somewhere else, choose the file on the page.

## Good to know

- Only `#OFFSET` changes. Scores stay with the chart, and your global offset isn't touched.
- If the sync drifts along the song, the BPMs are off and one offset can't fix it. Use the sync map in [Better Arrow Vortex](https://maidoffire.github.io/better-arrow-vortex/) instead.

## Development

```bash
npm install
npm run dev
npm test
sh native/build.sh   # the in-game DLL (needs mingw-w64)
```

The DLL decodes MP3 with [minimp3](https://github.com/lieff/minimp3) and OGG with [stb_vorbis](https://github.com/nothings/stb). Both are public domain.
