#!/bin/sh
# Builds the native part: a Mac test tool here, and the Windows DLL for Etterna (needs mingw-w64).
set -e
cd "$(dirname "$0")"
mkdir -p build
SRC="offsethelper.c mp3.c ogg.c"
cc -O2 -Wall -Wno-unused-function -o build/oh-cli cli.c $SRC -lm
x86_64-w64-mingw32-gcc -O2 -Wall -Wno-unused-function -shared -static-libgcc -o build/offsethelper.dll $SRC -Wl,--out-implib,build/liboffsethelper.a
x86_64-w64-mingw32-gcc -O2 -o build/oh-cli.exe cli.c -Lbuild -loffsethelper
ls -la build
