#!/bin/sh
# The in-game part as a zip for installing by hand (browsers without folder access, like Firefox):
# dist/etterna-offset-helper-ingame.zip, to extract into the Etterna folder.
set -e
cd "$(dirname "$0")/.."
work=$(mktemp -d)
decorations="$work/Themes/Til Death/BGAnimations/ScreenSelectMusic decorations"
mkdir -p "$decorations" "$work/OffsetHelper"
cp src/theme/offsethelper.lua "$decorations/"
cp public/offsethelper.dll "$work/OffsetHelper/"
cat > "$work/INSTALL.txt" <<'TXT'
Etterna offset helper, in-game part (Til' Death, Windows)
https://maidoffire.github.io/etterna-offset-helper/

On song select, an Offset line above the banner: Sync measures the selected song's offset, Apply
writes the recommended one and reloads the song, Undo puts it back, and hovering the result shows
the sync map over the banner. The measuring is done in game by OffsetHelper\offsethelper.dll.

Install
1. Extract this zip into the Etterna folder (the one with Songs and Themes in it), merging the
   folders: it adds OffsetHelper\offsethelper.dll and
   Themes\Til Death\BGAnimations\ScreenSelectMusic decorations\offsethelper.lua.
2. Open Themes\Til Death\BGAnimations\ScreenSelectMusic decorations\default.lua in a text editor
   and add this line just before "collectgarbage()" (or before "return t" at the end):
       t[#t + 1] = LoadActor("offsethelper")
3. Restart Etterna.

Uninstall: take that line out of default.lua again, and delete offsethelper.lua and the
OffsetHelper folder.
TXT
rm -f dist/etterna-offset-helper-ingame.zip
(cd "$work" && zip -qr -X "$OLDPWD/dist/etterna-offset-helper-ingame.zip" INSTALL.txt OffsetHelper Themes)
rm -rf "$work"
echo "dist/etterna-offset-helper-ingame.zip"
