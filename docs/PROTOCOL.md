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
                             gmNotes }
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
| `chat.send` | `requestId`, `text`, `whisperTo?` | segnaposto M4 |
| `roll.request` | `requestId`, `formula`, `secret?` | segnaposto M4, esito deciso dal server |
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

Campi di `token.update`: `name`, `imageUrl`, `size`, `rotation`, `ownerUserId`, `kind`, `hidden`, `conditions`, `health`, `gmNotes`. Quindi ridimensionare, ruotare, nascondere, cambiare la vita e assegnare un token sono **solo del GM**. Una patch che mescola campi consentiti e no è rifiutata per intero.

`token.move` aggancia alla griglia se `snap` (o, se assente, `grid.snap` della scena) è vero: token di lato dispari al centro della cella, di lato pari sull'incrocio. Rimpicciolire una mappa riporta dentro i token rimasti fuori.

## Messaggi server → client

| `type` | Campi | Note |
|---|---|---|
| `snapshot` | `protocolVersion`, `epoch`, `version`, `view` | `view = viewFor(state, utente)` |
| `delta` | `epoch`, `fromVersion`, `toVersion`, `events[]` | eventi già filtrati per l'utente |
| `ack` | `requestId`, `version` | comando applicato |
| `error` | `requestId \| null`, `code`, `message` | `FORBIDDEN`, `INVALID`, `CONFLICT`, `NOT_FOUND` |
| `chat.message`, `roll.result` | | segnaposto M4 |
| `pong` | | |

Eventi dentro un `delta`: `token.created {token}`, `token.updated {tokenId, changes}`, `token.deleted {tokenId}`, `scene.created {scene}`, `scene.updated {sceneId, changes}`, `scene.deleted {sceneId}`, `scene.activated {sceneId, scene, tokens}` (il giocatore sostituisce scena e token con quelli ricevuti).

Codici d'errore:

- `FORBIDDEN`: l'utente vede l'oggetto ma non può fare l'azione; i comandi solo-GM danno `FORBIDDEN` **prima** di guardare lo stato (anche per id inesistenti).
- `INVALID`: forma o valori non validi.
- `CONFLICT`: id già usato; annulla/ripeti su campi cambiati nel frattempo da altri.
- `NOT_FOUND`: inesistente **o invisibile** per l'utente. Un token nascosto e uno che non esiste danno lo stesso errore con lo stesso messaggio. I messaggi d'errore sono fissi e non contengono mai id o dati.

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

## Limiti noti

- Niente comando di riordino (z-order): un token ricreato da annulla torna in cima.
- `members` non si modifica con i comandi: lo gestisce l'auth (M1).
- Chat e tiri sono solo schemi segnaposto; filtri di whisper e tiri segreti arriveranno con M4.
- Nebbia di guerra (M6) non ancora modellata.
