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
npm start           # avvio in produzione (server compilato)
npm test            # test unitari e di integrazione (Vitest)
npm run lint        # ESLint + typecheck
npm run create-admin -w @lanterna/server   # crea il primo admin/GM (idempotente)
npm run db:generate -w @lanterna/server    # genera una migrazione dopo aver cambiato src/db/schema.ts
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
