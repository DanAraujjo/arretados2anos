# Arretados 2 anos — web

Next.js: selfie → match facial → vídeo retrospectiva.

## Local

```bash
cd web
npm install
npm run dev
```

Fotos em `web/public/photos/` (~442 MB — cabe tranquilo em host com disco).

## Publicar no Render (app + fotos juntos)

1. As fotos precisam ir no Git (ainda não estão versionadas):

```bash
cd /Users/daniel/Projects/Pessoal/Arretados
git add web/public/photos
git commit -m "Add album photos for Render deploy"
git push
```

(~442 MB — ok pro GitHub em muitos arquivos pequenos; se reclamar, use Git LFS.)

2. [render.com](https://render.com) → **New → Web Service** → conecte o repo  
   - **Root Directory:** `web`  
   - **Build:** `npm install && npm run build`  
   - **Start:** `npm run start`  
   - **Instance:** Free  

Ou use o Blueprint: **New → Blueprint** com o `render.yaml` na raiz do repo.

3. Sem env de fotos — o app lê `public/photos` no próprio servidor.

**Obs.:** no plano free o site “dorme” sem visita (~1 min pra acordar). Cartão: a Render às vezes pede verificação; se pedir, use o caminho GitHub+jsDelivr+Vercel.

## Publicar sem cartão: GitHub + Vercel

R2 e Railway pedem cartão. Este caminho não.

### 1) Repo só das fotos (público)

```bash
cd web
npm run manifest:photos
```

Crie no GitHub um repo público, ex: `arretados-photos`, e envie o conteúdo de `web/public/photos/` (com o `manifest.json`).

### 2) URL pública (jsDelivr)

Se as fotos estão na **raiz** do repo:

```text
https://cdn.jsdelivr.net/gh/SEU_USER/arretados-photos@main
```

Se estão numa pasta `photos/`:

```text
https://cdn.jsdelivr.net/gh/SEU_USER/arretados-photos@main/photos
```

### 3) App na Vercel

- Root: `web`
- Env: `NEXT_PUBLIC_PHOTOS_BASE_URL` = URL do passo 2 (sem barra no final)
- Não precisa subir as 442 MB no deploy do app

Local pra testar com CDN:

```bash
# web/.env.local
NEXT_PUBLIC_PHOTOS_BASE_URL=https://cdn.jsdelivr.net/gh/SEU_USER/arretados-photos@main
```

### CORS
jsDelivr / raw GitHub liberam GET — o canvas e o face-api funcionam com `crossOrigin=anonymous` (já está no código).

## Alternativa paga / com cartão

- **Railway** (trial) / **Render** / **Fly** — app + fotos juntos
- **Vercel + Cloudflare R2** — R2 exige cartão mesmo no free

## Scripts

| Script | Função |
|--------|--------|
| `npm run dev` | Dev |
| `npm run build` / `start` | Produção |
| `npm run upload:r2` | Opcional: sobe fotos pro R2 |
