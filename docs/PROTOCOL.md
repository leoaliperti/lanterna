# Protocollo WebSocket e stato condiviso

Versione del protocollo: **1** (`PROTOCOL_VERSION`). Codice: `packages/shared/src/state` (modello, riduttore, filtro, annulla/ripeti) e `packages/shared/src/protocol` (messaggi, sincronizzazione, applicazione dei delta lato client). È logica pura: niente rete né database. Il server la collega a `ws` e SQLite.

Principio: **il server decide, il client mostra.** Il client invia comandi; il server li valida e li applica con `applyCommand` (unica fonte di verità, permessi compresi) e invia a ogni utente solo ciò che può vedere.

## Modello di stato

```
CampaignState
├─ campaignId, name, version (cresce di 1 per ogni comando che cambia qualcosa)
├─ activeSceneId           scena mostrata ai giocatori (o null)
├─ members[]               { userId, displayName, role: "admin" | "player" }
├─ scenes[]                { id, name, map: { assetId, url } | null, width, height (px),
│                            grid: { cellSize, color, opacity, offsetX, offsetY, snap, visible },
│                            scale: { unitsPerCell, unit } }        es. 1 cella = 5 ft
└─ tokens[]                { id, sceneId, name, imageUrl, x, y (centro, px mappa),
                             size (celle), rotation (gradi [0,360)), ownerUserId | null,
                             kind: "pc" | "monster" | "object", hidden,
                             conditions[{ id, name }], health { current, max, temp } | null,
                             gmNotes, vision? }                     vision: M6, aiuto visivo
├─ fogs?[]                 nebbia per scena (M6), vedi docs/FOG.md
└─ walls?[]                muri e porte (M6), vedi docs/FOG.md
```

L'ordine di `tokens` è l'ordine di disegno. Gli id sono stringhe opache (`[A-Za-z0-9_-]`, max 64), generate dal client (UUID) per `token.create`/`scene.create`: così l'inverso per annulla/ripeti è deterministico e gli id non rivelano contatori. Limiti in `LIMITS` (`state/schema.ts`). Tutti gli schemi sono `strict`: campi sconosciuti => `INVALID`. Coordinate e numeri devono essere finiti; le posizioni stanno dentro la mappa (`0 ≤ x ≤ width`, `0 ≤ y ≤ height`).

`Actor = { userId, role }` lo costruisce il server dalla sessione autenticata (`resolveActor(state, userId)`), mai dal client.

## Messaggi client → server

Un messaggio JSON per frame, massimo 64 KiB, decodificato con `parseClientMessage` (non lancia mai).

| `type` | Campi | Note |
|---|---|---|
| `hello` | `protocolVersion`, `campaignId`, `lastVersion \| null`, `epoch \| null` | primo messaggio e a ogni riconnessione |
| `command` | `requestId`, `command` | vedi comandi sotto |
| `undo` / `redo` | `requestId` | annulla/ripeti per utente |
| `chat.send` | `requestId`, `text`, `whisperTo?` | chat; vedi "Chat e dadi" |
| `roll.request` | `requestId`, `formula`, `visibility`, `whisperTo?`, `label?` | tiro, esito deciso dal server |
| `history.request` | `requestId`, `before` (id voce \| null), `limit?` | pagina di cronologia più vecchia |
| `ping` | | |

### Comandi

| `command.type` | Campi | GM | Giocatore |
|---|---|---|---|
| `token.move` | `tokenId`, `x`, `y`, `snap?` | sì | solo il proprio token visibile |
| `token.update` | `tokenId`, `patch` | sì, ogni campo | solo `conditions` del proprio token visibile |
| `token.create` | `token` | sì | no |
| `token.delete` | `tokenId` | sì | no |
| `scene.create` | `scene` | sì | no |
| `scene.update` | `sceneId`, `patch` (`name`, `map`, `width`, `height`, `scale`) | sì | no |
| `scene.setGrid` | `sceneId`, `grid` (parziale) | sì | no |
| `scene.delete` | `sceneId` (elimina anche i suoi token) | sì | no |
| `scene.activate` | `sceneId \| null` (cambio di scena) | sì | no |
| `fog.enable`, `fog.disable`, `fog.reveal`, `fog.cover`, `fog.revealAll`, `fog.coverAll`, `fog.setLighting`, `fog.restore` | vedi [docs/FOG.md](FOG.md) | sì | no |
| `wall.add`, `wall.update`, `wall.remove` | vedi [docs/FOG.md](FOG.md) | sì | no |

Campi di `token.update`: `name`, `imageUrl`, `size`, `rotation`, `ownerUserId`, `kind`, `hidden`, `conditions`, `health`, `gmNotes`, `vision`. Quindi ridimensionare, ruotare, nascondere, cambiare la vita e assegnare un token sono **solo del GM**. Una patch che mescola campi consentiti e no è rifiutata per intero.

`token.move` aggancia alla griglia se `snap` (o, se assente, `grid.snap` della scena) è vero: token di lato dispari al centro della cella, di lato pari sull'incrocio. Rimpicciolire una mappa riporta dentro i token rimasti fuori.

## Messaggi server → client

| `type` | Campi | Note |
|---|---|---|
| `snapshot` | `protocolVersion`, `epoch`, `version`, `view` | `view = viewFor(state, utente)` |
| `delta` | `epoch`, `fromVersion`, `toVersion`, `events[]` | eventi già filtrati per l'utente |
| `ack` | `requestId`, `version` | comando applicato |
| `error` | `requestId \| null`, `code`, `message`, `reason?` | `FORBIDDEN`, `INVALID`, `CONFLICT`, `NOT_FOUND`, `RATE_LIMITED` |
| `chat.message` | `requestId \| null`, `entry` (`ChatEntry`) | messaggio di chat già filtrato |
| `roll.result` | `requestId \| null`, `entry` (`RollEntry`) | esito di un tiro già filtrato |
| `history` | `requestId \| null`, `entries[]`, `hasMore` | cronologia filtrata (dopo `hello` e su richiesta) |
| `pong` | | |

Eventi dentro un `delta`: `token.created {token}`, `token.updated {tokenId, changes}`, `token.deleted {tokenId}`, `scene.created {scene}`, `scene.updated {sceneId, changes}`, `scene.deleted {sceneId}`, `scene.activated {sceneId, scene, tokens, fog, walls}` (il giocatore sostituisce scena, token, nebbia e muri con quelli ricevuti); dal M6 anche `fog.updated {sceneId, fog}`, `wall.created {wall}`, `wall.updated {wall}`, `wall.deleted {wallId}` (vedi [docs/FOG.md](FOG.md)).

Codici d'errore:

- `FORBIDDEN`: l'utente vede l'oggetto ma non può fare l'azione; i comandi solo-GM danno `FORBIDDEN` **prima** di guardare lo stato (anche per id inesistenti).
- `INVALID`: forma o valori non validi.
- `CONFLICT`: id già usato; annulla/ripeti su campi cambiati nel frattempo da altri.
- `NOT_FOUND`: inesistente **o invisibile** per l'utente. Un token nascosto e uno che non esiste danno lo stesso errore con lo stesso messaggio. I messaggi d'errore sono fissi e non contengono mai id o dati.
- `RATE_LIMITED`: troppi messaggi di chat o tiri (solo chat e dadi, mai dai comandi).
- `reason` (facoltativo): per una formula non valida, il codice del parser dei dadi (`TROPPI_DADI`, `SINTASSI_NON_VALIDA`, ...); `message` è il messaggio italiano del parser.

Ordine dei controlli nel riduttore: forma (Zod) → solo-GM → ricerca tra gli oggetti visibili all'attore → proprietà e campi → vincoli sullo stato.

## Flusso sul server

```
msg = parseClientMessage(raw)                 // errore => invia ErrorMessage
r   = dispatch(core, actor, msg)              // command | undo | redo
per ogni connessione c:
  d = deltaFor(c.actor, epoch, c.lastSent, r.toVersion, r.changes)
  se d: invia d; c.lastSent = d.toVersion
invia r.reply al mittente (ack o errore), dopo il suo delta
```

`dispatch` restituisce i cambiamenti **interni** (`StateChange`, con stato completo prima/dopo): non vanno mai serializzati verso un client, solo passati a `filterEventFor`/`deltaFor`.

## Filtro per utente (`viewFor`, `filterEventFor`)

| Dato | GM | Proprietario | Altri giocatori |
|---|---|---|---|
| Scene non attive (nome, mappa, griglia) | sì | no | no |
| Token nascosti (id compreso) | sì | **no** | no |
| Token su scene non attive | sì | no | no |
| Nome, posizione, dimensione, rotazione, immagine, tipo | sì | sì | sì |
| Condizioni e stati | sì | sì | sì |
| Barra della vita | sì | sì | no (`health: null`) |
| Note del GM | sì | no (campo assente) | no (campo assente) |
| Vista e luce (`vision`, M6) | sì | sì | no (`null`) |
| Token, muri e mappa sotto la nebbia (M6) | sì | solo le parti rivelate a lui (il proprio token sempre) | idem, con la propria maschera |
| Maschere di nebbia (M6) | tutte | solo la propria | solo la propria |

- Le proiezioni copiano i campi uno per uno (lista bianca): un campo aggiunto al modello non arriva ai giocatori finché non lo si aggiunge esplicitamente in `view.ts`.
- Gli eventi derivano dalle stesse proiezioni: per ogni cambiamento si confronta la vista dell'utente prima e dopo e si invia solo la differenza. Quindi un token che diventa nascosto arriva al giocatore come `token.deleted` (scomparsa), uno rivelato come `token.created`; un cambio di sola vita o note di un token altrui non genera alcun evento; il passaggio di proprietà invia al vecchio proprietario `health: null` e al nuovo la vita.
- Un token nascosto resta nascosto anche al suo proprietario.
- I test verificano che, applicando i delta filtrati alla vista precedente, si ottenga esattamente `viewFor` (anche con fuzz).

### Cosa può ancora intuire un giocatore (fughe residue documentate)

- **Salti di versione.** `version` è globale: se il GM fa 3 operazioni invisibili, il delta successivo passa per esempio da 10 a 14. Il giocatore capisce che "è successo qualcosa che non vede" e quante operazioni, ma non cosa né su quali token. Evitarlo richiederebbe versioni per utente e registri separati; rimandato.
- **Tempi.** Un'azione del giocatore che arriva subito dopo azioni invisibili ha un ack con versione più alta.
- **Rivelazione.** Quando un token viene rivelato il giocatore ne scopre l'id; e l'ordine di disegno sul client può differire da quello del server fino al prossimo snapshot (il token rivelato è aggiunto in cima).
- **Scena attiva temporanea.** Se il GM attiva una scena anche per un attimo, i giocatori connessi (o che si riconnettono con un delta che attraversa quel momento) ne ricevono il contenuto visibile in quel momento.
- **Proprietà.** Il giocatore vede `ownerUserId` dei token visibili (necessario per sapere quali può muovere).
- **Annulla.** Se il proprio token è stato nascosto, `undo` restituisce `NOT_FOUND`: il giocatore sa già che il suo token è sparito, non apprende altro.

## Riconnessione

Il server tiene un registro circolare (`EventLog`, default 500 voci) dei cambiamenti interni per versione e un'`epoch` che identifica la linea dello stato (nuova a ogni ripristino da backup). Il client invia `hello { lastVersion, epoch }`; `planResync` risponde:

- `delta` da `lastVersion` alla versione attuale, filtrato per l'utente, se l'epoca coincide e il registro copre l'intervallo senza buchi (delta vuoto se il client è già aggiornato);
- `snapshot` se è la prima connessione, l'epoca è diversa, `lastVersion` è nel futuro, il registro non copre più l'intervallo (riavvio, troppe modifiche) o il delta supererebbe `MAX_DELTA_EVENTS` eventi.

Lato client `applyDelta` accetta un delta solo se `fromVersion` coincide con la versione locale e l'epoca è la stessa; altrimenti il client invia di nuovo `hello`. Se cambiano il ruolo o l'appartenenza di un utente (gestiti fuori dai comandi, dall'auth), il server deve chiudere le sue connessioni: alla riconnessione l'epoca/`lastVersion` non bastano a correggere la vista, quindi va forzato uno snapshot.

## Annulla/ripeti

`execute(state, history, command, actor)` applica un comando e registra la voce `{ actorUserId, forward, inverse, expect }`. Ogni comando calcola il proprio inverso (es. `token.move` → `token.move` alla posizione precedente con `snap: false`; `token.delete` → `token.create` del token completo; `scene.delete` → ricrea scena, token e scena attiva).

- Il giocatore annulla solo le proprie azioni (l'ultima); il GM l'ultima azione di chiunque, o una voce precisa per id.
- L'inverso si applica **con i permessi di chi annulla**: se il giocatore ha perso il token o è stato nascosto, l'annullamento fallisce (`FORBIDDEN`/`NOT_FOUND`).
- Prima di annullare si controlla che i campi toccati siano ancora quelli lasciati dall'azione: altrimenti `CONFLICT` (per il giocatore, su token che non vede, sempre `NOT_FOUND`).
- Ripeti è di chi ha annullato; una nuova azione di un utente cancella i suoi ripeti. La cronologia ha un limite (default 200 voci).

## Server (M2/M3): trasporto, persistenza, REST, upload

Codice in `packages/server/src`: `realtime/` (WebSocket e stanze), `campaigns/` (SQLite e REST), `media/` (upload; la cartella non si chiama `uploads/` perché quel nome è in `.gitignore`).

### WebSocket `/ws`

- **Libreria:** `ws` usato direttamente (`noServer: true`) sull'evento `upgrade` del server HTTP di Fastify, senza `@fastify/websocket`: il rifiuto avviene in modo esplicito **prima** dell'handshake e il codice resta piccolo. `perMessageDeflate` è disattivato (niente bombe di decompressione).
- **URL:** `ws(s)://<host>/ws`. In sviluppo il client passa dal proxy Vite come per il resto: `ws://localhost:5173/api/ws` (il proxy `/api` di `packages/client/vite.config.ts` deve avere `ws: true`).
- **Prima dell'upgrade**, in quest'ordine: percorso diverso da `/ws` → 404; parametri `viewAs`/`readOnly` non validi → 400; header `Origin` assente o non tra le origini ammesse (`BETTER_AUTH_URL` + `TRUSTED_ORIGINS`) → **403** (anti cross-site WebSocket hijacking; il Referer non basta); nessuna sessione valida nel cookie → **401**; `viewAs` di un altro utente da chi non è admin → **403**; più di 16 connessioni dello stesso utente → 429.
- **Parametri facoltativi (M9, finestre multiple, vedi [docs/WINDOWS.md](WINDOWS.md))**: `?viewAs=<userId>` = la connessione riceve esattamente ciò che riceve quel membro (attore del membro per snapshot, delta, chat, cronologia, effimeri); solo il GM della campagna, controllato di nuovo all'`hello` (altrimenti `error FORBIDDEN "vista non consentita"` e chiusura 4403); implica la sola lettura. `?readOnly=1` = sola lettura per qualsiasi utente. In sola lettura comandi, annulla/ripeti, `chat.send`, `roll.request`, `initiative.roll`, `ephemeral.show/clear` ricevono `FORBIDDEN "connessione in sola lettura"`; restano `hello`, `ping`, `history.request`. Nessuna modifica ai messaggi del protocollo (`PROTOCOL_VERSION` invariata).
- **Dopo l'apertura** il client ha `WS_HELLO_TIMEOUT_MS` (10 s) per inviare `hello`. Il server risponde con `planResync` (delta o snapshot) solo se l'utente è membro della campagna; altrimenti `error NOT_FOUND` (stesso messaggio per campagna inesistente) e chiusura 4404. Un secondo `hello` sulla stessa connessione è una risincronizzazione.
- **Ogni messaggio** passa da `parseClientMessage`; frame binari, JSON non valido e campi sconosciuti danno `error INVALID` e il server continua. Frame oltre 64 KiB: chiusura 1009 (limite `maxPayload` di `ws`).
- **Attore:** sempre `resolveActor(stato, userId della sessione)`. Il client non può indicare utente né ruolo: un campo in più nel messaggio è `INVALID` (schemi strict).
- **Rate limit per connessione:** secchiello di gettoni (`WS_MESSAGES_PER_SECOND` = 30 di media, raffica `WS_MESSAGE_BURST` = 60). Oltre: messaggio scartato con `error INVALID "troppi messaggi"`; insistendo (4 × raffica scartati di fila) chiusura 1008.
- **Keep-alive:** ping del server ogni `WS_HEARTBEAT_MS` (30 s, sotto i ~100 s di inattività di Cloudflare); la connessione che non ha risposto al ping precedente viene terminata. Allo stesso giro si ricontrolla la sessione nel database: logout, reset password o scadenza chiudono il socket (4401) entro un intervallo. Il client può anche mandare `ping` applicativi (`pong`).
- **Client lenti:** oltre 16 MiB in coda d'invio la connessione viene terminata.
- Dopo la risposta a ogni `hello` (snapshot o delta) il server invia `history` con le ultime voci di chat e tiri visibili all'utente (vedi "Chat e dadi").

Codici di chiusura: 1001 arresto del server, 1008 rate limit, 1009 messaggio troppo grande, 4400 versione del protocollo, 4401 sessione terminata, 4403 permessi cambiati (o, con `viewAs`, vista non consentita / membro guardato uscito: definitivo per il client della vista), 4404 campagna non trovata o non membro, 4408 `hello` mancante. Con 4401/4403/4404 il client non deve riconnettersi da solo in loop (4401: torna al login).

### Stanze, ordine e salvataggio

Una stanza per campagna (`realtime/hub.ts`), con lo stato in memoria caricato da SQLite all'avvio. Comandi, annulla/ripeti e cambi di membri di una stanza passano da una **coda** e si applicano uno alla volta:

```
r = dispatch(core, attore della connessione, input)
se r.changes non vuoto:
    persistChanges(db, r.core.state, r.changes)   // una transazione (db.batch)
    se fallisce: errore CONFLICT "salvataggio non riuscito", stato in memoria invariato
core = r.core
per ogni connessione della stanza: deltaFor(...) filtrato
ack (o errore) al mittente, dopo il suo delta
```

Lo stato si salva **prima** di essere inviato a chiunque: dopo un riavvio non si perde nessun comando confermato. All'avvio `loadCampaign` rilegge tutto, valida ogni scena e token con Zod e `checkInvariants`; se i dati non sono validi il server **non parte** (meglio che inventare o perdere dati in silenzio).

### Schema SQLite (migrazione `0001_campaigns`)

| Tabella | Contenuto |
|---|---|
| `campaign` | `id`, `name`, `version`, `epoch`, `active_scene_id`, `created_by` |
| `campaign_member` | (`campaign_id`, `user_id`) con cascata su campagna e utente. Ruolo e nome visualizzato vengono dall'account (`user.role`, `user.name`): admin = GM |
| `scene` | (`campaign_id`, `id`), `sort`, `data` = `Scene` in JSON |
| `token` | (`campaign_id`, `id`), `scene_id`, `sort` (z-order), `data` = `Token` in JSON |
| `fog` (migrazione `0004_fog`) | (`campaign_id`, `scene_id`), `data` = `Fog` in JSON (maschere per giocatore) |
| `wall` (migrazione `0004_fog`) | (`campaign_id`, `id`), `scene_id`, `sort`, `data` = `Wall` in JSON |
| `campaign_event` | (`campaign_id`, `version`), `changes` = `StateChange[]` in JSON: gli ultimi 500, per riprendere con un **delta anche dopo un riavvio** |
| `asset` | file caricati: `id` (UUID), `kind`, `mime`, `ext`, `width`, `height`, `bytes`, `uploaded_by` |

JSON e non colonne per scene e token: il modello vive in un solo posto (`state/schema.ts`) e viene rivalidato a ogni lettura, quindi il database non può introdurre campi o valori non ammessi. `sort` di un oggetto nuovo è `max + 1`, quindi l'ordine salvato coincide con quello in memoria (verificato da un test con 150 comandi casuali, annulla e ripeti compresi).

### Cambi di membri e di ruolo

Membri e ruoli cambiano fuori dai comandi (REST `/campaigns/:id/members`, `/admin/users`). In quel caso il server ricarica i membri, toglie la proprietà dei token a chi non è più membro, **cambia epoca** (così chi si riconnette riceve uno snapshot), azzera la cronologia di annulla/ripeti della campagna, invia uno snapshot nuovo a chi resta e chiude (4403) le connessioni di chi è stato rimosso. Cambio di ruolo o eliminazione di un utente chiudono **tutte** le sue connessioni; il reset della password le chiude con 4401.

### REST

Tutte le rotte verificano sessione e ruolo lato server (`requireSession`, `requireRole("admin")` come `onRequest`); POST/DELETE richiedono anche `Origin` ammesso.

| Rotta | Chi | Note |
|---|---|---|
| `GET /campaigns` | admin | tutte le campagne |
| `POST /campaigns` `{ name }` | admin | 201; chi la crea diventa membro (GM) |
| `GET /campaigns/mine` | autenticato | campagne di cui l'utente è membro |
| `GET /campaigns/:id/members` | admin | |
| `POST /campaigns/:id/members` `{ userId }` | admin | 201, 404 campagna/utente, 409 già membro |
| `DELETE /campaigns/:id/members/:userId` | admin | 204, 404, 409 se è l'ultimo GM della campagna (controllo atomico in SQL) |
| `POST /uploads/map`, `POST /uploads/token` | admin | multipart con un solo file |
| `GET /assets/:uuid.:ext` | autenticato | file caricato; 404 ai giocatori per una mappa usata da una scena con nebbia (M6) |
| `GET /campaigns/:id/scenes/:sceneId/tiles/:col/:row` | GM; giocatore membro, scena attiva con nebbia, tessera almeno in parte rivelata | tessera della mappa mascherata per l'utente; ogni rifiuto = stesso 404 (vedi [docs/FOG.md](FOG.md)). M9: `?viewAs=<userId>` = la tessera come la riceve quel membro, solo GM della campagna (giocatore verso un altro: 403; verso se stesso: come senza parametro) |
| `GET /campaigns/:id/log` `?format=json\|text&since=<ms>` | admin: tutto; giocatore membro: solo ciò che vedeva | log di sessione (vedi "Chat e dadi") |

Lo schema ammette più campagne per istanza (oggi se ne usa una).

### Upload

- Tipo reale dai **magic bytes**: PNG (firma + `IHDR`), JPEG (`FFD8FF` + marcatore SOF), WebP (`RIFF…WEBP` con `VP8`, `VP8L` o `VP8X`). Estensione, nome e Content-Type inviati dal client sono ignorati. SVG, GIF e tutto il resto: 415.
- Dimensioni in pixel lette dall'intestazione; oltre `UPLOAD_MAX_SIDE` (16384) per lato o `UPLOAD_MAX_PIXELS` (100 M) di area: 413. Oltre `UPLOAD_MAX_BYTES` (25 MiB): 413. Rate limit `RATE_LIMIT_UPLOAD_MAX` al minuto per IP.
- Nome generato `<uuid>.<png|jpg|webp>` in `UPLOAD_DIR` (fuori dalla webroot), scrittura atomica (file temporaneo + rename), riga in `asset`.
- `GET /assets/:nome`: il nome deve corrispondere a `^<uuid>\.(png|jpg|webp)$` e a una riga di `asset`, altrimenti 404 (nessun percorso costruito dall'input: niente path traversal). Intestazioni: `Content-Type` dal database, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="<uuid>.<ext>"`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`.
- La risposta dell'upload contiene `url: "/assets/<uuid>.<ext>"`, relativo all'API: in sviluppo il client lo prefissa con `/api`. Il client lo usa in `scene.map.url` / `token.imageUrl`.

### Avviare e provare

```
npm install && cp .env.example .env
npm run create-admin -w @lanterna/server
npm run dev                       # server :3000, client :5173 (proxy /api)
npm test -w @lanterna/server      # unitari e integrazione (client WebSocket reali)
```

Prova a mano (con `websocat` o simili), dopo il login nel browser: copiare il cookie `lanterna.session_token` e connettersi a `ws://localhost:3000/ws` con header `Origin: http://localhost:3000` e `Cookie`, poi inviare `{"type":"hello","protocolVersion":1,"campaignId":"<id>","lastVersion":null,"epoch":null}`. I test d'integrazione (`src/realtime/realtime.test.ts`) aprono GM e due giocatori sulla stessa porta e cercano le stringhe segrete nel traffico ricevuto.

## Chat e dadi (M4)

Tipi e schemi in `packages/shared/src/protocol/chat.ts`; server in `packages/server/src/chat/` (costruzione delle voci, SQLite, esportazione) e `realtime/hub.ts` (invio filtrato, cronologia, rate limit).

### Voci del log

Chat e tiri sono **voci** con campi comuni: `id` (UUID), `authorId`, `authorName` (nome al momento dell'invio), `at` (ms, orologio del server), `visibility`, `whisperTo` (`userId` o `null`).

- `ChatEntry` (`kind: "message"`): `text`.
- `RollEntry` (`kind: "roll"`): `label` (o `null`), `formula` canonica (`2d6+3`, `1d20 adv`), `advantage`, `terms` (per ogni termine i dadi `{ face, value, kept }`: `face` = facce, `value` = esito, `kept` = conta nel totale), `total`, `detail` (`2d6+3 → [4, 5] + 3 = 12`, i dadi scartati tra parentesi), `critical` / `criticalFailure` (solo se la formula ha un unico d20: vale il d20 deciso, anche con vantaggio).

`chat.message { requestId, entry }` e `roll.result { requestId, entry }`: il `requestId` è valorizzato solo sulla connessione che ha fatto la richiesta (è la conferma); a tutti gli altri arriva `null`. Non c'è un `ack` separato.

### Visibilità e permessi (decisioni)

| `visibility` | Chi la vede | Chi può usarla |
|---|---|---|
| `public` | tutti i membri | tutti |
| `gm` (tiro segreto) | tutti i GM della campagna | **solo il GM**: un giocatore riceve `FORBIDDEN` |
| `whisper` | **solo autore e destinatario** | GM verso chiunque; **giocatore solo verso un GM** (verso un altro giocatore `FORBIDDEN`) |

- Il GM **non** vede i whisper altrui: vede quelli che manda e quelli indirizzati a lui. Con un solo GM (il caso normale) tutti i whisper dei giocatori passano da lui comunque; con più GM, un whisper giocatore→GM A non arriva al GM B. L'unica eccezione è l'esportazione dell'admin (log completo, vedi sotto).
- Un giocatore non può fare tiri segreti, ma può tirare in `whisper` al GM: lo vedono solo lui e quel GM.
- Chat: `whisperTo` assente = pubblico. Tiro: `whisperTo` obbligatorio con `whisper` e vietato con le altre visibilità (`INVALID`).
- Destinatario non membro della campagna: `NOT_FOUND`; se stessi: `INVALID`.
- Ordine dei controlli per un tiro: visibilità (`FORBIDDEN` prima di tutto) → destinatario → formula → tiro.
- La regola è una sola, `canSeeEntry(entry, { userId, role })`, usata per l'invio live; la stessa condizione in SQL filtra cronologia ed esportazione (e ogni riga riletta viene ricontrollata con `canSeeEntry`). Il ruolo è quello **attuale**: un giocatore promosso GM vede anche i tiri segreti passati.
- Nessuna fuga: una voce invisibile non genera **nessun** frame per chi non la vede (né id, né formula, né totale). I test cercano formule, totali, etichette e testi privati nei byte ricevuti dagli altri client.

### Tiri: esito solo sul server

Il client manda solo `formula` (stringa, al massimo 1000 caratteri nel protocollo; il parser poi applica i suoi limiti: 200 caratteri, 100 dadi in totale, da 2 a 1000 facce, 20 termini). Il server la valida con `parseFormula` e la tira con `roll` del pacchetto condiviso passando `crypto.randomInt` (`server/src/dice/crypto-rng.ts`). Campi in più (es. `total`) sono `INVALID`: il client non sceglie mai l'esito. L'RNG si può iniettare solo da `buildApp({ rng })` nei test; `main.ts` non lo passa, e un test verifica che l'app senza opzioni usi `crypto.randomInt` (anche intercettando `node:crypto`).

Formula non valida: `error { code: "INVALID", message: <messaggio italiano del parser>, reason: <codice del parser> }`, per esempio `9999d9999` → `DADI_FUORI_LIMITE` ("Un gruppo di dadi può avere da 1 a 100 dadi con da 2 a 1000 facce."). Vantaggio/svantaggio: `d20 adv`, `1d20+5 dis` (vedi il parser).

### Testo semplice

Il testo della chat (massimo `MAX_CHAT_TEXT_LENGTH` = 2000 caratteri) e le etichette dei tiri (100, su una riga) sono **testo semplice, mai HTML**. Il server non fa escaping (`<b>` resta `<b>`): il client deve mostrarlo come testo (nodi di testo React, `textContent`), mai con `innerHTML`/`dangerouslySetInnerHTML`. `sanitizeChatText` toglie caratteri di controllo, override e isolamenti bidirezionali (spoofing), spazi a larghezza zero, BOM e surrogati isolati; normalizza in NFC, unifica gli a capo e ne lascia al massimo una riga vuota di fila. Un testo vuoto dopo la sanificazione è `INVALID "messaggio vuoto"`.

### Cronologia

- Dopo ogni `hello` il server invia `history { requestId: null, entries, hasMore }` con le ultime `CHAT_HISTORY_LIMIT` (default 50, massimo 500) voci visibili all'utente, dalla più vecchia. Anche dopo una riconnessione: il client **sostituisce** la sua lista (o la unisce per `id`: una voce arrivata live poco prima può comparire anche nella cronologia).
- `history.request { before, limit? }`: le `limit` (default e massimo 100) voci visibili più vecchie della voce `before` (il suo `id`), o le ultime se `before` è `null`. Il cursore è l'`id` della prima voce che il client ha; un id inesistente o invisibile all'utente dà lo stesso `NOT_FOUND`.
- L'ordine è quello di salvataggio (`seq` interno, mai inviato).

### Persistenza (migrazione `0002_chat`)

Tabella `chat_entry`: `seq` (autoincremento, ordine), `id`, `campaign_id` (cascata), `kind`, `author_id`, `visibility`, `whisper_to`, `at`, `data` = voce completa in JSON (rivalidata con `LogEntrySchema` in lettura; righe non valide scartate). Autore e destinatario non sono chiavi esterne: il log resta anche se un utente viene eliminato. Come per i comandi, la voce si salva **prima** di essere inviata; se il salvataggio fallisce, `CONFLICT` e nessun invio. Chat e tiri passano dalla stessa coda della stanza dei comandi.

### Esportazione: `GET /campaigns/:id/log`

- Admin: log **completo** della campagna (`scope: "full"`), whisper altrui compresi (è l'amministratore dell'istanza).
- Giocatore membro: solo le voci che poteva vedere (`scope: "visible"`), con il ruolo attuale. Non membro o campagna inesistente: 404 (stessa risposta). Anonimo: 401.
- JSON (`SessionLogExport` in `shared/src/api.ts`) o `?format=text` (testo semplice, `Content-Disposition: attachment`; le righe successive di un messaggio sono rientrate, così un messaggio non può fingere un'altra voce). `?since=<ms>` per le voci da un istante in poi. `Cache-Control: no-store`.

### Rate limit

Per utente (su tutte le sue connessioni), secchiello di gettoni separato per messaggi e tiri: `CHAT_MESSAGES_PER_MINUTE` (30) con raffica `CHAT_MESSAGE_BURST` (10), `ROLLS_PER_MINUTE` (30) con raffica `ROLL_BURST` (10). Oltre: `error RATE_LIMITED`, nulla viene salvato né inviato. Il limite generale per connessione (`WS_MESSAGES_PER_SECOND`) resta valido anche per `history.request`.

### Cosa resta intuibile

- **Tempi**: chi non vede un tiro segreto non riceve nulla, ma il GM che tira in segreto ritarda di poco i messaggi successivi nella coda della stanza (trascurabile).
- **Rate limit** e **ruolo attuale**: i limiti sono in memoria (si azzerano al riavvio); un cambio di ruolo cambia la cronologia visibile anche all'indietro.

## Client in tempo reale (`packages/client/src/realtime`, `src/table`)

- **Percorsi pubblici.** Il client parla con il server sempre sotto `/api` (`realtime/urls.ts`): REST `/api/...`, WebSocket `ws(s)://<host>/api/ws`. In sviluppo li gestisce il proxy di Vite (`ws: true`, toglie il prefisso `/api`); in produzione la stessa regola va configurata nel reverse proxy / Cloudflare Tunnel. **Asset:** il server restituisce e lo stato conserva `/assets/<uuid>.<ext>` (relativo all'API); per mostrarli il client usa `assetUrl()` che li legge da `/api/assets/<uuid>.<ext>`. Lo stato quindi non dipende dal prefisso.
- **`RealtimeClient`** (senza React; stato immutabile per `useSyncExternalStore`): `hello` con ultima versione ed epoca a ogni (ri)connessione; `snapshot` sostituisce la vista; `delta` passa da `applyDelta` e, se rifiutato per buco di versione o epoca diversa, il client invia `hello` con `lastVersion: null` (snapshot) e ignora i delta finche' non arriva. Riconnessione con backoff esponenziale e jitter ("equal jitter": 500 ms, raddoppia fino a 15 s, il ritardo e' tra meta' e il tetto); `ping` ogni 25 s e socket abbandonato se manca il `pong` entro 10 s; torna la rete (`online`) = nuovo tentativo subito. Chiusure 4401 (sessione), 4404 (non membro), 4400 (protocollo) non riconnettono; il browser non distingue un 401 dell'upgrade da una caduta qualsiasi, quindi ogni 3 tentativi falliti si controlla `get-session` e, se scaduta, ci si ferma e si torna al login.
- **Comandi.** Ogni comando/annulla/ripeti ha un `requestId` (UUID) e restituisce una promessa con ack o errore (`FORBIDDEN`, `INVALID`, `CONFLICT`, `NOT_FOUND`, piu' `OFFLINE` e `TIMEOUT` locali). Nessun effetto ottimistico: la vista cambia solo con i delta del server (il canvas mostra solo l'anteprima del trascinamento). I messaggi che il client non interpreta (`chat.message`, `roll.result`) sono inoltrati agli ascoltatori di `onEvent`.
- **Cosa fa la UI.** Prima campagna di `/campaigns/mine` (admin senza campagne: creazione guidata); `MapCanvas` alimentato dalla scena attiva (il GM puo' guardarne un'altra senza attivarla); strumenti GM solo come UX, il server verifica sempre. Scorciatoie: Cmd/Ctrl+Z annulla, Maiusc+Cmd/Ctrl+Z (o Ctrl+Y) ripete, ignorate dentro i campi di testo.
- **Limiti.** Il modello di token non ha un campo colore: senza immagine il colore e' derivato dal tipo (e dall'id) in modo stabile, non e' scelto dall'utente. Le condizioni sono quelle del motore 5e (nessuna condizione personalizzata). Chat e tiri: vedi "Chat e dadi nel client" qui sotto.
- **Test.** `realtime/RealtimeClient.test.ts` (server finto), `table/*.test.*`, e `packages/client/e2e/realtime.e2e.test.ts`: `RealtimeClient` reale contro `buildApp` con DB temporaneo (riusa gli helper di `packages/server/src/test`, `ws` e' dev-dependency del client).

## Chat e dadi nel client (`packages/client/src/chat`, `src/settings`)

- **Stato.** `ChatStore` (senza React) si aggancia a `RealtimeClient.onEvent` e vive in `ChatProvider` dentro `Table`, quindi raccoglie voci, badge e tiri anche a pannello chiuso. Cronologia in `chatLog.ts`: `history` senza `requestId` (handshake) si unisce per `id` alla lista (se non si sovrappone a nulla, la sostituisce); con `requestId` è una pagina più vecchia (cursore = `id` della prima voce). Le voci live già note sono ignorate. Bozze, destinatario, formula, visibilità e vantaggio restano nello store, perché le schede del pannello si smontano.
- **Invio.** `RealtimeClient.sendChat`, `sendRoll`, `requestHistory`: la conferma è il `chat.message`/`roll.result`/`history` con il proprio `requestId`; gli errori (`FORBIDDEN`, `INVALID` con `reason`, `RATE_LIMITED`...) tornano sulla promessa. Il client manda solo la formula: l'esito, il dettaglio, critico/fallimento critico si mostrano come arrivano dal server. L'errore di formula (messaggio italiano del parser) compare accanto al campo.
- **Testo semplice.** Messaggi, nomi e etichette sono nodi di testo React (`whitespace: pre-wrap`); mai `innerHTML`. Test con `<img onerror>` in `chat/chat.test.tsx`.
- **Whisper e visibilità.** Il selettore "Invia a" offre i GM al giocatore e tutti gli altri membri al GM (la regola vera è sul server); "Solo GM" per i tiri compare solo al GM. I messaggi privati hanno sfondo tinta, icona e etichetta in testo ("Sussurro da Marta", "Solo GM").
- **Comandi.** `/r <formula>` tira con la visibilità e il vantaggio impostati nel pannello dei dadi; `/w <nome> <testo>` (nome anche con spazi o tra virgolette); un `/comando` sconosciuto non viene mai spedito come messaggio. Tasti: `/` o Invio (con focus sul tavolo) portano il cursore nella chat e aprono il pannello; Esc esce dal campo.
- **Scorrimento e accessibilità.** Il log segue i nuovi messaggi solo se si è in fondo (altrimenti compare "N nuovi messaggi"); le pagine più vecchie non spostano la lettura. Regione `role="status"` cortese annuncia solo l'ultima voce arrivata; il log stesso non è live.
- **Overlay 3D** (`DiceOverlay`): a ogni `roll.result` ricevuto dal vivo (non dalla cronologia) mostra `DiceTray` con i dadi di `terms[].dice` (compresi gli scartati; max 10, solo d4-d12, d20, d%), poi svanisce dopo ~4 s; `pointer-events: none`, `aria-hidden`. Non compare se disattivato in Impostazioni (`localStorage`, chiave `lanterna.settings.v1`), con `prefers-reduced-motion` o senza WebGL: resta il risultato scritto. I tiri segreti arrivano solo al GM, quindi solo lui vede l'animazione.
- **Test.** `chat/chat.test.tsx` e `chat/chatLogic.test.ts` (Vitest + Testing Library, `DiceTray` finto); `e2e/chat.e2e.test.ts` (server reale, GM + 2 giocatori: whisper e tiro segreto non arrivano al terzo). Helper dei test end-to-end in `e2e/helpers.ts`.

## Limiti noti

- Niente comando di riordino (z-order): un token ricreato da annulla torna in cima.
- `members` non si modifica con i comandi: lo gestisce il server (REST e auth) con cambio d'epoca.
- La cronologia di annulla/ripeti vive solo in memoria: si perde a ogni riavvio e a ogni cambio di membri. Stato e registro dei delta invece sono salvati.
- Upload: nessuna miniatura o versione ridimensionata. Servirebbe decodificare l'immagine: `sharp` ha binari nativi e script d'installazione (bloccati da npm 11), e un decodificatore in puro JS per mappe fino a 100 Mpx userebbe centinaia di MB di RAM. Il formato si verifica dall'intestazione, non decodificando tutti i pixel: un file con intestazione valida e dati corrotti viene accettato (il browser semplicemente non lo mostra; con `nosniff` e la CSP non può essere eseguito). I metadati (EXIF, posizione GPS) non vengono rimossi.
- I file caricati sono visibili a ogni utente autenticato che conosce l'URL (UUID non indovinabile), non solo ai membri della campagna (eccezione dal M6: le mappe di scene con nebbia, servite ai giocatori solo a tessere); l'immagine di un token nascosto non viene inviata ai giocatori, ma l'URL non è revocabile.
- Il logout chiude il WebSocket solo al keep-alive successivo (al più `WS_HEARTBEAT_MS`).
- Chat e tiri: niente modifica né cancellazione dei messaggi; niente whisper fra giocatori o a più destinatari; il client anima i dadi sui valori di `terms[].dice` di `roll.result` solo localmente (ogni client anima i tiri che riceve, non c'è un'animazione condivisa temporizzata).
- Nebbia di guerra (M6): logica, server e UI del client pronti; limiti in [docs/FOG.md](FOG.md).

## Produzione (M5): prefisso /api

In produzione tutte le rotte HTTP e il WebSocket stanno sotto `API_PREFIX` (default `/api`): il WebSocket e `/api/ws`, REST e `/api/campaigns` ecc. In sviluppo e nei test il prefisso e vuoto (il proxy Vite riscrive `/api/x` in `/x`). L url restituito dagli upload (`/assets/<uuid>.<ext>`) e relativo alla radice dell API: il client lo richiede come `/api/assets/...`. Dettagli in `docs/DEPLOY.md`; contenuti importati (`/content`) in `docs/CONTENT.md`.

## Schede personaggio e statblock (M8, REST)

Le schede NON passano dal WebSocket (nessun cambiamento a protocollo e stato condiviso): sono risorse REST sotto la campagna. Tipi in `packages/shared/src/sheetsApi.ts`, modello in `packages/shared/src/rules5e/doc.ts` (`SheetDoc` = `CharacterSheet` del motore + extra: inventario, attacchi, incantesimi, note, testo dello statblock). Il documento è validato con `sheetDocSchema` a ogni scrittura **e a ogni lettura** dal database (un documento corrotto dà 500, non passa). Server: `packages/server/src/sheets/`, tabella `character_sheet` (migrazione `0005_sheets`).

| Richiesta | GM | Giocatore membro | Altri |
|---|---|---|---|
| `GET /campaigns/:id/sheets` | tutte (riepiloghi) | solo le proprie `pc` | 404 (non membro) |
| `GET .../sheets/:sheetId` | ogni scheda | solo la propria `pc`; altre e mostri **404** | 404 |
| `POST .../sheets` `{ kind, doc, ownerUserId?, tokenId? }` | `pc` e `monster`; proprietario = giocatore membro; token esistente e libero | solo `pc` proprio (proprietario forzato a sé, max 20); `monster`, altro proprietario o `tokenId` → 403 | 404 |
| `PUT .../sheets/:sheetId` `{ version, doc?, ownerUserId?, tokenId? }` | tutto | solo `doc` della propria; `ownerUserId`/`tokenId` presenti → 403; altrui/mostri 404 | 404 |
| `DELETE .../sheets/:sheetId` | sì (204) | propria → 403, altrui/mostri → 404 | 404 |

- **Concorrenza**: `version` cresce di 1 a ogni scrittura; `PUT` è condizionato (`UPDATE ... WHERE version = ?`). Scrittura obsoleta → **409** `{ code: "CONFLICT", currentVersion }`, nulla cambia. Il client salva da solo (debounce) e, su conflitto, fa scegliere tra "versione più recente" e "tieni le mie".
- **Nessuna fuga**: scheda altrui, statblock e scheda inesistente rispondono con lo stesso 404 e lo stesso corpo. L'elenco del giocatore non contiene mai mostri; il legame `tokenId` (il token potrebbe essere nascosto) non è mai inviato ai giocatori. Corpi fino a 512 KiB su queste rotte, rate limit sulle scritture.
- **Tiri**: il client calcola la formula con `rollFor` (competenza, vantaggio/svantaggio dalle condizioni, Esaurimento) e invia `roll.request`; l'esito lo decide il server. Un fallimento automatico (es. Stordito sui TS di Forza/Destrezza) non invia nulla. Dadi vita e tiri contro la morte: il client tira con `roll.request`, e **all'arrivo del `roll.result`** applica `spendHitDie`/`deathSaveSheet` alla scheda.

### Regola PF e condizioni scheda ↔ token

- **Fonte di verità = la scheda** per PF, PF temporanei e condizioni. La barra della vita del token resta il dato di stato del token (visibile solo a GM e proprietario, come oggi): nessun cambiamento al modello di stato né al filtro.
- **Scheda → token** (unica sincronizzazione automatica): il client del GM (`planTokenSync`, `SheetsProvider`) legge l'elenco schede ogni 8 s e dopo ogni salvataggio proprio; quando PF o condizioni di una scheda collegata **cambiano** rispetto all'ultima osservazione, invia `token.update { health, conditions }` (comando del GM, quindi con tutti i controlli di permesso del server). Le condizioni del token che non sono del motore 5e (personalizzate) restano. La prima osservazione fissa solo il riferimento: non sovrascrive la barra; un token senza barra la riceve subito.
- **Token → scheda**: solo su richiesta del GM (pulsante "Copia i PF dal token alla scheda" nell'editor). Se il GM ritocca la barra del token, vale finché la scheda non cambia di nuovo (ultima scrittura vince, per sorgente).
- **Limite noto**: se nessun GM è collegato, la barra del token resta indietro finché non si riconnette. Evita fughe: il giocatore non scrive mai sul token, e non conosce il legame.

## Combattimento e forme effimere (M7)

Dettagli e regole in `docs/COMBAT.md`.

**Comandi** (dentro `command`, tutti con inverso per annulla/ripeti): `combat.add/update/remove/reorder/setInitiative/sort/start/next/previous/end/restore`, `effect.add/update/remove`, `group.create/update/delete/restore`, `group.apply { target, action }`. Tutti solo GM, salvo `group.apply` del giocatore (solo `move`/`addCondition`/`removeCondition` su propri token con `target.kind = "tokens"`). Campi nuovi del token: `faction` (solo GM) ed `effects` (`TokenPatch`, solo GM).

**Client → server** (messaggi propri, con `requestId`, risposta `ack`/`error`):
- `initiative.roll { sceneId, rolls: [{ participantId, bonus, mode? }], sort? }`: solo GM (altrimenti FORBIDDEN). Il server tira d20 + bonus con `crypto.randomInt` e applica `combat.setInitiative`.
- `ephemeral.show { id, sceneId, audience: private|gm|all, ttlMs?, shape, color? }` e `ephemeral.clear { id }`. Forme: `ruler`, `circle`, `cone`, `line`, `arrow`, `ping`. `private` non genera eventi. Rate limit per utente (`EPHEMERAL_PER_SECOND`, `EPHEMERAL_BURST`): `RATE_LIMITED`.

**Server → client**:
- Nei `delta`/`snapshot`: `CampaignView.combats` (il GM tutti, il giocatore solo la scena attiva, già filtrati) e `groups` (solo GM); `TokenView.effects` (sempre presente, anche `[]`) e `faction` (solo GM). Eventi `combat.updated { sceneId, combat|null }` (sostituzione per intero), `group.created/updated/deleted` (solo GM).
- Avvisi (nei `delta`, non cambiano la vista): `combat.turn`, `effect.expiring`, `effect.expired`, solo a GM e proprietario del token.
- Messaggi effimeri fuori dai delta e dalla versione, mai ripetuti alla riconnessione: `ephemeral.shown { id, authorId, sceneId, ttlMs, shape, color? }` (con la nebbia `shape` può essere `{ kind: "cells", cells: [col, riga, ...] }` nella griglia della nebbia) ed `ephemeral.cleared { id, authorId }`.

**Persistenza**: tabelle `combat` e `token_group` (migrazione `0006_combat`); effetti e fazione stanno nel JSON del token. Le forme effimere non vengono salvate.

**Limite noto (M8)**: la sincronizzazione scheda → token riscrive `conditions`; una condizione data da un effetto ma non presente nella scheda può essere tolta dal sync del GM alla prima modifica della scheda.

## Esportazione e importazione di campagna, libreria di token (M10, REST)

Nessun cambiamento a protocollo WebSocket e stato condiviso: sono risorse REST **solo admin** (403 al giocatore, verificato prima di leggere il corpo). Tipi in `packages/shared/src/campaignIo.ts` e `library.ts`; server in `packages/server/src/archive/` e `library/`. La nuova campagna importata riparte con **epoca nuova e versione 0**: i client collegati ad altre campagne non ricevono nulla, chi apre la nuova riceve uno `snapshot`.

### Formato dell'archivio (`formatVersion` 1)

Uno `.zip` con soli nomi fissi (mai usati come percorsi sul disco): `manifest.json`, `campaign.json`, `members.json`, `scenes.json`, `tokens.json`, `fog.json`, `walls.json`, `combats.json`, `groups.json`, `sheets.json`, `content.json`, `library.json`, `assets.json`, `chat.json` (solo con `?chat=true`) e `assets/<uuid>.(png|jpg|webp)`.

- **Manifesto**: `format: "lanterna-campaign"`, `formatVersion`, `exportedAt`, `appVersion`, `protocolVersion`, nome della campagna, `includesChat`, conteggi, `warnings`, e l'elenco di TUTTI gli altri file con dimensione e SHA-256 (verificati all'importazione: un file modificato, mancante o in più è un errore).
- **Membri (scelta di privacy)**: gli utenti NON sono esportati. `members.json` ha solo nome visualizzato e ruolo con un riferimento opaco (`m1`, `m2`, ...) che sostituisce ogni id utente (proprietari dei token e delle schede, maschere di nebbia, autori e destinatari della chat; gli autori non più membri diventano `x1`, ...). Mai inclusi: email, password o hash, sessioni, segreto di Better Auth, `.env`, percorsi del server. Perché: l'archivio può finire su un altro server o in mani altrui, e gli id utente sono locali all'istanza. All'importazione l'admin associa i giocatori ai propri utenti.
- Contenuti: stato (scene, token, nebbia, muri, combattimenti, gruppi), schede, contenuti importati **della campagna** (non quelli globali), libreria **della campagna** (non quella globale), immagini realmente usate (mappe, token, libreria), chat e tiri solo con il flag (include whisper e tiri segreti: è un backup del GM).

### Endpoint

| Richiesta | Note |
|---|---|
| `GET /campaigns/:id/export[?chat=true]` | zip in streaming (memoria costante, contropressione); controlli e limiti PRIMA del primo byte (`413` oltre `ARCHIVE_MAX_BYTES`/`ARCHIVE_MAX_UNPACKED_BYTES`); `404` campagna inesistente. Rate limit come gli upload. |
| `POST /campaigns/import?preview=true` | multipart (`file`, facoltativo `options`): valida TUTTO (stesse verifiche dell'importazione, riferimenti e invarianti compresi) e restituisce `ImportPreview` (nome, data, versione, conteggi, membri con nome e ruolo, byte, avvisi) senza scrivere nulla. |
| `POST /campaigns/import` | multipart: `options` (JSON, prima del file: `name?`, `memberMap` ref → id utente giocatore o `null`, `includeChat`) e `file`. Crea una NUOVA campagna (mai sovrascrive), `201` con `ImportResult`. Un'importazione alla volta (le altre `429`). |

### Importazione difensiva (archivio non fidato)

- Streaming con `fflate` letto da disco a pezzi da 64 KiB; limiti sui byte **realmente decompressi** (non su quelli dichiarati, che possono mentire): per documento (`ARCHIVE_MAX_JSON_BYTES`), per immagine (`UPLOAD_MAX_BYTES`), totale (`ARCHIVE_MAX_UNPACKED_BYTES`), numero di voci (`ARCHIVE_MAX_ENTRIES`), archivio caricato (`ARCHIVE_MAX_BYTES`). Una "bomba" è fermata appena supera il limite.
- Nomi: elenco chiuso. `../x`, percorsi assoluti, `\`, caratteri di controllo, voci duplicate o non elencate nel manifesto → `400`; nessun nome è mai un percorso.
- Ogni documento passa da Zod (`strictObject`: campi sconosciuti rifiutati); le schede anche da `sheetDocSchema` + `deriveDoc`; i contenuti dalle stesse regole dell'importazione contenuti (niente HTML, profondità, `__proto__`).
- Immagini: tipo reale dai magic bytes (`sniffImage`: PNG/JPEG/WebP, mai SVG), estensione, dimensioni, limiti per lato e area come l'upload (`exceedsImageLimits`), e coerenza con `assets.json` (`415`/`413`).
- Id **tutti rigenerati** (campagna, scene, token, muri, gruppi, schede, voci di chat, immagini con nome UUID nuovo); riferimenti incrociati rimappati; riferimento pendente o stato incoerente (`checkInvariants`) → `400`.
- Transazione: prima i file (nomi nuovi), poi UNA transazione SQLite; se fallisce i file vengono cancellati e non resta nulla. Cartella di parcheggio `UPLOAD_DIR/.import-<uuid>/`, sempre rimossa (e ripulita all'avvio).
- Membri: il GM dell'archivio è l'admin che importa; i giocatori si associano solo a utenti con ruolo giocatore, uno per utente. Un giocatore non associato perde la proprietà di token e schede e la maschera di nebbia personale; il resto resta.

### Libreria di token e oggetti

Tabella `library_item` (migrazione `0007_library`), `data` JSON validato con `LibraryContentSchema` a ogni lettura. Elemento: `name`, `kind` (`pc|monster|object`), `size`, `imageUrl`, `stats` (`hpMax`, `armorClass`, `speed`, tutte facoltative), `tags`; ambito `campaign` (con `campaignId`) o `global`.

| Richiesta | Admin | Giocatore |
|---|---|---|
| `GET /library?campaignId=&q=&kind=&limit=&offset=` | elementi della campagna + globali (senza `campaignId`: solo globali); ricerca su nome e tag | solo se membro della campagna (altrimenti `404`), solo tipi di `LIBRARY_PLAYER_KINDS` (default nessuno), **senza** `stats` né `campaignId` |
| `GET /library/:id` | sì | come sopra; tipo non consentito o campagna non sua = `404` identico a "inesistente" |
| `POST /library`, `PATCH /library/:id`, `DELETE /library/:id` | sì | `403` |

Un elemento non è un token: il client crea l'istanza con il comando `token.create` esistente (id nuovo, scena e posizione scelti sul momento). Immagine: se è `/assets/<uuid>.<ext>` deve esistere.

## Livelli, oggetti di scena e gestione scene (M10, WebSocket)

- **Modello** (`shared/src/state/props.ts`, `state.props`, facoltativo): oggetto di scena `{ id, sceneId, name, imageUrl, x, y, width, height, rotation, layer, opacity, fade, hidden }`. Livelli: `background` (sopra la mappa, sotto la griglia), `ground` (sopra la griglia, sotto la nebbia e i token), token, `above` (sopra i token). L'ordine dell'array è l'ordine di disegno dentro il livello. Nessuna immagine nel repo: l'immagine si carica con `POST /uploads/map` (solo admin).
- **Comandi solo GM** (FORBIDDEN prima di guardare lo stato): `prop.create`, `prop.update` (patch parziale), `prop.delete`, `scene.duplicate` (`sceneId`, `newSceneId`, `name`). Inverso esatto: `prop.create` ↔ `prop.delete`, `prop.update` con i valori precedenti, `scene.duplicate` → `scene.delete` (che a sua volta si annulla ricreando token, muri, oggetti e nebbia). Gli id delle copie derivano da `newSceneId` (`-t<i>`, `-w<i>`, `-p<i>`): il comando è deterministico per annulla/ripeti. La copia non è attiva, non include effetti dei token né combattimento.
- **Gestione scene**: crea, rinomina (`scene.update`), elimina, duplica, `scene.activate` (mostra ai giocatori). Una scena non attiva è una preparazione: il giocatore non riceve né la scena, né token, muri, nebbia e oggetti (`canSeeScene`, `canSeeProp`).
- **Filtro per utente** (`canSeeProp`, `projectProp`): il giocatore riceve solo gli oggetti non nascosti della scena attiva e, con la nebbia, solo se una cella sotto l'ingombro (rettangolo di contorno ruotato) è rivelata a lui; mai `name` né `hidden`. Eventi `prop.created/updated/deleted`; `scene.activated` e il cambio di nebbia portano gli oggetti; un oggetto che entra o esce dalla nebbia è per il giocatore una creazione o una scomparsa. Con la nebbia un oggetto `above` parzialmente rivelato è disegnato intero (limite noto: si vede la parte sotto celle coperte).
- **Dissolvenza**: la calcola il client (`map/propLogic.ts`) con i soli dati già ricevuti: il giocatore schiarisce gli oggetti `above` con `fade` quando un SUO token è sotto, il GM quando c'è sotto un personaggio. Nessuna informazione in più dal server.
- **Persistenza**: tabella `prop` (migrazione `0008_props`), `persistChanges` la aggiorna e la svuota con la scena. Non ancora in esportazione/importazione di campagna (vedi PLAN).
