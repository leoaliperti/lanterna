# Lanterna

VTT (virtual tabletop) per giocare di ruolo online con gli amici: mappa con griglia, token, chat, dadi, e in seguito nebbia di guerra, iniziativa, schede e finestre multiple. Ospitato su un server di casa, raggiungibile tramite Cloudflare Tunnel. Progetto open source fin dall'inizio, licenza **AGPL-3.0-or-later** (chi usa questo codice deve restare open source). Repo GitHub: `leoaliperti/lanterna`.

I requisiti completi sono in `DnD REMOTE INTERFACE REQUIREMENTS.txt` (Desktop dell'autore). Le decisioni prese e le milestone vivono in `docs/PLAN.md`.

## Stack

- Linguaggio: TypeScript ovunque (strict).
- Frontend: React + Vite.
- Canvas mappa: **PixiJS** (confermato).
- Backend: Node.js + **Fastify** (confermato).
- Tempo reale: WebSocket con `ws` (confermato). Il server è l'unica fonte di verità. Niente `BroadcastChannel`: anche le finestre multiple sono client WebSocket.
- Database: SQLite + Drizzle ORM.
- Autenticazione: **Better Auth** (confermato). Deve essere robusta di suo: Cloudflare Access potrebbe arrivare solo in seguito.
- Dadi 3D: Three.js come dipendenza npm (non da CDN), a partire da DiceGen (vedi `docs/PLAN.md`).
- Accesso: Cloudflare Tunnel. Cloudflare Access opzionale, da aggiungere più avanti.

## Comandi

Gestore pacchetti: npm (workspace in `packages/shared`, `server`, `client`). Node 22 o superiore.

```
npm install         # installa le dipendenze
npm run dev         # sviluppo: server (porta 3000) + client Vite con proxy /api
npm run build       # build di shared, server e client
npm start           # produzione: server compilato che serve anche il client, tutto su una porta (API sotto /api)
npm test            # test unitari e di integrazione (Vitest)
npm run lint        # ESLint + typecheck
npm run create-admin -w @lanterna/server   # crea il primo admin/GM (idempotente)
npm run db:generate -w @lanterna/server    # genera una migrazione dopo aver cambiato src/db/schema.ts
npm run backup -w @lanterna/server         # copia consistente di DB + uploads in BACKUP_DIR (ultime BACKUP_KEEP)
npm run restore -w @lanterna/server -- <cartella-backup|file.db> [--yes]   # server FERMO
npm run import-content -w @lanterna/server -- <file.json|cartella>        # contenuti di gioco (docs/CONTENT.md)
```

Le migrazioni (in `packages/server/drizzle/`) si applicano da sole all'avvio del server e di `create-admin`. Previsti: test end-to-end con Playwright (M2). Configurazione: copia `.env.example` in `.env` (nella radice).

## Autenticazione (M1)

- **Better Auth** montato sotto `/auth`, con un elenco chiuso di rotte (`src/auth/routes.ts`): `POST /auth/sign-in/email`, `POST /auth/sign-out`, `GET /auth/get-session`, `POST /auth/change-password`. Tutto il resto, `sign-up` compreso, risponde 404; in più `disableSignUp: true`.
- **Gestione utenti** sotto `/admin/users` (`src/users/`), solo ruolo `admin`: elenco, creazione, cambio ruolo, eliminazione, reset password. L'ultimo admin non si può declassare né eliminare (controllo atomico in SQL).
- **Hook riusabili** (`src/auth/session.ts`): `requireSession` e `requireRole("admin")`, da usare come `onRequest` così il ruolo si verifica prima di leggere il corpo; `getSessionFromUpgradeRequest` per il WebSocket (M2) insieme a `isAllowedOrigin` (`src/security.ts`).
- **Database:** SQLite con Drizzle e driver `@libsql/client` (binari precompilati, nessuno script di installazione: npm 11 li blocca). Schema in `src/db/schema.ts`.
- **Sicurezza:** password con scrypt (default Better Auth), minimo 12 caratteri; rate limit per IP su login, cambio password e creazione utenti (`@fastify/rate-limit`); cookie `HttpOnly`, `SameSite=Lax`, `Secure` in produzione; `TRUST_PROXY` per leggere l'IP reale dietro Cloudflare Tunnel; ogni POST/PATCH/DELETE deve avere Origin (o Referer) fra le origini ammesse; header di sicurezza con `@fastify/helmet`; login errato e utente inesistente danno la stessa risposta. In produzione `BETTER_AUTH_SECRET` e `BETTER_AUTH_URL` sono obbligatori.
- **Test:** ogni nuova rotta protetta va aggiunta alla tabella `endpoints` in `src/users/admin.test.ts` (o equivalente) con i casi anonimo 401, giocatore 403, admin ok.

## Tempo reale, campagne e upload (M2/M3, server)

Dettagli completi in `docs/PROTOCOL.md` (sezione "Server").

- **WebSocket** su `/ws` (in sviluppo `ws://localhost:5173/api/ws` tramite il proxy Vite, che deve avere `ws: true`): libreria `ws` agganciata all'evento `upgrade` di Fastify (`src/realtime/server.ts`). Origin non ammesso → 403 e niente sessione → 401, **prima** dell'handshake. Stanze per campagna in `src/realtime/hub.ts`: comandi in coda, attore sempre dalla sessione, salvataggio in transazione **prima** di inviare i delta filtrati con `deltaFor`/`planResync`. Keep-alive, rate limit, limite di 64 KiB e chiusura delle connessioni quando cambiano ruolo, membri o sessione.
- **Persistenza** (`src/campaigns/store.ts`, migrazione `0001_campaigns`): campagne, membri, scene e token (JSON validato con Zod in lettura), registro eventi per i delta anche dopo un riavvio. Se il database contiene dati non validi il server non parte.
- **REST**: `/campaigns` (admin), `/campaigns/mine` (autenticato), `/campaigns/:id/members` (admin). Ogni nuova rotta protetta va aggiunta alla tabella `adminEndpoints` di `src/campaigns/campaigns.test.ts` (o equivalente).
- **Upload** (`src/media/`, non `uploads/` perché è in `.gitignore`): `POST /uploads/map|token` solo admin, tipo dai magic bytes (PNG/JPEG/WebP, niente SVG), limiti di byte e pixel, file in `UPLOAD_DIR` con nome UUID, `GET /assets/:uuid.:ext` solo autenticati. Nessuna miniatura (servirebbero dipendenze native).
- **Test**: `npm test -w @lanterna/server`. I test di `src/realtime/realtime.test.ts` avviano il server su una porta vera con GM e giocatori connessi via `ws` e cercano i dati segreti nel traffico ricevuto; helper in `src/test/` (`ws.ts`, `campaign.ts`, `images.ts`).

## Chat e dadi (M4, server)

Dettagli in `docs/PROTOCOL.md` (sezione "Chat e dadi"). Tipi condivisi in `packages/shared/src/protocol/chat.ts`.

- **Messaggi**: `chat.send` (testo semplice, max 2000, `whisperTo?`), `roll.request` (`formula`, `visibility: public | gm | whisper`, `whisperTo?`, `label?`), `history.request` (cursore = `id` della voce più vecchia). Il server risponde con `chat.message`, `roll.result` (formula canonica, `detail`, `terms` con i dadi, `total`, `critical`), `history`; errori `FORBIDDEN`/`INVALID` (formula: messaggio del parser e `reason`)/`NOT_FOUND`/`RATE_LIMITED`.
- **Esito solo sul server**: `parseFormula` + `roll` con `crypto.randomInt` (`src/dice/crypto-rng.ts`). L'RNG si inietta solo nei test con `buildApp({ rng })` / `createTestApp(env, tweak, persistent, { rng })`.
- **Visibilità** (`canSeeEntry`, unica regola): `gm` solo GM e solo il GM può usarla; `whisper` solo autore e destinatario (il GM non vede i whisper altrui); il giocatore sussurra solo a un GM.
- **Persistenza**: tabella `chat_entry` (migrazione `0002_chat`), salvataggio prima dell'invio; cronologia filtrata in SQL (`src/chat/store.ts`). Dopo ogni `hello` arrivano le ultime `CHAT_HISTORY_LIMIT` voci.
- **REST**: `GET /campaigns/:id/log` (admin tutto, giocatore membro solo ciò che vedeva, altri 404), JSON o `?format=text`.
- **Rate limit** per utente: `CHAT_MESSAGES_PER_MINUTE`/`CHAT_MESSAGE_BURST`, `ROLLS_PER_MINUTE`/`ROLL_BURST`.
- **Test**: `src/chat/chat.test.ts` (GM + 2 giocatori su WebSocket reali, ricerca di formule, totali e testi privati nel traffico) e `src/chat/crypto-roll.test.ts` (l'app di produzione chiama `crypto.randomInt`). Il client deve mostrare il testo come testo, mai come HTML.

## Produzione, operazioni e contenuti (M5, server)

Guide: `docs/DEPLOY.md` (deploy, Cloudflare Tunnel, backup, aggiornamenti, checklist), `docs/CONTENT.md` (formato di importazione).

- **Una porta, un processo** (`src/web.ts`): con `NODE_ENV=production` il server serve `packages/client/dist` con `@fastify/static` (ripiego SPA su `index.html`, `assets/` con hash `immutable`, il resto `no-cache`) e comprime con `@fastify/compress`. **Tutta l'API sta sotto `config.apiPrefix`** (`/api` in produzione, vuoto in sviluppo e nei test: il proxy Vite `/api` → radice e i test esistenti restano invariati). Le rotte si registrano dentro il plugin con quel prefisso (`app.ts`), mai sull'app radice; `auth/routes.ts` e `realtime/server.ts` ne tengono conto (WebSocket `/api/ws`). Test in `src/web.test.ts`.
- **CSP**: pagina (`pageCsp`: solo `'self'`, `worker-src blob:`, nessuna CDN, `unsafe-eval` solo con `CSP_ALLOW_UNSAFE_EVAL`); API `default-src 'none'`. In produzione il server non parte con: segreto corto, URL non https (salvo `ALLOW_INSECURE_HTTP=true` per prove locali), `TRUST_PROXY=true`, DB in memoria, client non compilato (`config.test.ts`).
- **Backup** (`src/ops/backup.ts`): `VACUUM INTO` (mai copiare il file mentre è scritto), cartelle `lanterna-AAAAMMGG-OOMMSS`, rotazione, ripristino che verifica la sorgente (intestazione SQLite, `integrity_check`, tabella `user`) e sposta i dati attuali in `.prima-del-ripristino-<data>`. Gli script `backup`/`restore`/`import-content` girano da `dist` (serve `npm run build`).
- **Contenuti** (`src/content/`, tabella `content`, migrazione `0003_content`): documenti JSON tipizzati, validati con Zod (niente HTML, limiti di dimensione e profondità), importazione idempotente e transazionale. `POST /content/import` e `DELETE /content/:id` solo admin; `GET /content` e `/content/:id` per ogni utente, ma il giocatore vede solo i tipi di `CONTENT_PLAYER_KINDS` (default `item,spell`; `monster` e `note` mai), il resto 404. `.gitignore` ancora `/content/` e `/imports/` alla radice (un `content/` generico escluderebbe `src/content`).
- **Hardening**: `src/hardening.test.ts` controlla che git non tracci file privati e che `.env.example` documenti ogni variabile letta dal server (aggiungi lì le nuove). `npm audit --omit=dev` deve restare a 0: un `overrides` in `package.json` porta l'esbuild di drizzle-kit a una versione corretta.

## Nebbia di guerra (M6, logica e server)

Dettagli in `docs/FOG.md`. La UI del client (`packages/client/src/fog`, `map/fogLayer.ts`, `map/drawTools.ts`, `table/Fog*.tsx`) è descritta in fondo a `docs/FOG.md`.

- **Modello** (`shared/src/state/fog.ts`, `walls.ts`, `vision.ts`): per scena una nebbia con griglia propria e maschere per giocatore (`everyone` + `players`), ciascuna `{ base, runs }` a terne di celle in forma canonica; muri `{ x1, y1, x2, y2, door, open }`; `token.vision` facoltativo. Campi facoltativi: nessuna nebbia = comportamento di prima.
- **Comandi** solo GM: `fog.enable/disable/reveal/cover/revealAll/coverAll/setLighting/restore`, `wall.add/update/remove`; `target` tutti o giocatori scelti; inverso esatto con `fog.restore`.
- **Filtro**: `canSeeToken(token, viewer, activeSceneId, fog)` richiede SEMPRE la nebbia della scena (`fogOf(state, sceneId)`); i `StateChange` portano la nebbia con sé. Il giocatore riceve solo la propria maschera, i token con almeno una cella rivelata sotto l'impronta (i propri sempre), i pezzi di muro nelle celle rivelate e `map: null`.
- **Mappa**: mai l'URL intero ai giocatori con la nebbia; tessere `GET /campaigns/:id/scenes/:sceneId/tiles/:col/:row` generate dal server (`media/tiles.ts`, pngjs/jpeg-js/@jsquash/webp, nessuna dipendenza nativa) e mascherate per utente; ogni rifiuto = stesso 404. `/assets` non serve ai giocatori una mappa usata da una scena con nebbia (`hub.assetAllowed`).
- **Persistenza**: tabelle `fog` e `wall` (migrazione `0004_fog`); chi esce dalla campagna perde la maschera (`withMembers`).
- **Test**: `shared/src/state/fogstate.test.ts`, `fog.test.ts`, `vision.test.ts` (con benchmark), fuzz in `fuzz.test.ts`; server `src/fog/fog.test.ts` (GM + 2 giocatori, tessere, riavvio).

## Schede personaggio e statblock (M8)

Dettagli e matrice dei permessi in `docs/PROTOCOL.md` (sezione "Schede personaggio e statblock"). Modello in `packages/shared/src/rules5e/doc.ts`.

- **REST, non WebSocket** (`src/sheets/`, tabella `character_sheet`, migrazione `0005_sheets`): `/campaigns/:id/sheets`. GM tutto; il giocatore solo le proprie `pc` (altre e statblock: 404 identico a "inesistente"); proprietario e legame col token solo GM (403). `SheetDoc` validato con Zod a ogni lettura e scrittura; `version` + `PUT` condizionato → 409 `CONFLICT`. Ogni nuova rotta va nella matrice di `src/sheets/sheets.test.ts`.
- **PF/condizioni**: la scheda è la fonte di verità; il client del GM copia i cambiamenti sul token collegato (`planTokenSync`), niente modifiche a protocollo/stato. Il giocatore non riceve mai `tokenId`.
- **Client** (`packages/client/src/sheets/`): elenco nel pannello "Schede", finestra con più schede a linguette (affiancabili su schermi larghi), ricerca per sezione, libreria importata (`GET /content?kind=`). I tiri inviano `roll.request` con la formula di `rollFor`; l'esito è del server. Test: `sheets.test.tsx`, `sheetLogic.test.ts`, e2e `e2e/sheets.e2e.test.ts`.
- Nessun contenuto di gioco nel repo: i test usano nomi e testi inventati.

## Combattimento e azioni sulla mappa (M7, logica e server)

Dettagli in `docs/COMBAT.md` e `docs/PROTOCOL.md`. La UI del client (`packages/client/src/combat`, `map/measure.ts`, strumenti in `map/MapCanvas.tsx`) è descritta nella sezione "Client" di `docs/COMBAT.md`.

- **Stato**: `state.combats` (uno per scena, partecipanti ordinati, `round`, `turnId`), `state.groups` (solo GM), `token.effects` e `token.faction` (facoltativi). Moduli: `shared/src/state/combat.ts` (schemi), `combat-reducer.ts` (iniziativa, turni, effetti, gruppi), `combat-ops.ts` (danno/cura con `rules5e/hp`, `resolveTarget`), `reducer-util.ts` (`done` deriva da solo i cambiamenti di combattimenti e gruppi confrontando gli stati), `shapes.ts` (geometria).
- **Regole**: tutti i comandi di combattimento, effetto e gruppo sono solo GM (FORBIDDEN prima di guardare lo stato); `group.apply` è una macro di comandi ordinari (atomica, annullabile in un colpo, stessi permessi). Un nuovo comando di combattimento deve avere inverso esatto e voce nella matrice di `combat-access.test.ts`.
- **Filtro**: tracker ricalcolato per utente (`projectCombat`, anche al cambio di nebbia/token/scena); avvisi `combat.turn`/`effect.*` solo a GM e proprietario; gruppi, fazione e effetti segreti mai ai giocatori.
- **Effimeri**: `ephemeral.show/clear` mai persistiti; ogni destinatario riceve la forma ritagliata per la sua nebbia (`shapeForViewer`); le misure private non passano dal server. Iniziativa: `initiative.roll` con RNG del server (`hub.rng`).
- **Test**: `shared/src/state/combat*.test.ts`, `shapes.test.ts`, fuzz in `combat-fuzz.test.ts`; server `src/combat/combat.test.ts` (GM + 2 giocatori, nebbia, riavvio). Migrazione `0006_combat`; nuove variabili in `.env.example`.
- **Client**: le misure private non partono mai dal client; quelle pubbliche usano `ephemeral.show` (il server ritaglia per la nebbia, il client disegna le `cells` ricevute e non ricostruisce nulla). Ogni azione sui token e' un solo `group.apply`. Test: `src/combat/*.test.ts(x)`, `src/map/measure.test.ts`, `src/map/controllerCombat.test.ts`, e2e `e2e/combat.e2e.test.ts`.

## Esportazione/importazione di campagna e libreria di token (M10)

Dettagli e formato in `docs/PROTOCOL.md` (sezione "Esportazione e importazione di campagna, libreria di token"); uso operativo in `docs/DEPLOY.md` (esportazione vs backup SQLite).

- **REST solo admin** (nessun cambiamento al protocollo WebSocket): `GET /campaigns/:id/export[?chat=true]`, `POST /campaigns/import[?preview=true]` (multipart `file` + `options`), `/library` (CRUD solo admin; lettura giocatore limitata, vedi sotto). Ogni rotta ha il suo caso 401/403 nei test (`src/archive/archive.test.ts`, `src/library/library.test.ts`, riga "esportazione campagna" in `campaigns.test.ts`).
- **Archivio** (`src/archive/`): zip con `fflate` (puro JS, MIT) in streaming. `export.ts` prepara tutto prima del primo byte e poi produce lo zip a pezzi; `zip-read.ts` legge in streaming contando i byte REALMENTE decompressi (mai fidarsi delle dimensioni dichiarate); `import.ts` valida (`stageArchive`: nomi a elenco chiuso, manifesto con SHA-256, Zod su ogni documento, immagini con `sniffImage` + `exceedsImageLimits` come l'upload) e poi `commitImport` rigenera tutti gli id, rimappa i riferimenti e scrive file + UNA transazione. L'anteprima (`?preview=true`) usa `commitImport(..., dryRun)`: stesse verifiche, nessuna scrittura.
- **Privacy**: gli utenti non si esportano mai (solo nome e ruolo con riferimento opaco `m1`...; mai email, password, sessioni, segreti). Un nuovo campo di stato che contenga id utente va rimappato in `export.ts`/`import.ts`, altrimenti l'id esce nell'archivio (il test "nessun id utente" lo coglie).
- **Importazione**: crea una campagna NUOVA, un'importazione alla volta; cartella di parcheggio `UPLOAD_DIR/.import-<uuid>/` (rimossa prima della risposta e all'avvio; il backup la ignora). Limiti in `config.archive` (`ARCHIVE_MAX_*` in `.env.example`).
- **Libreria** (`src/library/`, tabella `library_item`, migrazione `0007_library`): `LIBRARY_PLAYER_KINDS` (default nessuno); al giocatore mai `stats` né `campaignId`; fuori permesso = 404 identico a "inesistente". Se rebase/merge produce due migrazioni con lo stesso numero, rigenera la tua con `npm run db:generate -w @lanterna/server`.
- **Client**: `screens/BackupScreen.tsx` (route `#/admin/backup`, voce nel menu utente dell'admin), `library/` (pannello "Libreria", `LibraryPanel`, logica in `libraryLogic.ts`) e "Salva nella libreria" in `table/TokenEditor.tsx`. `#/?campaign=<id>` apre una campagna precisa (non c'è ancora un selettore di campagne). Test: `screens/backup.test.tsx`, `library/library.test.tsx`, e2e `e2e/campaign-io.e2e.test.ts`.

## Finestre multiple e vista giocatore (M9)

Dettagli in `docs/WINDOWS.md`.

- **Solo WebSocket**: ogni finestra è un client autenticato con la sua connessione; niente `BroadcastChannel` né comunicazione fra finestre.
- **Viste** (`packages/client/src/windows/`): `#/table`, `#/view/map|notes|chat|combat`, `#/view/scene/<id>` e `#/view/player/<userId>` (solo GM). Menu "Apri in nuova finestra" e pulsante nel pannello; disposizione per tipo di vista in `localStorage` (`lanterna.windows.v1`, sempre in try/catch); cornice minimale `ViewFrame`. La sincronizzazione scheda → token gira solo nella finestra del tavolo.
- **Vista giocatore generata dal server**: `/ws?viewAs=<userId>` (solo GM della campagna, membro guardato; altrimenti 403 all'upgrade o FORBIDDEN + 4403 all'`hello`), attore del membro per ogni filtro (`viewerActor` in `realtime/hub.ts`), sempre in sola lettura. `?readOnly=1` per chiunque. Tessere con `?viewAs=`. Mai ricostruire nel client la vista di un altro utente filtrando quella del GM.
- **Test**: `server/src/realtime/viewas.test.ts` (stessi frame del giocatore, scritture FORBIDDEN, 403), `client/src/windows/*.test.*`, e2e `client/e2e/windows.e2e.test.ts`. Una nuova richiesta WebSocket che scrive deve passare da `rejectReadOnly`/`roomOf` in `hub.ts`.

## Livelli, oggetti di scena e scene (M10, parte A)

Dettagli in `docs/PROTOCOL.md` (sezione "Livelli, oggetti di scena e gestione scene"). Modello in `packages/shared/src/state/props.ts`.

- **Oggetti**: `state.props` (facoltativo), livelli `background`/`ground`/(token)/`above`, comandi solo GM `prop.create/update/delete` e `scene.duplicate`, ciascuno con inverso esatto. Un nuovo comando va nella matrice di `shared/src/state/props.test.ts` e `server/src/props/props.test.ts`.
- **Filtro**: `canSeeProp`/`projectProp` (lista bianca; mai `name`/`hidden` ai giocatori, nebbia come per i token). Un nuovo tipo di `StateChange` va gestito anche in `history.ts` (`checkExpect`).
- **Client**: `map/propLayer.ts` (tre contenitori Pixi, dissolvenza degli `above` in `propLogic.ts`), scheda "Oggetti" (`table/PropsPanel.tsx`, solo GM, posizione e dimensioni da campi numerici), "Duplica" in `ScenePanel`, selettore di campagne nel titolo (`table/CampaignSwitcher.tsx`, `#/?campaign=<id>`).
- Migrazione `0008_props`. Esportazione/importazione di campagna non copre ancora gli oggetti.

## Scorciatoie e mobile (M10 B, client)

Registro unico delle scorciatoie in `packages/client/src/table/shortcutRegistry.ts` (aiuto con `?`, `shortcutRegistry.test.ts` fallisce sui conflitti): ogni nuova scorciatoia va scritta li'. Libreria trascinabile sulla mappa (`library/libraryLogic.ts`, `dropCommand`). Tablet in verticale: pannello ancorato sotto la mappa (`DOCK` in `TableFrame.tsx`). Dettagli in `docs/QA.md`.

## Regole non negoziabili

1. **Account: solo l'admin li crea.** L'admin coincide con il GM. I ruoli sono due: admin/GM e giocatore. Nessuna registrazione pubblica. Il controllo del ruolo avviene **lato server** su ogni endpoint di creazione/modifica/eliminazione utenti. Nascondere il pulsante nella UI non basta. Ogni funzione di questo tipo deve avere un test che dimostri il rifiuto (403) per un utente non admin.
2. **Non copiare codice da Owlbear Rodeo Legacy** (licenza non commerciale, non open source). Si può leggere per capire l'architettura, non si copia nulla.
3. **Ogni libreria o snippet copiato va annotato nel README** con licenza e fonte (URL). Prima di copiare un file si controlla la licenza del progetto d'origine. Il codice deve essere compatibile con AGPL-3.0 (MIT, BSD, Apache-2.0, GPL/AGPL vanno bene). Licenze non commerciali o proprietarie sono vietate.

## Principi di architettura

- **Il server decide, il client mostra.** Le informazioni nascoste (token nascosti, vita, note del GM, aree non rivelate, tiri segreti) non vengono mai inviate ai client che non possono vederle. Filtrare sul server, non nascondere nel client.
- I permessi si verificano lato server su ogni messaggio WebSocket e ogni richiesta HTTP.
- I tiri di dado si calcolano sul server con `crypto.randomInt` (entropia del sistema). Il client riceve solo il risultato e lo anima; il client non sceglie mai l'esito.
- Barra della vita: inviata solo al GM e al giocatore proprietario del token. Condizioni e stati sono visibili a tutti.
- Il giocatore sposta solo il proprio token. Ridimensionare e ruotare è solo del GM.
- Annulla/ripeti: il giocatore solo sulle proprie azioni, il GM su tutto.
- La nebbia di guerra è manuale, in mano al GM, con maschera per giocatore. Il calcolo automatico della vista dei token è solo un aiuto visivo e non scopre mai la nebbia.
- Le misurazioni private restano sul client; quelle pubbliche sono eventi sincronizzati.
- Contenuti di gioco (mostri, regole, manuali) non vanno mai nel repo. Si inseriscono nella propria istanza con uno strumento di importazione.
- Sistema di regole: D&D 5e, edizione 2024, tutto tranne i punti esperienza. La logica è nostra; i testi dei manuali non vanno nel repo.
- Fuori ambito per ora: audio e voce (si usa Discord).
- Repo pubblico: niente segreti nel codice o nella cronologia git. Solo `.env.example`; `.env` e il file SQLite sono in `.gitignore`.
