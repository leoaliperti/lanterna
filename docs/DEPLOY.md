# Deploy su un server di casa con Cloudflare Tunnel

Guida passo-passo per ospitare Lanterna su una macchina tua (Linux o macOS) e raggiungerla da internet con un Cloudflare Tunnel, **senza aprire porte sul router**. Il server compilato serve client e API su **una sola porta** (3000, solo su `127.0.0.1`); il tunnel è l'unica via d'ingresso.

## Come è organizzato in produzione

- Un solo processo Node: `npm start` serve il client compilato (`packages/client/dist`) e l'API.
- L'API sta sotto **`/api`** (login `/api/auth/...`, WebSocket `/api/ws`, upload `/api/uploads/...`, file `/api/assets/...`, contenuti `/api/content/...`). Il client usa già `/api`, come il proxy di sviluppo di Vite che riscrive `/api/x` in `/x`. Il prefisso si controlla con `API_PREFIX` (vuoto in sviluppo e nei test).
- I file in `assets/` hanno l'hash nel nome e vengono serviti `immutable` per un anno; `index.html` è sempre rivalidato, quindi un aggiornamento arriva subito.
- Header di sicurezza e CSP: la pagina ammette solo risorse della stessa origine (nessuna CDN), `worker-src blob:`, `img-src data: blob:`, WebSocket verso l'origine pubblica. Le risposte dell'API hanno CSP `default-src 'none'`. Compressione gzip/brotli attiva.
- Nota per il client: PixiJS 8 senza `pixi.js/unsafe-eval` genera codice a runtime e richiede `'unsafe-eval'` nella CSP. Preferibile importare `pixi.js/unsafe-eval` nel client; in alternativa `CSP_ALLOW_UNSAFE_EVAL=true` (indebolisce la CSP).
- Il percorso `url` restituito da `POST /uploads/...` è relativo alla radice dell'API (`/assets/<uuid>.png`): in produzione il browser deve richiederlo come `/api/assets/<uuid>.png`.

## 1. Requisiti

- **Node 22 o superiore** (`node -v`) e npm. Git.
- Un dominio su Cloudflare (gratuito) per il tunnel, es. `lanterna.tuodominio.it`.
- Una macchina che resta accesa quando si gioca.

## 2. Installazione

```
git clone https://github.com/leoaliperti/lanterna.git
cd lanterna
npm ci
npm run build
```

## 3. Configurazione di produzione (`.env`)

Copia l'esempio e compilalo. **Non committare mai `.env`** (è in `.gitignore`).

```
cp .env.example .env
chmod 600 .env
```

Genera il segreto (almeno 32 caratteri) e scrivilo in `BETTER_AUTH_SECRET`:

```
openssl rand -base64 32
# senza openssl:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Valori minimi:

```
NODE_ENV=production
BETTER_AUTH_SECRET=<l'output del comando sopra>
BETTER_AUTH_URL=https://lanterna.tuodominio.it
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=loopback
DATABASE_URL=file:/var/lib/lanterna/lanterna.db
UPLOAD_DIR=/var/lib/lanterna/uploads
BACKUP_DIR=/var/backups/lanterna
BACKUP_KEEP=14
```

Note:

- Se `NODE_ENV=production` e manca il segreto o l'URL, **il server non parte**. Non parte neanche con: segreto sotto i 32 caratteri, `BETTER_AUTH_URL` non `https` (i cookie sono `Secure`), `TRUST_PROXY=true` (ci si fiderebbe di chiunque), database in memoria, client non compilato. Per provare la build in locale su `http://localhost` si usa `ALLOW_INSECURE_HTTP=true`: mai su un server esposto.
- `TRUST_PROXY=loopback` va bene con `cloudflared` sulla stessa macchina: l'IP reale dei giocatori (per il rate limit) si legge da `X-Forwarded-For` solo se la connessione arriva da loopback.
- Metti database, upload e backup **fuori dalla cartella del repo** e crea le cartelle con permessi stretti (vedi sotto). Se `DATABASE_URL`/`UPLOAD_DIR` sono relativi, partono da `packages/server`.
- Se cambi `BETTER_AUTH_SECRET` tutte le sessioni decadono.

```
sudo useradd --system --home /var/lib/lanterna --shell /usr/sbin/nologin lanterna   # Linux
sudo mkdir -p /var/lib/lanterna /var/backups/lanterna
sudo chown -R lanterna: /var/lib/lanterna /var/backups/lanterna
sudo chmod 700 /var/lib/lanterna /var/backups/lanterna
```

## 4. Primo avvio e primo admin

```
npm start                                 # prova: http://127.0.0.1:3000/api/health  =>  {"status":"ok"}
npm run create-admin -w @lanterna/server  # chiede email, nome e password (min. 12 caratteri)
```

Le migrazioni del database si applicano da sole all'avvio. Gli altri account li crea l'admin dall'app: **non esiste la registrazione pubblica**.

## 5. Avvio automatico

### Linux: systemd

`/etc/systemd/system/lanterna.service` (adatta i percorsi):

```ini
[Unit]
Description=Lanterna VTT
After=network-online.target
Wants=network-online.target

[Service]
User=lanterna
WorkingDirectory=/opt/lanterna
EnvironmentFile=/opt/lanterna/.env
ExecStart=/usr/bin/node packages/server/dist/main.js
Restart=on-failure
RestartSec=3
# Sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/lanterna /var/backups/lanterna

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now lanterna
journalctl -u lanterna -f
```

(`.env` letto da systemd non vuole il prefisso `export` né virgolette complicate. Il server legge comunque anche `/opt/lanterna/.env` da solo.)

### macOS: launchd

`~/Library/LaunchAgents/it.lanterna.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>it.lanterna.server</string>
  <key>WorkingDirectory</key><string>/Users/TUO_UTENTE/lanterna</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>packages/server/dist/main.js</string>
  </array>
  <!-- La configurazione viene letta da /Users/TUO_UTENTE/lanterna/.env: nessun segreto in questo file. -->
  <key>EnvironmentVariables</key>
  <dict><key>NODE_ENV</key><string>production</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/TUO_UTENTE/Library/Logs/lanterna.log</string>
  <key>StandardErrorPath</key><string>/Users/TUO_UTENTE/Library/Logs/lanterna.log</string>
</dict>
</plist>
```

```
launchctl load ~/Library/LaunchAgents/it.lanterna.server.plist
launchctl list | grep lanterna
# fermare: launchctl unload ~/Library/LaunchAgents/it.lanterna.server.plist
```

### Docker (opzionale)

`Dockerfile` e `docker-compose.yml` nella radice: utente non root, filesystem in sola lettura, un volume `/data` per database, upload e backup, porta pubblicata solo su `127.0.0.1`. Nessun segreto nei file: vengono da `.env`.

```
cp .env.example .env     # NODE_ENV, DATABASE_URL, UPLOAD_DIR... sono già impostati dall'immagine
# in .env: BETTER_AUTH_SECRET=..., BETTER_AUTH_URL=https://lanterna.tuodominio.it
docker compose up -d --build
docker compose exec lanterna node packages/server/dist/scripts/create-admin.js
docker compose exec lanterna node packages/server/dist/scripts/backup.js
```

`cloudflared` gira sull'host e raggiunge il container dal gateway Docker: `TRUST_PROXY` vale `172.16.0.0/12` (modificabile nel compose). Non è stato provato su un'installazione Docker reale dall'autore di questa guida.

## 6. Cloudflare Tunnel

Installa `cloudflared` ([istruzioni](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)) sulla stessa macchina.

```
cloudflared tunnel login
cloudflared tunnel create lanterna             # stampa l'ID e crea ~/.cloudflared/<ID>.json (credenziali: segrete)
cloudflared tunnel route dns lanterna lanterna.tuodominio.it
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: lanterna
credentials-file: /home/TUO_UTENTE/.cloudflared/<ID>.json

ingress:
  - hostname: lanterna.tuodominio.it
    service: http://127.0.0.1:3000
    originRequest:
      # I WebSocket (/api/ws) passano senza configurazione extra: cloudflared li inoltra da solo.
      connectTimeout: 10s
      noTLSVerify: false
  - service: http_status:404
```

```
cloudflared tunnel run lanterna                # prova
sudo cloudflared service install               # avvio automatico (Linux); su macOS: brew services start cloudflared
```

Controlli:

- `curl https://lanterna.tuodominio.it/api/health` risponde `{"status":"ok"}`.
- Dopo il login, la tabella si apre e la connessione WebSocket resta su (Cloudflare chiude le connessioni inattive dopo circa 100 secondi: il server manda un ping ogni 30 s, `WS_HEARTBEAT_MS`).
- In **Cloudflare dashboard → Rules**: lascia la cache sui valori predefiniti (non caching delle risposte `/api`); non attivare modifiche automatiche al contenuto che toccano l'HTML (es. Rocket Loader): la CSP non le ammette.

### Cloudflare Access (facoltativo)

Si può aggiungere un secondo livello **davanti** a Lanterna con Cloudflare Zero Trust → Access → Applications: una applicazione "self-hosted" per `lanterna.tuodominio.it` con una policy che ammette le email dei tuoi giocatori (codice monouso via email). Lanterna non dipende da Access: ha già login, sessioni e rate limit propri, quindi funziona con o senza. Se lo attivi, i giocatori fanno due passaggi di login; il WebSocket e le chiamate `/api` ereditano il cookie di Access. Evita policy "bypass" su `/api/*` a meno che tu non sappia perché.

## 7. Backup e ripristino

`npm run backup -w @lanterna/server` crea `BACKUP_DIR/lanterna-AAAAMMGG-OOMMSS/` con `lanterna.db` (copia **consistente** con `VACUUM INTO`: si può eseguire a server acceso, non si copia mai il file mentre viene scritto) e `uploads/`. Tiene le ultime `BACKUP_KEEP` copie e cancella le più vecchie (solo cartelle con quel nome). `BACKUP_DIR` non può stare dentro `UPLOAD_DIR`. Meglio se su un altro disco; per sicurezza vera copia anche fuori macchina (rsync, disco esterno).

cron (ogni notte alle 04:00; adatta i percorsi e ricordati che `.env` viene letto da `/opt/lanterna/.env`):

```
0 4 * * *  cd /opt/lanterna && /usr/bin/npm run backup -w @lanterna/server >> /var/log/lanterna-backup.log 2>&1
```

launchd (macOS) `~/Library/LaunchAgents/it.lanterna.backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>it.lanterna.backup</string>
  <key>WorkingDirectory</key><string>/Users/TUO_UTENTE/lanterna</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/npm</string><string>run</string><string>backup</string><string>-w</string><string>@lanterna/server</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/Users/TUO_UTENTE/Library/Logs/lanterna-backup.log</string>
  <key>StandardErrorPath</key><string>/Users/TUO_UTENTE/Library/Logs/lanterna-backup.log</string>
</dict>
</plist>
```

**Ripristino** (il server va **fermato**):

```
sudo systemctl stop lanterna                  # oppure: launchctl unload ...
npm run restore -w @lanterna/server -- /var/backups/lanterna/lanterna-20260101-040000
sudo systemctl start lanterna
```

`restore` accetta una cartella di backup o un singolo `.db`, rifiuta file che non sono SQLite (intestazione, `PRAGMA integrity_check`, presenza delle tabelle di Lanterna) **prima** di toccare qualcosa, ricorda di fermare il server e chiede conferma (`--yes` per saltarla in uno script). I dati attuali non vengono cancellati: restano accanto con il suffisso `.prima-del-ripristino-<data>`; eliminali quando sei sicuro. Le partite in corso riprendono dallo stato salvato; i giocatori ricollegati vedono lo stato del backup.

Prova il ripristino **prima** di averne bisogno, su una copia (`DATABASE_URL=file:/tmp/prova.db UPLOAD_DIR=/tmp/prova-up npm run restore ...`).

### Esportazione di campagna e backup: quale usare

Sono due strumenti diversi.

| | Backup SQLite (`npm run backup` / `restore`) | Esportazione di campagna (schermata "Backup e importazione") |
|---|---|---|
| Cosa copia | **tutta** l'istanza: database (utenti compresi, password con hash, sessioni, tutte le campagne, contenuti) e `uploads/` | **una** campagna: stato, schede, contenuti e libreria della campagna, immagini usate, chat facoltativa |
| Account | sì (stessi utenti, stesse password) | **no**: solo nome e ruolo dei membri, mai email, password, sessioni o segreti |
| Ripristino | server **fermo**, sostituisce i dati attuali (che restano accanto, `.prima-del-ripristino-<data>`); nuova epoca, i client ricaricano | server **acceso**, crea una **nuova** campagna accanto alle altre (mai sovrascrive), l'admin associa i giocatori ai suoi utenti |
| Quando | disastro (disco rotto, errore grave), aggiornamenti rischiosi, copia notturna | spostare una campagna su un altro server, tenerne una copia portabile, duplicarla, archiviarla |
| Formato | cartella con `lanterna.db` + `uploads/` | `.zip` con JSON e immagini, manifesto versionato (docs/PROTOCOL.md) |

L'esportazione **non sostituisce** il backup: non contiene gli utenti né le altre campagne. Per il ripristino dopo un guasto usa sempre il backup SQLite; usa l'esportazione per portare una campagna altrove. Per ripristinare una campagna da un archivio: admin → menu utente → "Backup e importazione" → "Scegli un archivio…" → controlla l'anteprima → associa i giocatori → "Importa campagna". La campagna importata è nuova (non tocca quella da cui è stata esportata) e si apre da "Apri la campagna" (o da `#/?campaign=<id>`).

Limiti configurabili in `.env` (`ARCHIVE_MAX_BYTES`, `ARCHIVE_MAX_UNPACKED_BYTES`, `ARCHIVE_MAX_JSON_BYTES`, `ARCHIVE_MAX_ENTRIES`): valgono sui byte realmente letti. Se Cloudflare Tunnel o un proxy limita la dimensione del corpo delle richieste (il piano gratuito di Cloudflare accetta fino a 100 MB), gli archivi più grandi vanno importati da rete locale. Mentre si importa il server crea una cartella temporanea `.import-<uuid>` dentro `UPLOAD_DIR` (la rimuove da sola, anche all'avvio dopo un arresto brusco; `npm run backup` la ignora).

## 8. Contenuti di gioco

Non sono nel repo: importali con `npm run import-content -w @lanterna/server -- <file|cartella>` (formato in [`CONTENT.md`](CONTENT.md)).

## 9. Aggiornare Lanterna

```
cd /opt/lanterna
npm run backup -w @lanterna/server        # sempre prima
git pull
npm ci
npm run build
sudo systemctl restart lanterna           # le migrazioni si applicano da sole all'avvio
```

I giocatori connessi vengono disconnessi e si riconnettono da soli: farlo a fine sessione. Se qualcosa va storto: `git checkout <versione-precedente>`, `npm ci && npm run build`, e al bisogno `restore` del backup fatto prima (le migrazioni vanno solo avanti, quindi un database aggiornato non si usa con codice vecchio).

Controlla ogni tanto `npm audit --omit=dev`.

## 10. Checklist di sicurezza

- [ ] `.env` con permessi `600`, fuori da git; `BETTER_AUTH_SECRET` generato con `openssl rand -base64 32`, mai riusato.
- [ ] `NODE_ENV=production`, `BETTER_AUTH_URL` in `https`, `TRUSTED_ORIGINS` vuoto o solo origini tue.
- [ ] Il server ascolta solo su `127.0.0.1` (`HOST`); **nessuna porta aperta/inoltrata sul router**: si entra solo dal tunnel.
- [ ] `TRUST_PROXY=loopback` (mai `true`); verifica nei log che l'IP dei client non sia sempre quello del tunnel.
- [ ] Il file di credenziali del tunnel (`~/.cloudflared/<ID>.json`) è privato e non nel repo.
- [ ] Server con un utente dedicato non privilegiato; cartelle dati con permessi `700`.
- [ ] Password dell'admin lunga e unica; account dei giocatori creati solo dall'admin.
- [ ] Backup automatico attivo, copia anche fuori macchina, **ripristino provato**.
- [ ] Sistema operativo, Node e dipendenze aggiornati (`npm audit --omit=dev`).
- [ ] Facoltativo: Cloudflare Access davanti all'app; regole WAF/limiti di Cloudflare sul dominio.
- [ ] Nessun contenuto protetto da copyright nel repo: gli import restano nell'istanza.
