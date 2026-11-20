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

Il design system del client (`packages/client/src/ui`) e' scritto da zero in CSS puro e React, senza librerie di animazione ne' primitive esterne; segue le Human Interface Guidelines di Apple come ispirazione, senza includere font, icone o asset Apple (si usa lo stack di sistema `-apple-system, system-ui`). Dettagli in [`docs/DESIGN.md`](docs/DESIGN.md); la gallery e' su `#/ui` in sviluppo.

Le schermate del client (login, tavolo, gestione utenti) usano solo i componenti del design system. Il router e' un piccolo router a hash scritto da zero (`packages/client/src/router`): nessuna libreria aggiunta.

Non viene copiato codice da Owlbear Rodeo Legacy (licenza non commerciale).

### Attribuzione SRD 5.2

This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

Il motore di regole (`packages/shared/src/rules5e`) implementa solo meccaniche (formule, tabelle numeriche, identificatori generici). Classi, specie, incantesimi, mostri e armature arrivano da contenuti importati dall'utente e iniettati a runtime.

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
