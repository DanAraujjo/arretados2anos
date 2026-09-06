# Arretados 2 Anos

App web: selfie → reconhecimento facial nas fotos do time → vídeo de retrospectiva pra story do Instagram.

## Rodar

```bash
cd web
npm install
npm run dev
```

Abra [http://localhost:3000](http://localhost:3000).

## Fluxo

1. **Selfie** — a câmera captura 4 frames com rosto travado; eles são fundidos
   (mais a versão espelhada) num embedding só, bem mais estável que uma foto.
2. **Match** — compara contra `public/photos/faces.bin`, um índice pré-calculado
   com os embeddings de todos os rostos do álbum. Nenhuma foto é baixada: o scan
   é só distância entre vetores, ~40ms pra 890 fotos.
3. **Vídeo** — colagem animada sobre a arte `public/bg-arretados.jpg`, exportada
   em MP4 (H.264 + AAC) 1080x1920, exatamente 58s, com fade final. No celular o
   botão "Compartilhar" abre a folha nativa (Web Share nível 2) com o arquivo;
   onde não houver suporte, sobra o download.

## Reconhecimento facial

O reconhecimento usa **ArcFace** (insightface `w600k_mbf`, 512 dimensões,
quantizado em int8) via `onnxruntime-web`. O descritor que vinha junto com o
`face-api` confundia pessoas diferentes em foto de grupo — conferido recortando
os rostos casados e olhando um a um. O `face-api` continua no papel em que é
bom: detectar rosto e marcar os 68 pontos que alimentam o alinhamento.

`ARCFACE_MODEL_PATH` (em `src/lib/faceAlign.ts`) é a fonte única do caminho do
modelo: navegador e script do índice **têm** que usar o mesmo arquivo. O int8
não é numericamente igual ao fp32, então misturar os dois lados espalha erro
silencioso pelos matches.

Limiar em `src/lib/face.ts`. Na escala do ArcFace (vetores de norma 1, distância
euclidiana), a mesma pessoa aparece até ~1.11 e gente diferente começa por volta
de 1.18 — `MATCH_THRESHOLD = 1.10` fica na fronteira segura. Se trocar o modelo,
**recalibre olhando os recortes**, não no chute.

### Gerar o índice

Rode sempre que mudar as fotos:

```bash
cd web
npm run faces:index
```

Varre a imagem inteira **e** ladrilhos 2x2 com sobreposição (é onde o rosto do
fundo em foto de grupo aparece grande o suficiente), descarta detecção fraca —
abaixo de 0.65 de confiança o que aparece é ombro, mão e areia — e grava os
embeddings quantizados em int8. Usa vários processos: ~3min pra 890 fotos.

Subir `FACE_INDEX_VERSION` no script invalida os índices antigos. Obrigatório ao
trocar de modelo: comparar vetores de modelos diferentes devolve lixo com cara
de resultado.

### Modelos que não vão pro navegador

`web/.models-build/` guarda o que só o build usa: o ArcFace em fp32 (fonte da
quantização) e o detector SSD do face-api, que acha mais rosto que o Tiny mas
são 5.4MB que o cliente não precisa baixar — online a detecção é só da selfie.

Pra regerar o modelo quantizado (13MB → 3.5MB):

```bash
npx tsx scripts/dump-calibration.ts /tmp/calib 250
python3 scripts/quantize-arcface.py /tmp/calib
npm run faces:index     # obrigatório: o embedding muda
```

A calibração sai do próprio álbum e com o mesmo pré-processamento do índice —
quantização estática precisa disso, e o modelo é quase todo Conv, que o modo
dinâmico não quantiza.

## Montagem do vídeo

`PHOTO_AREA` (em `src/lib/video.ts`) delimita onde as fotos entram: da base do
banner "SEMPRE ARRETADOS!" até o rodapé. **A arte nunca se move** — ela é
redesenhada sem transformação a cada frame, e só a camada de fotos participa das
transições. Se voltar a transformar o canvas inteiro, o fundo balança junto.

O texto de encerramento é `OUTRO_LINES`. `OUTRO_SEC` tem que ser bem maior que
`FADE_OUT_SEC`: com os dois próximos, a mensagem nasce dentro do fade e ninguém
consegue ler.

Boa parte do álbum é rajada de câmera (há 25 arquivos com o mesmo segundo no
nome). No vídeo isso lê como "a mesma foto repetindo", então
`dropBurstDuplicates` mantém uma foto por rajada — pelo nome do arquivo, sem
baixar imagem.

## Trilha

A faixa é `public/music/tema.m4a`, **já recortada** no trecho que entra (0:13,
64s). `public/music.mp3` (a faixa cheia) e `party.mp3` ficam de fallback, e pra
esses o `MUSIC_START_SEC` pula a introdução.

O formato do arquivo não muda o resultado — tudo é decodificado pra PCM e sai em
AAC. O que pesa é a **duração**: decodificar os 4min inteiros gastava ~98MB de
float no celular, contra ~24MB com o recorte. Era parte da lentidão no Safari.

Se a faixa for mais curta que o vídeo, ela repete com crossfade de potência
constante na emenda; rampa exponencial dos dois lados **não** serve, dá silêncio
no meio do cruzamento.

Pra extrair a trilha de um vídeo:

```bash
npm run music:extract -- /caminho/do/video.mp4
```

Usa o `afconvert` (nativo do macOS, sem ffmpeg) e grava em
`public/music/tema.m4a`, que junto com `party.mp3` é fallback caso a faixa
principal falte ou o navegador não decodifique.

### Vídeo mudo

Vídeo sem som não levanta erro em lugar nenhum — encoder que falha por callback
ou faixa vazia no muxer passam batido, e só quem assiste percebe. Por isso:

- `unlockAudio()` roda na primeira linha do clique, antes de qualquer `await`:
  no iOS o `AudioContext` só libera dentro do gesto do usuário, e a montagem faz
  downloads antes de chegar no som.
- `probeAacFormat()` testa o encoder de verdade com um tom, nos dois layouts de
  PCM. `isConfigSupported` mente em alguns navegadores: diz que suporta e não
  emite bloco nenhum. E nem todo navegador aceita o mesmo layout de `AudioData`
  — planar num, intercalado noutro; errar isso dá faixa muda sem erro.
- `OfflineAudioContext` tenta 48kHz e cai pra 44.1kHz — Safari antigo recusa
  taxa diferente da do hardware.
- `measureAudioPeak()` decodifica o arquivo pronto e mede o pico: é o que separa
  "tem faixa" de "tem som". `countAudioSamples()` é o plano B quando o navegador
  não decodifica a própria saída. Se o caminho offline saiu
  mudo, o vídeo é refeito pelo MediaRecorder. Lida com MP4 comum (`stts`) e com
  o fragmentado do MediaRecorder (`moof`/`trun`) — ler só o `stts` num
  fragmentado dá zero e reporta silêncio que não existe.

- O bloco de áudio é muxado por `addAudioChunkRaw`, com duas defesas: o
  `AudioSpecificConfig` é sintetizado quando o navegador não manda `description`
  no primeiro bloco (sem `esds` nenhum player decodifica, e a faixa sai muda), e
  quadros em ADTS têm o cabeçalho removido — no MP4 vai o AAC cru.

A tela do vídeo mostra qual caminho foi usado, o pico do PCM que entrou no
encoder (`fonte`) e o que aconteceu com a faixa. Se `fonte` estiver saudável e o
arquivo mudo, o problema é do encoder/mux; se `fonte 0.00`, quem falhou foi o
`OfflineAudioContext`.

### WebKit grava em tempo real

No WebKit da Apple (Safari e, no iPhone, **todos** os navegadores) o arquivo do
caminho WebCodecs sai mudo: tem amostras de áudio que o próprio navegador não
decodifica. Pelo MediaRecorder o som sai certo — confirmado no aparelho, que
mediu pico 0.50 nesse caminho e não conseguiu medir nada no outro. Por isso lá o
padrão é a gravação nativa.

O custo é gravar em tempo real (~58s em vez de ~10s), e a duração continua
dentro do teto: medido em 57.970s de vídeo. Pra reavaliar quando o WebKit
corrigir, abra com `?audio=webcodecs` e confira o pico no diagnóstico.
`?audio=realtime` força o contrário.

## Colocar as fotos

O Instagram bloqueia download anônimo. Opções:

1. **Script com login** (recomendado):

```bash
chmod +x scripts/download-photos.sh
./scripts/download-photos.sh --login SEU_USUARIO_INSTAGRAM
```

2. **Manual:** baixe/exporte as fotos e jogue em `web/public/photos/`.

Depois rode `npm run faces:index` e reinicie o `npm run dev`.

## Hospedar as fotos fora do deploy

O álbum tem ~450MB e não sobe no build. `npm run manifest:photos` gera o
`manifest.json`; publique a pasta num CDN e aponte
`NEXT_PUBLIC_PHOTOS_BASE_URL`. O `faces.bin` e o `manifest.json` continuam indo
no deploy (veja `netlify.toml`).
