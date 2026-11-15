#!/bin/sh
# The in-game part as a zip for installing by hand (browsers without folder access, like Firefox):
# dist/etterna-offset-helper-ingame.zip, to extract into the Etterna folder.
set -e
cd "$(dirname "$0")/.."
work=$(mktemp -d)
mkdir -p "$work/OffsetHelper"
cp src/theme/offsethelper.lua public/offsethelper.dll "$work/OffsetHelper/"
cat > "$work/INSTALL.txt" <<'TXT'
Etterna offset helper, in-game part (Til' Death or Rebirth, Windows)
https://maidoffire.github.io/etterna-offset-helper/

On song select, an Offset line: Sync measures the selected song's offset, Apply writes the
recommended one and reloads the song, Undo puts it back, and hovering the result shows the sync
map over the banner. The measuring is done in game by OffsetHelper\offsethelper.dll.

Install
1. Extract this zip into the Etterna folder (the one with Songs and Themes in it). It adds the
   OffsetHelper folder.
2. Copy OffsetHelper\offsethelper.lua into your theme's song select folder:
     Til' Death:  Themes\Til Death\BGAnimations\ScreenSelectMusic decorations\
     Rebirth:     Themes\Rebirth\BGAnimations\ScreenSelectMusic overlay\
3. Open default.lua in that same folder in a text editor and add this line just before
   "return t" at the end (in Til' Death, before "collectgarbage()"):
       t[#t + 1] = LoadActor("offsethelper")
4. Restart Etterna.

Uninstall: take that line out of default.lua again, and delete offsethelper.lua there and the
OffsetHelper folder.
TXT
rm -f dist/etterna-offset-helper-ingame.zip
(cd "$work" && zip -qr -X "$OLDPWD/dist/etterna-offset-helper-ingame.zip" INSTALL.txt OffsetHelper)
rm -rf "$work"
echo "dist/etterna-offset-helper-ingame.zip"
