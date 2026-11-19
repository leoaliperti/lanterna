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
```

Previsti nelle milestone successive: migrazioni Drizzle (M1/M2) e test end-to-end con Playwright (M2). Configurazione: copia `.env.example` in `.env`.

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
