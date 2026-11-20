# Nebbia di guerra (M6)

Stato: logica condivisa, server e UI del client completi (vedi "Il client").

Decisioni dell'utente: la nebbia è **manuale**, in mano al GM, con **maschera per giocatore**. Il GM rivela e ricopre per tutti, per un gruppo o per un solo giocatore. Il calcolo automatico della vista dei token (raggio, luce/buio, muri) è **solo un aiuto visivo** e non scopre mai la nebbia. Il GM vede sempre tutto (la nebbia gli si mostra in trasparenza).

Principio: **il server decide**. Ciò che sta sotto la nebbia di un giocatore non arriva mai al suo client: né token, né muri, né pixel della mappa, né le maschere degli altri.

Codice: `packages/shared/src/state/fog.ts` (maschere, forme, tessere), `walls.ts` (muri e ritaglio), `vision.ts` (linea di vista), `view.ts`/`filter.ts` (proiezioni ed eventi), `reducer.ts` (comandi); server: `packages/server/src/media/tiles.ts` (tessere), `media/routes.ts` (rotte), `realtime/hub.ts` (`tileContext`, `assetAllowed`), `campaigns/store.ts` (persistenza).

## Modello

```
CampaignState
├─ fogs?[]   { sceneId, cellSize, offsetX, offsetY,         griglia della nebbia (copiata dalla scena)
│              lighting: "bright" | "dim" | "dark",         luce ambientale (solo aiuto visivo)
│              everyone: Mask,                              maschera di chi non ne ha una propria
│              players: [{ userId, mask: Mask }] }          solo maschere diverse da `everyone`, ordinate
├─ walls?[]  { id, sceneId, x1, y1, x2, y2, door, open }   muri; porta aperta = non blocca
└─ tokens[].vision?  { range | null, darkvision, bright, dim }   unità di gioco (es. ft)

Mask = { base: "covered" | "revealed", runs: number[] }
```

**Rappresentazione compatta della maschera.** Celle di una griglia propria della nebbia: la cella `(c, r)` copre `[ox + c·cs, ox + (c+1)·cs) × [oy + r·cs, oy + (r+1)·cs)`. `base` è lo stato di tutte le celle tranne quelle in `runs`, una lista piatta di terne `[riga, colonnaInizio, colonnaFine)` ordinate e fuse (forma canonica: maschere uguali hanno lo stesso JSON, così i diff e il controllo dei conflitti di annulla funzionano per confronto). Costi: "tutto coperto"/"tutto scoperto" = 0 terne; una stanza rettangolare = una terna per riga di celle; una mappa 100×100 celle rivelata a chiazze ≈ qualche centinaio di numeri. Limite: `LIMITS.fogMaxRuns` (20000 terne per maschera), `fogMaxPlayers` (64 maschere personali). Scelta rispetto ai poligoni: le operazioni (unione, differenza, "c'è qualcosa di rivelato in questo rettangolo?") sono esatte, veloci e senza problemi di geometria (poligoni che si sovrappongono, precisione), e le tessere della mappa si allineano naturalmente alle celle.

**Griglia della nebbia indipendente.** Si copia dalla griglia della scena a `fog.enable` (o si passa `cellSize`/`offset`). Cambiare poi la griglia della scena non sposta la nebbia (per rifarla: `fog.disable` + `fog.enable`). Le celle fuori dalla mappa non contano.

**Assente = come prima.** Una scena senza nebbia si comporta esattamente come prima del M6 (stesso `viewFor`, mappa come URL, `/assets` invariato). `fogs`, `walls` e `vision` sono facoltativi negli schemi: le campagne salvate prima restano valide.

## Comandi (tutti solo GM; il giocatore riceve `FORBIDDEN` prima di qualsiasi controllo sullo stato)

| `type` | Campi | Note |
|---|---|---|
| `fog.enable` | `sceneId`, `initial: covered \| revealed`, `lighting?`, `cellSize?`, `offsetX?`, `offsetY?` | stato iniziale per scena; `CONFLICT` se già attiva |
| `fog.disable` | `sceneId` | toglie la nebbia (`NOT_FOUND` se non c'è) |
| `fog.reveal` / `fog.cover` | `sceneId`, `shape`, `target` | rivela / ricopre le celle della forma |
| `fog.revealAll` / `fog.coverAll` | `sceneId`, `target` | tutta la scena |
| `fog.setLighting` | `sceneId`, `lighting` | |
| `fog.restore` | `fog` (completa) | imposta la nebbia intera: è l'inverso usato da annulla/ripeti |
| `wall.add` | `wall` | estremi dentro la mappa, lunghezza non nulla |
| `wall.update` | `wallId`, `patch` (`x1`, `y1`, `x2`, `y2`, `door`, `open`) | |
| `wall.remove` | `wallId` | |

- `shape`: `{ kind: "rect", x, y, width, height }`, `{ kind: "circle", x, y, radius }`, `{ kind: "polygon", points: [x0, y0, ...] }` (3-512 vertici, pari/dispari), `{ kind: "cells", cells: [c0, r0, ...] }` (max 4096). Coordinate in pixel della mappa. **Regola: una cella è dentro la forma se il suo centro lo è** (bordi inclusi); il risultato è limitato alle celle della mappa.
- `target`: `{ kind: "all" }` = maschera di tutti **e** tutte le maschere personali (anche i giocatori aggiunti dopo partono da `everyone`); `{ kind: "players", userIds: [...] }` = solo quei giocatori (devono essere membri con ruolo giocatore, altrimenti `INVALID`). Dopo ogni operazione le maschere personali uguali a `everyone` si eliminano.
- Annulla/ripeti: ogni comando di nebbia registra come inverso `fog.restore` con la nebbia precedente (o `fog.disable`), quindi l'annullamento è esatto. `scene.delete` elimina anche nebbia e muri della scena e il suo inverso li ricrea. Conflitto (`CONFLICT`) se la nebbia è cambiata nel frattempo.
- Membri: chi esce dalla campagna o diventa GM perde la maschera personale (`withMembers`, anche al caricamento); se rientra riparte da `everyone`.

## Cosa riceve chi (`viewFor` / `filterEventFor`)

| Dato | GM | Giocatore |
|---|---|---|
| Token | tutti | non nascosti, scena attiva e **almeno una cella sotto l'impronta del token rivelata a lui** (impronta = quadrato di `size` celle della nebbia, senza rotazione). I **propri** token si vedono sempre |
| Mappa della scena con nebbia | `map` con URL | `map: null`; la mappa arriva solo a **tessere** (`fog.tiles`) |
| Nebbia | `mask` = `everyone` e `players` (tutte le maschere) | solo `mask` = **la propria**; `players` assente |
| Muri | segmento intero | solo i **pezzi** nelle celle rivelate a lui (`clipSegmentToMask`; un muro su una linea della griglia è visibile se una delle due celle accanto è rivelata) |
| `vision` del token | sì | solo dei propri token (agli altri `null`), come la vita |

Eventi nuovi nel `delta`: `fog.updated { sceneId, fog: FogView | null }` (sostituzione completa), `wall.created { wall }`, `wall.updated { wall }`, `wall.deleted { wallId }`; `scene.activated` porta anche `fog` e `walls` (il giocatore li sostituisce). Un cambio di nebbia per un giocatore produce, in un solo delta: eventuale `scene.updated { map }` (nebbia attivata/tolta), `fog.updated`, `token.created`/`token.deleted` dei token che entrano/escono dalle sue aree e `wall.created/updated/deleted` dei pezzi di muro. Un token che si sposta nel buio arriva come `token.deleted` (senza coordinate). I cambiamenti interni (`StateChange` di tipo `fog`/`wall`, e `token`/`scene`/`activeScene` con il campo `fog`) portano la nebbia della scena al momento del cambiamento, così il filtro è puro e un delta rilanciato dal registro (riconnessione, anche dopo un riavvio) dà gli stessi eventi.

Test (`packages/shared/src/state/fogstate.test.ts`, `fuzz.test.ts`): applicare i delta filtrati alla vista precedente dà esattamente `viewFor` (anche nel fuzz con comandi di nebbia e muri e nel fuzz mirato); nessun id/nome di token o muro invisibile prima e dopo compare negli eventi; nessuna maschera altrui; nessun asset della mappa.

## Immagine della mappa: tessere per giocatore (server)

Il caso più insidioso: con una nebbia solo grafica il giocatore potrebbe scaricare la mappa intera. Soluzione:

1. **Niente URL** dell'immagine ai giocatori su scene con nebbia (`map: null`), e `GET /assets/<uuid>` di una mappa usata da una scena con nebbia risponde **404** ai non-admin, a meno che lo stesso file non sia visibile loro altrove senza nebbia (immagine di un token visibile, mappa della scena attiva senza nebbia). Gli altri asset si comportano come prima.
2. **Tessere**: `GET /campaigns/:campaignId/scenes/:sceneId/tiles/:col/:row` (sessione obbligatoria, 401 senza). Tessere di `FOG_TILE_SIZE` = 512 px **della scena** (`cols = ceil(width/512)`, `rows = ceil(height/512)`); se l'immagine ha una risoluzione diversa dalla scena, la tessera copre la stessa area alla risoluzione dell'immagine (il client la stira a 512 px di scena).
   - GM: qualsiasi scena con mappa, tessere intere.
   - Giocatore: membro della campagna, **solo la scena attiva con nebbia**, solo tessere con **almeno una cella rivelata a lui**. Le tessere parziali sono **mascherate sul server**: i pixel delle celle coperte diventano neri (JPEG) o neri e trasparenti (PNG/WebP → PNG).
   - **Ogni rifiuto dà lo stesso 404** (`{"error":"Non trovato"}`): campagna o scena inesistente, non membro, scena non attiva, tessera fuori mappa o **coperta**. Una tessera coperta è indistinguibile da una inesistente (test).
   - `Cache-Control: private, no-cache` + `ETag` derivato da asset, dimensioni, tessera e **celle rivelate sotto la tessera**: il client rivalida sempre; se la nebbia cambia, cambia l'ETag (200 con la tessera nuova) o la tessera sparisce (404). `If-None-Match` uguale → 304.
3. **Generazione**: alla prima tessera di un asset l'immagine si decodifica una volta (pngjs / jpeg-js in JavaScript puro, WebP con libwebp in WebAssembly da `@jsquash/webp`: nessuna dipendenza nativa né script d'installazione, `npm ci` funziona) e i pixel RGBA si salvano in `UPLOAD_DIR/.tiles/<uuid>.rgba`. Ogni tessera legge solo le sue righe dal file, applica la maschera e si codifica (JPEG qualità 85 se la mappa è JPEG, altrimenti PNG). Le tessere codificate restano in una cache LRU in memoria (64 MB) con chiave che include la copertura: l'**invalidazione è implicita** quando la nebbia cambia.

### Costi misurati (MacBook, Node 22; `npx tsx src/bench/tiles.bench.ts` in `packages/server`)

| Operazione (mappa 4000×3000) | Tempo |
|---|---|
| Prima tessera di un JPEG (decodifica jpeg-js + file grezzo) | ~0,9 s |
| Prima tessera di un PNG (decodifica pngjs + file grezzo) | ~0,4 s |
| Tessera 512×512 JPEG (lettura + maschera + codifica) | ~28 ms |
| Tessera 512×512 PNG | ~31 ms |

### Limiti noti delle tessere

- **Disco**: il file grezzo occupa 4 byte per pixel (48 MB per 4000×3000, fino a 400 MB per il limite di 100 Mpx). Non viene cancellato quando l'asset non serve più (si può svuotare `UPLOAD_DIR/.tiles` a mano: si rigenera).
- **Memoria e CPU**: la decodifica tiene l'immagine intera in RAM una volta (≈ 4 byte/pixel più il file compresso) e blocca il ciclo degli eventi per la sua durata (secondi per mappe enormi): è in JS puro, non in un worker. Le tessere costano ~30 ms l'una; una scena 8000×6000 tutta rivelata sono 192 richieste.
- **Banda**: le tessere PNG di mappe fotografiche pesano più dell'originale; JPEG ricodificato perde un po' di qualità (85).
- **Bordo delle tessere parziali**: si vede la mappa esattamente fino al bordo delle celle rivelate (granularità = cella della nebbia).
- **Mappe esterne** (`map.url` http(s) non caricato sul server): non si possono servire a tessere; con la nebbia il giocatore non vede lo sfondo (nessuna fuga).
- La prima richiesta dopo il riavvio rilegge il file grezzo già pronto (nessuna nuova decodifica).

## Muri e token sotto la nebbia: cosa resta intuibile

- **Token**: un token sotto la nebbia non esiste per il giocatore (né id né coordinate); entra come `token.created` quando un'area si rivela o il token entra in un'area rivelata. Un token grande al bordo di un'area rivelata si vede intero (posizione e dimensione) anche se in parte è sotto la nebbia.
- **Muri**: si ricevono solo i pezzi nelle celle rivelate; gli estremi dei pezzi tagliati stanno sulle linee della griglia e rivelano la direzione del muro che prosegue nel buio (come lo si vede sulla mappa).
- **Id dei muri**: un muro parzialmente visibile rivela il suo id (non indovinabile).
- **Versioni**: come per i token nascosti, i salti di `version` rivelano che "è successo qualcosa" (vedi PROTOCOL.md).
- **Luci altrui**: `vision` (anche la luce emessa) dei token altrui non arriva al giocatore: il suo aiuto visivo non conosce le torce dei mostri.

## Linea di vista (aiuto visivo, `vision.ts`)

`computeVisibility({ x, y, radius, segments, width, height })` restituisce il poligono di visibilità: raycasting verso gli estremi dei muri (più due raggi a ±0,0001 rad), verso le intersezioni dei muri con il cerchio del raggio e lungo un poligono regolare di 64 lati per l'arco; ogni raggio si ferma al muro più vicino. I muri lontani (riquadro e distanza dal segmento oltre il raggio) si scartano prima. Le porte aperte non bloccano. `computeSight(scene, lighting, tokens, walls)` dà il poligono di ciascun token con il raggio di `sightRadiusPx` (luce intensa/fioca: `range`, o illimitato; buio: massimo tra scurovisione e luce propria, entro `range`); `computeLights` le aree di luce intensa e fioca dei token che emettono luce. **Non modificano mai la nebbia**: il client li disegna come sovrapposizione.

Misure (`vision.test.ts`, mediana di 10 ricalcoli completi, MacBook, Node 22):

| Scenario (mappa 4000×4000) | Tempo |
|---|---|
| 200 muri, 50 token, raggio 60 ft (840 px) | ~5 ms |
| 200 muri, 50 token, raggio illimitato | ~100 ms (≈ 2 ms per token) |

Con raggio illimitato conviene ricalcolare solo i token che si muovono (o limitare il raggio).

## Il client (`packages/client`)

- **Logica pura** (`src/fog`): `fogLogic.ts` (conversioni punto/cella, forme del pennello, `CellPath`, comandi `fog.reveal/cover/revealAll/coverAll`, `viewMask`, `availableTiles`/`diffTiles`/`tileUrl`), `wallLogic.ts` (aggancio, ricerca del muro, comandi), `sight.ts` (`SightEngine`: ricalcolo selettivo della vista con budget di 6 ms per passata, tratteggio).
- **Canvas** (`map/fogLayer.ts`, `map/drawTools.ts`): velo = UNA texture con un pixel per cella ingrandito; il bordo morbido sta solo sul lato rivelato (interpolazione, poi le celle coperte si ridisegnano nette), quindi non scopre nulla. Aggiornamento in dissolvenza di 220 ms (istantaneo con `prefers-reduced-motion`). Giocatore: velo opaco con la propria maschera e sfondo a tessere (solo `availableTiles`; 404 = resta nero; l'URL porta `?k=<chiave di copertura>`, l'ETag fa il resto); GM: mappa intera e velo al 55% della maschera scelta in "vista come". Ordine dei livelli: sfondo, tessere, griglia, vista dei token, velo, muri, anteprime, token.
- **Strumenti GM**: barra sopra la mappa (`table/FogToolbar.tsx`) e scheda "Nebbia" (`FogPanel.tsx`: attiva con stato iniziale, destinatari a chip, rivela/copri tutto con conferma per "copri", vista come, luce, disattiva). Pennelli rettangolo, cerchio, poligono, celle con anteprima prima del rilascio; un clic = una cella subito; Alt = senza aggancio. Muri e porte: disegno (trascinamento o clic-clic a catena), porta, modifica degli estremi, elimina; un clic su una porta la apre/chiude anche con la selezione. Annulla/ripeti passano dai comandi esistenti.
- **Scorciatoie** (mappa a fuoco, GM): `V` selezione, `N` nebbia (`1` rettangolo, `2` cerchio, `3` poligono, `4` celle, `X` rivela/copri, Invio chiude il poligono, Backspace toglie un vertice), `W` muri (`1` muro, `2` porta, `3` modifica, `4` elimina, Canc elimina il selezionato), Esc annulla poi esce.
- **Vista dei token**: contorno tratteggiato tenue e luci, calcolati con `computeVisibility`; GM tutti i token con `vision`, giocatore solo i propri (gli altri hanno `vision: null`). Non modificano mai la nebbia; il giocatore la vede sotto il velo, quindi solo nelle celle rivelate. Raggio/luce nell'editor token.
- **Test**: `src/fog/*.test.ts`, `src/map/drawTools.test.ts`, `src/table/fogUi.test.tsx`, `e2e/fog.e2e.test.ts` (server reale: tessere coperte = 404, nessun token sotto la nebbia nel traffico, rivelazione a un solo giocatore).
- **Limiti noti**: il velo ha una texture per scena (cap 4096 px e 16 Mpx, quindi su mappe enormi i pixel per cella scendono); le tessere dei giocatori restano in memoria finche' sono rivelate; nessun pennello a spessore variabile; le luci altrui non arrivano al giocatore.
