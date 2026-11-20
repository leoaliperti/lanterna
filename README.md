# Lanterna

Tavolo virtuale (VTT) open source per giocare di ruolo online con gli amici: mappa con griglia, token, chat, dadi e, in seguito, nebbia di guerra, iniziativa e schede D&D 5e. Pensato per essere ospitato su un server di casa e raggiunto tramite Cloudflare Tunnel.

**Stato:** M0 completata; M1 (autenticazione, lato server) in corso. Vedi [`docs/PLAN.md`](docs/PLAN.md) per decisioni e milestone e [`CLAUDE.md`](CLAUDE.md) per stack e regole di sviluppo.

## Licenza

[AGPL-3.0-or-later](LICENSE). Chi usa o modifica questo codice, anche solo ospitandolo come servizio, deve restare open source con la stessa licenza.

## Contenuti di gioco

Il repository non contiene mostri, incantesimi, manuali o altro testo protetto. Ogni istanza li importa a mano.

## Crediti, codice e librerie di terze parti

Ogni libreria o snippet copiato va elencato qui con licenza e fonte.

| Componente | Licenza | Fonte | Uso |
|---|---|---|---|
| DiceGen (dadi 3D) | MIT | https://git.aliperti.me/alipe/DiceGen.git (stesso autore) | base dell'animazione dei dadi (`packages/client/src/dice3d`), riscritta in TypeScript con esito deciso dal server |
| Three.js 0.187.0 | MIT | https://github.com/mrdoob/three.js | rendering 3D dei dadi |
| PixiJS 8.23.0 (`pixi.js`) | MIT | https://github.com/pixijs/pixijs | canvas della mappa (`packages/client/src/map`), caricato in modo lazy; dettagli in [`docs/MAP.md`](docs/MAP.md) |
| Zod | MIT | https://github.com/colinhacks/zod | validazione dello schema `CharacterSheet` (`packages/shared`) |
| System Reference Document 5.2 (SRD 5.2) | CC-BY-4.0 | https://www.dndbeyond.com/srd | formule e tabelle numeriche del motore di regole 5e 2024 (`packages/shared/src/rules5e`); nessun testo copiato |
| Lucide (`lucide-react`) | ISC | https://github.com/lucide-icons/lucide | icone del design system (client). Non si usano SF Symbols: la licenza Apple ne vieta l'uso fuori dalle piattaforme Apple |
| `@testing-library/user-event` | MIT | https://github.com/testing-library/user-event | solo test: simulazione di tastiera e puntatore |
| Better Auth | MIT | https://github.com/better-auth/better-auth | login, sessioni, hash delle password |
| Drizzle ORM | Apache-2.0 | https://github.com/drizzle-team/drizzle-orm | accesso a SQLite e migrazioni |
| drizzle-kit | MIT | https://github.com/drizzle-team/drizzle-orm | generazione delle migrazioni (sviluppo) |
| @libsql/client | MIT | https://github.com/tursodatabase/libsql-client-ts | driver SQLite senza compilazione nativa |
| @fastify/rate-limit | MIT | https://github.com/fastify/fastify-rate-limit | rate limit su login e creazione utenti |
| @fastify/helmet | MIT | https://github.com/fastify/fastify-helmet | header di sicurezza HTTP |
| @fastify/static | MIT | https://github.com/fastify/fastify-static | il server serve il client compilato in produzione (`packages/server/src/web.ts`) |
| @fastify/compress | MIT | https://github.com/fastify/fastify-compress | compressione gzip/brotli delle risposte |
| ws | MIT | https://github.com/websockets/ws | server WebSocket (`packages/server/src/realtime`) e client nei test |
| @fastify/multipart (con @fastify/busboy) | MIT | https://github.com/fastify/fastify-multipart | upload di mappe e immagini dei token |
| pngjs 7.0.0 | MIT | https://github.com/pngjs/pngjs | nebbia (M6): decodifica e codifica PNG in JavaScript puro per le tessere della mappa per giocatore (`packages/server/src/media/tiles.ts`) |
| jpeg-js 0.4.4 | BSD-3-Clause | https://github.com/jpeg-js/jpeg-js | nebbia (M6): decodifica e codifica JPEG in JavaScript puro per le tessere |
| @jsquash/webp 1.5.0 (libwebp in WebAssembly, dal progetto Squoosh) | Apache-2.0 (libwebp: BSD-3-Clause) | https://github.com/jamsinclair/jSquash | nebbia (M6): decodifica WebP per le tessere; il modulo `.wasm` è incluso nel pacchetto npm, nessuno script di installazione |
| wasm-feature-detect (dipendenza di @jsquash/webp) | Apache-2.0 | https://github.com/GoogleChromeLabs/wasm-feature-detect | rilevamento delle funzioni WebAssembly |
| fflate 0.8.3 | MIT | https://github.com/101arrowz/fflate | esportazione/importazione di campagna (M10): zip e unzip in streaming in JavaScript puro, nessuna dipendenza nativa (`packages/server/src/archive`); anche nei test del client (e2e) |

Il design system del client (`packages/client/src/ui`) e' scritto da zero in CSS puro e React, senza librerie di animazione ne' primitive esterne; segue le Human Interface Guidelines di Apple come ispirazione, senza includere font, icone o asset Apple (si usa lo stack di sistema `-apple-system, system-ui`). Dettagli in [`docs/DESIGN.md`](docs/DESIGN.md); la gallery e' su `#/ui` in sviluppo.

Le schermate del client (login, tavolo, gestione utenti) usano solo i componenti del design system. Il tempo reale usa il `WebSocket` del browser e lo stato condiviso di `packages/shared`: nessuna libreria di stato aggiunta (solo `useSyncExternalStore`). `ws` e `@types/ws` sono dev-dependency del client solo per il test di integrazione (`packages/client/e2e`). Il router e' un piccolo router a hash scritto da zero (`packages/client/src/router`): nessuna libreria aggiunta.

Non viene copiato codice da Owlbear Rodeo Legacy (licenza non commerciale).

### Attribuzione SRD 5.2

This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

Il motore di regole (`packages/shared/src/rules5e`) implementa solo meccaniche (formule, tabelle numeriche, identificatori generici). Classi, specie, incantesimi, mostri e armature arrivano da contenuti importati dall'utente e iniettati a runtime.

## Deploy

Guida completa (Node 22+, `.env` di produzione, `systemd`/`launchd`, Cloudflare Tunnel con WebSocket, Cloudflare Access opzionale, backup e ripristino, aggiornamenti, checklist di sicurezza) in [`docs/DEPLOY.md`](docs/DEPLOY.md). In breve:

```
npm ci && npm run build
NODE_ENV=production npm start   # client + API su una sola porta (API sotto /api, WebSocket /api/ws)
npm run backup -w @lanterna/server
```

Dockerfile e docker-compose.yml opzionali nella radice. L'importazione dei contenuti di gioco è in [`docs/CONTENT.md`](docs/CONTENT.md).

## Sviluppo

Richiede Node 22 o superiore.

```
npm install
cp .env.example .env
npm run create-admin -w @lanterna/server   # primo admin/GM
npm run dev      # server su :3000 e client Vite
npm test
npm run lint
```
