#!/usr/bin/env sh
# Extrai a trilha de um vídeo pra public/music/tema.m4a (AAC).
#
# Uso: npm run music:extract -- /caminho/do/video.mp4
#
# afconvert é nativo do macOS — não precisa instalar ffmpeg.
set -e

SRC="$1"
if [ -z "$SRC" ]; then
  echo "uso: npm run music:extract -- /caminho/do/video.mp4" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "arquivo não encontrado: $SRC" >&2
  exit 1
fi

mkdir -p public/music
afconvert -f m4af -d aac -b 160000 -s 3 "$SRC" public/music/tema.m4a
echo "OK -> public/music/tema.m4a"
