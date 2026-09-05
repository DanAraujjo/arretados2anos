#!/usr/bin/env bash
# Baixa fotos do Instagram @arretadosdovolei para web/public/photos
# Uso:
#   ./scripts/download-photos.sh
#   ./scripts/download-photos.sh --login SEU_USUARIO_INSTAGRAM

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/web/public/photos"
VENV="$ROOT/.venv"
PROFILE="arretadosdovolei"

mkdir -p "$OUT"

if [[ ! -x "$VENV/bin/instaloader" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q instaloader
fi

ARGS=(
  --dirname-pattern="$OUT"
  --filename-pattern="{date_utc}_UTC_{shortcode}"
  --no-videos
  --no-video-thumbnails
  --no-metadata-json
  --no-captions
  --no-compress-json
)

if [[ "${1:-}" == "--login" ]]; then
  if [[ -z "${2:-}" ]]; then
    echo "Informe o usuário: ./scripts/download-photos.sh --login SEU_USUARIO"
    exit 1
  fi
  ARGS+=(--login="$2")
fi

echo "Baixando fotos de @$PROFILE → $OUT"
"$VENV/bin/instaloader" "${ARGS[@]}" "$PROFILE"

# limpa txts residuais se aparecerem
find "$OUT" -type f \( -name '*.txt' -o -name '*.xz' -o -name '*.json' \) -delete 2>/dev/null || true

echo "Pronto. $(find "$OUT" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) | wc -l | tr -d ' ') fotos em $OUT"
