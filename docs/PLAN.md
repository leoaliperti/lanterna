# Piano di Lanterna

Stato: M0 completata; M1 backend (auth, ruoli, gestione utenti) in revisione, manca la UI di login e amministrazione. M2/M3 lato server (WebSocket, persistenza SQLite, REST campagne, upload) in revisione; mancano canvas e client WebSocket. M4 lato server (chat con whisper, tiri con esito sul server, tiri segreti, cronologia e log di sessione) in revisione; chat e dadi nel client (scheda Chat, barra dadi, overlay 3D, Impostazioni) in revisione: vedi "Chat e dadi nel client" in docs/PROTOCOL.md. M8 (schede 5e e statblock, server REST + client) in revisione: vedi "Schede personaggio e statblock" in docs/PROTOCOL.md. Gestore pacchetti: npm workspaces (pnpm non è installato e non serviva). Client in tempo reale collegato al server (tavolo reale, strumenti GM, annulla/ripeti): vedi "Client in tempo reale" in docs/PROTOCOL.md. M6 (nebbia di guerra) logica condivisa e server in revisione: maschere per giocatore, muri, linea di vista come aiuto visivo, tessere della mappa per giocatore; manca la UI del client (vedi docs/FOG.md). M7 (combattimento: iniziativa, effetti con durata, gruppi e azioni di gruppo, misure e segnalazioni effimere) logica condivisa, server e UI del client in revisione (vedi docs/COMBAT.md). M10, parte esportazione/importazione di campagna (zip con manifesto versionato, importazione difensiva e transazionale, schermata admin "Backup e importazione") e libreria di token con ricerca: server e client in revisione, vedi "Esportazione e importazione di campagna, libreria di token" in docs/PROTOCOL.md; M10 parte A (livelli con oggetti di scena che si schiariscono sotto i token, gestione scene con duplicazione, selettore di campagne) in revisione: vedi "Livelli, oggetti di scena e gestione scene" in docs/PROTOCOL.md; restano oggetti nell'esportazione di campagna, trascinamento degli oggetti sulla mappa, scorciatoie e mobile completo. M9 (finestre multiple e vista giocatore, server e client) in revisione: vedi docs/WINDOWS.md. Parte B (client): scorciatoie, libreria trascinabile e mobile completo in revisione, vedi docs/QA.md.

## Decisioni prese

| Tema | Decisione |
|---|---|
| Nebbia di guerra | Manuale, in mano al GM, con maschera per giocatore. La vista automatica dei token è solo un aiuto visivo e non scopre mai la nebbia. |
| Token | Il giocatore sposta solo il proprio. Ridimensionare e ruotare: solo GM. |
| Barre della vita | Visibili solo a GM e giocatore proprietario. Condizioni e stati visibili a tutti. |
| Finestre multiple | Solo WebSocket, nessun `BroadcastChannel`. Funzionano anche su altri PC. Vista giocatore generata dal server con `/ws?viewAs=<userId>` (solo GM, sola lettura), tessere con `?viewAs=`; mai filtrata nel client (docs/WINDOWS.md). |
| Misurazioni private | Restano sul client. |
| Undo/redo | Giocatore: solo sulle proprie azioni. GM: su tutto. |
| Ruoli | Admin = GM. Due ruoli: admin/GM e giocatore. |
| Accesso | Autenticazione robusta nell'app. Cloudflare Access forse più avanti. |
| Contenuti di gioco | Mai nel repo. Strumento di importazione per inserirli a mano nell'istanza. |
| Licenza | AGPL-3.0-or-later. |
| Sistema di regole | D&D 5e, edizione 2024, tutto tranne i punti esperienza. Le regole si implementano come logica nostra; i testi (mostri, incantesimi, manuali) non entrano nel repo. |
| Stack | PixiJS, Fastify, `ws`, Better Auth, confermati. |
| Driver SQLite | `@libsql/client` con file locale: binari precompilati, nessuno script di installazione (npm 11 li blocca; `better-sqlite3` richiederebbe compilazione nativa). `node:sqlite` scartato perché in Node 22 è ancora sperimentale e Drizzle non lo supporta ufficialmente. |
| WebSocket sul server | `ws` direttamente sull'evento `upgrade` di Fastify (niente `@fastify/websocket`): rifiuto 401/403 esplicito prima dell'handshake. |
| Persistenza campagne | Scene e token come JSON validato con Zod in lettura; registro eventi salvato per i delta dopo un riavvio. |
| Nebbia: rappresentazione | Celle di una griglia propria della nebbia; maschera = stato base + eccezioni a terne `[riga, colInizio, colFine)` in forma canonica; maschera "di tutti" più maschere personali. Dettagli in docs/FOG.md. |
| Nebbia: immagine della mappa | Ai giocatori solo tessere da 512 px della scena generate dal server e mascherate per utente (pngjs, jpeg-js, @jsquash/webp in WASM: nessun binario nativo); tessera coperta = 404 identico a inesistente; `/assets` non serve ai giocatori le mappe di scene con nebbia. |
| Nebbia: token e muri | Token visibile al giocatore se almeno una cella sotto la sua impronta è rivelata a lui (il proprio sempre); muri ritagliati alle celle rivelate. |
| Miniature delle mappe | Rimandate: `sharp` richiede binari nativi e script d'installazione (bloccati da npm 11). |
| Whisper e tiri segreti | Whisper visibili solo ad autore e destinatario: il GM non vede i whisper altrui. Il giocatore sussurra (e tira in whisper) solo al GM; solo il GM fa tiri segreti (`gm`). L'esportazione del log per l'admin è completa. |
| Audio | Fuori ambito iniziale (si usa Discord). |
| Esportazione di campagna | `.zip` con `manifest.json` versionato (`formatVersion`, data, versione app, SHA-256 di ogni file), un JSON per categoria e le immagini usate. Libreria `fflate` (MIT, JavaScript puro, nessuna dipendenza nativa) in streaming. Solo admin. |
| Esportazione: utenti | Mai esportati: solo nome e ruolo dei membri con un riferimento opaco al posto degli id; email, password, sessioni e segreti mai inclusi. All'importazione l'admin associa i giocatori ai suoi utenti. Il backup SQLite resta lo strumento per il ripristino dopo un guasto (docs/DEPLOY.md). |
| Importazione | Solo admin, crea una NUOVA campagna (mai sovrascrive); archivio non fidato: limiti sui byte realmente decompressi, nomi a elenco chiuso, Zod su ogni documento, immagini ricontrollate come l'upload, id e nomi file rigenerati, transazione tutto o niente, epoca nuova. |
| Libreria di token | Elementi salvati dall'editor token (nome, immagine, tipo, dimensione, statistiche base), per campagna o globali; CRUD solo admin; i giocatori leggono solo i tipi di `LIBRARY_PLAYER_KINDS` (default nessuno) senza statistiche. L'istanza si crea con `token.create` (clic; il trascinamento sulla mappa non c'è ancora). |
| MVP | Lista dell'autore, più caricamento mappa e salvataggio automatico. |

## Dadi: analisi di DiceGen

Sorgente: https://git.aliperti.me/alipe/DiceGen.git (licenza MIT, autore del progetto; Three.js 0.160.0 è MIT). Compatibile con AGPL, da annotare nel README.

Il codice è un buon punto di partenza per l'animazione (d4, d6, d8, d10, d12, d20, d%). Da cambiare:

1. **Casualità:** oggi usa `Math.random()` sul client, che sceglie l'esito. In Lanterna l'esito lo decide il server con `crypto.randomInt`. `startRoll` va riscritto per ricevere l'indice della faccia dal server (l'animazione è già separata dall'esito, quindi la modifica è piccola).
2. **Three.js da CDN:** va installato come dipendenza npm e incluso nel bundle Vite.
3. **Struttura:** è un unico `index.html` con CSS e JS; va portato in un componente React con TypeScript.
4. **Sincronizzazione:** gli altri giocatori devono vedere la stessa animazione con lo stesso esito. Tiri segreti: animazione solo per il GM.
5. **Verifica:** controllare la mappatura valori-facce del d4 (valore sulla faccia in basso o in alto) e del d10 prima di fidarsi.

## Milestone

Complessità: S = giorni, M = 1-2 settimane, L = 2-4 settimane, XL = oltre.

### MVP

| # | Contenuto | Output verificabile | Test | Compl. | Rischi |
|---|---|---|---|---|---|
| M0 | Scaffolding, CI, `LICENSE` (AGPL), README con tabella licenze, `.env.example`, scelte stack chiuse | `npm install && npm test && npm run build` verdi in CI; `/health` risponde | smoke test client e server | S | scelte stack sbagliate |
| M1 | Login, sessioni, ruoli, creazione utenti solo admin, primo admin da riga di comando | admin crea utente; giocatore riceve 403 chiamando l'endpoint a mano; nessuna registrazione pubblica | integrazione per ogni endpoint e ruolo; sessione scaduta; rate limit login | M | cookie dietro Cloudflare, brute force |
| M2 | Protocollo WebSocket, riconnessione, upload mappa, canvas PixiJS con zoom e pan, griglia e scala, salvataggio automatico | due browser vedono la stessa mappa; cambio griglia in tempo reale; stato intatto dopo riavvio server | unitari protocollo e griglia; integrazione con due client; e2e Playwright; upload non valido | L | sincronizzazione, upload enormi, mappe grandi |
| M3 | Token, drag con snap, assegnazione, token nascosti, barra della vita (solo GM e proprietario), condizioni, ridimensionamento e rotazione solo GM | token nascosto assente anche dal traffico di rete del giocatore; vita non inviata ai non autorizzati; spostamento del token altrui rifiutato | integrazione sui payload per utente; permessi; e2e drag | L | filtro per utente, concorrenza, 300 token a 60 fps |
| M4 | Chat con whisper, dadi con formule e vantaggio/svantaggio, esito server, tiri segreti, cronologia, log sessione, animazione da DiceGen | `2d6+3` visibile a tutti; tiro segreto solo al GM; whisper solo al destinatario; log persistente | parser formule con limiti; uniformità statistica; filtri per utente | M | parser abusabile, sync animazione, d4/d10 |
| M5 | Strumento di importazione contenuti, backup SQLite, deploy Cloudflare Tunnel, uso da tablet | sessione di prova con amici da internet; riavvio a metà partita senza perdite; ripristino da backup | e2e completo; ripristino; prova di carico con 6-8 utenti | M | WebSocket dietro tunnel, server esposto |

### Dopo l'MVP

| # | Contenuto | Compl. | Rischi |
|---|---|---|---|
| M6 | Nebbia manuale con maschera per giocatore, rivelazione con un clic; poi vista automatica come aiuto visivo | XL | la mappa sotto la nebbia non deve mai arrivare al client; prestazioni delle maschere; linea di vista |
| M7 | Iniziativa, round, effetti con durata, righello e aree, selezione multipla e gruppi, frecce dei giocatori, undo/redo (logica, server e UI del client in revisione: vedi docs/COMBAT.md) | L | stato di combattimento condiviso, undo per utente |
| M8 | Schede D&D 5e (caratteristiche, modificatori, bonus di competenza, abilità, tiri salvezza, CA, PF, incantesimi e slot, inventario, note; niente XP) con ricerca e pagine multiple, statblock, tiro cliccando su abilità o arma | XL | volume di regole 5e, contenuti solo via importazione |
| M9 | Finestre multiple e vista giocatore per il GM (server e client in revisione: docs/WINDOWS.md) | M | stato filtrato "come il giocatore X" generato dal server |
| M10 | Libreria token, livelli, più scene, esportazione/importazione campagna, scorciatoie, mobile completo | L | formato di esportazione, upload in importazione |

## Rischi trasversali

- **Sincronizzazione:** un solo modo di mutare lo stato; messaggi con id e versione; test di riconnessione.
- **Filtro dei dati per utente:** test dedicati in ogni milestone che controllano i payload.
- **Prestazioni canvas:** budget di 60 fps con 300 token, misurato.
- **Sicurezza:** server esposto, upload, rate limit, validazione di ogni messaggio.
- **Repo pubblico:** niente segreti, licenze annotate, niente codice da Owlbear Legacy, niente contenuti di gioco.
