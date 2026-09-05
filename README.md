# Arretados 2 Anos

App web: selfie → reconhecimento facial nas fotos do time → vídeo animado.

## Rodar

```bash
cd web
npm install
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000).

## Colocar as fotos

O Instagram bloqueia download anônimo. Opções:

1. **Script com login** (recomendado):

```bash
chmod +x scripts/download-photos.sh
./scripts/download-photos.sh --login SEU_USUARIO_INSTAGRAM
```

As imagens vão para `web/public/photos/`.

2. **Manual:** baixe/exporte as fotos e jogue em `web/public/photos/`.

Reinicie o `npm run dev` depois de adicionar fotos.

## Fluxo

1. Selfie (câmera ou upload)
2. Match facial no álbum local (`face-api`)
3. Vídeo Ken Burns no navegador (WebM) com tema **Arretados 2 anos**

## Higgsfield / Seedance (opcional, depois)

O vídeo local já funciona sem API key. Para motion AI (Higgsfield), dá para plugar depois com `HF_API_KEY_ID` / `HF_API_KEY_SECRET`. Seedance costuma barrar rostos reais sem asset library — Higgsfield DoP encaixa melhor.
