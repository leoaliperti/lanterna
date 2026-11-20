# Importazione dei contenuti di gioco

Nel repository **non c'è nessun contenuto di gioco** (mostri, regole, testi di manuali): si importano nella propria istanza, dai propri file. Lanterna fornisce solo lo strumento e il formato. I file da importare vanno tenuti fuori dal repo: `content/` e `imports/` sono già in `.gitignore`.

## Formato

Un file JSON con un elenco di documenti (oppure direttamente un array di documenti):

```json
{
  "format": "lanterna-content",
  "version": 1,
  "source": "Raccolta di esempio",
  "items": [
    { "kind": "item", "name": "Lanterna di prova", "data": { "weight": 1, "text": "Un oggetto inventato per questo esempio." } },
    { "kind": "monster", "name": "Gufo di nebbia (esempio)", "data": { "hp": 7, "ac": 11, "text": "Creatura fittizia." } },
    { "kind": "spell", "name": "Scintilla di esempio", "data": { "level": 0, "text": "Incantesimo fittizio." } }
  ]
}
```

(Tutti i nomi e i testi sopra sono inventati per la documentazione.)

| Campo | Obbligatorio | Note |
|---|---|---|
| `items` | sì | da 1 a 5000 documenti per file |
| `items[].kind` | sì | `monster`, `item`, `spell`, `class`, `species`, `note`, `altro` |
| `items[].name` | sì | testo semplice, 1-200 caratteri |
| `items[].data` | sì | oggetto JSON libero: la struttura dipende da cosa vuoi mostrare |
| `items[].source` | no | sovrascrive la `source` del file per quel documento |
| `source` | no | etichetta dell'origine (es. il nome della tua raccolta); se manca vale il nome del file |
| `campaignId` | no | se presente, i documenti sono visibili solo ai membri di quella campagna (deve esistere) |
| `format`, `version` | no | `"lanterna-content"` e `1`; riservati a evoluzioni future |

Campi sconosciuti vengono **rifiutati** (errore, non ignorati).

## Limiti e sicurezza

- File (e corpo della richiesta REST): al massimo `CONTENT_MAX_BYTES` (default 5 MiB). Documento: `data` fino a 64 KiB, annidamento massimo 12 livelli, stringhe fino a 20 000 caratteri.
- **Nessun HTML**: qualsiasi stringa (anche nei nomi e nelle chiavi) che contenga un tag (`<b>`, `</div>`, `<!--`...) o un URL `javascript:` / `data:text/html` fa rifiutare l'intero file. Le disuguaglianze come `CA < 10` vanno bene. Il contenuto è testo: il client lo mostra come testo, mai come HTML.
- Le chiavi `__proto__`, `constructor`, `prototype` sono vietate.
- L'importazione è **tutto o niente** per file e **idempotente**: lo stesso (tipo, nome senza distinguere maiuscole, `source`, campagna) viene aggiornato, non duplicato.

## Visibilità

- L'admin/GM legge tutto.
- Il giocatore legge solo i tipi in `CONTENT_PLAYER_KINDS` (default `item,spell`; ammessi: `item`, `spell`, `class`, `species`, `altro`). **`monster` e `note` sono sempre riservati al GM**, anche se messi in quella variabile. I documenti legati a una campagna li vedono solo i membri.
- Ciò che un giocatore non può vedere risponde 404 (come se non esistesse), non 403.

## Come importare

Da riga di comando (dopo `npm run build`; usa il database di `DATABASE_URL`, anche a server acceso):

```
npm run import-content -w @lanterna/server -- percorso/file.json
npm run import-content -w @lanterna/server -- percorso/cartella     # tutti i .json, ricorsivo
```

Si valida tutto prima di scrivere: se un file non è valido non viene importato nulla.

Da REST (solo admin, con la sessione e l'header `Origin` come per ogni POST; in produzione sotto `/api`):

| Richiesta | Chi | Risposta |
|---|---|---|
| `POST /content/import` (corpo = il file JSON) | admin | `{ created, updated, total }`; 400 con `issues` se non valido; 404 se la campagna non esiste; 413 se troppo grande |
| `GET /content?kind=&q=&campaignId=&limit=&offset=` | autenticato (filtrato per ruolo) | `{ items: [{ id, kind, name, source, campaignId }], total }`; `q` cerca (senza distinguere maiuscole) in nome e dati; `limit` max 200 |
| `GET /content/:id` | autenticato (filtrato per ruolo) | il documento con `data` |
| `DELETE /content/:id` | admin | 204 |

I dati stanno nella tabella `content` (migrazione `0003_content`) e sono inclusi nel backup del database (`npm run backup -w @lanterna/server`).
