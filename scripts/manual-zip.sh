#!/bin/sh
# The in-game part as a zip for installing by hand (browsers without folder access, like Firefox):
# dist/etterna-offset-helper-ingame.zip, to extract into the Etterna folder.
set -e
cd "$(dirname "$0")/.."
work=$(mktemp -d)
overlay="$work/Themes/_fallback/BGAnimations/ScreenOffsetHelper overlay"
mkdir -p "$work/OffsetHelper" "$overlay"
cp public/offsethelper.dll "$work/OffsetHelper/"
cp src/theme/offsethelper.lua "$overlay/"
cp src/theme/overlay.lua "$overlay/default.lua"
cat > "$work/INSTALL.txt" <<'TXT'
Etterna offset helper, in-game part (any theme, Windows)
https://maidoffire.github.io/etterna-offset-helper/

On song select, an Offset line: Sync measures the selected song's offset, Apply writes the
recommended one and reloads the song, Undo puts it back, and hovering the result shows the sync
map. The measuring is done in game by OffsetHelper\offsethelper.dll. Drag the word "Offset:" to
move the line; right-click it to put it back.

It is an overlay screen in Themes\_fallback, the theme every theme falls back to, so it shows in
every theme.

Install
1. Extract this zip into the Etterna folder (the one with Songs and Themes in it). It adds the
   OffsetHelper folder and Themes\_fallback\BGAnimations\ScreenOffsetHelper overlay.
2. Open Themes\_fallback\metrics.ini in a text editor. In its [Common] section, put
   ScreenOffsetHelper first in the OverlayScreens line, so that it starts like this:
       OverlayScreens="ScreenOffsetHelper,ScreenSystemLayer,...
3. At the end of the same file, add:
       [ScreenOffsetHelper]
       Class="ScreenWithMenuElementsBasic"
       Fallback="Screen"
       PlayMusic=false
       MusicAlignBeat=false
       DelayMusicSeconds=0
       CancelTransitionsOut=false
       TimerSeconds=-1
       TimerMetricsGroup=
4. Some themes have their own OverlayScreens line in their metrics.ini (Rebirth does). Put
   ScreenOffsetHelper first in that line too.
5. Restart Etterna.

An Etterna update replaces Themes\_fallback: do steps 1 to 3 again after one.

Older versions were installed into Til' Death's or Rebirth's song select: if your theme's
BGAnimations\ScreenSelectMusic decorations (or overlay) folder has an offsethelper.lua, delete it
and take the line t[#t + 1] = LoadActor("offsethelper") out of default.lua there.

Uninstall: take ScreenOffsetHelper out of the OverlayScreens lines and the [ScreenOffsetHelper]
section out of Themes\_fallback\metrics.ini, then delete
Themes\_fallback\BGAnimations\ScreenOffsetHelper overlay and the OffsetHelper folder.
TXT
rm -f dist/etterna-offset-helper-ingame.zip
(cd "$work" && zip -qr -X "$OLDPWD/dist/etterna-offset-helper-ingame.zip" INSTALL.txt OffsetHelper Themes)
rm -rf "$work"
echo "dist/etterna-offset-helper-ingame.zip"
