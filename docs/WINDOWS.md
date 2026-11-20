# Finestre multiple e vista giocatore (M9)

Stato: server e client completi.

Decisione: **solo WebSocket, nessun `BroadcastChannel`**. Ogni finestra è un normale client WebSocket autenticato (stesso cookie di sessione nello stesso browser, oppure login su un altro PC). Il server è l'unica fonte di verità: le finestre non si parlano mai fra loro, si sincronizzano perché ricevono gli stessi delta.

## Viste e URL stabili

Router a hash (`packages/client/src/windows/routes.ts`):

| URL | Vista | Chi |
|---|---|---|
| `#/` o `#/table` | tavolo completo | tutti |
| `#/view/map` | solo la mappa (scena attiva; il GM ha anche gli strumenti di nebbia e muri) | tutti |
| `#/view/notes` | schede e statblock | tutti (il server filtra) |
| `#/view/chat` | chat e dadi | tutti |
| `#/view/combat` | tracker del combattimento (il GM ha "Indietro"/"Turno successivo") | tutti (il server filtra) |
| `#/view/scene/<id>` | una scena precisa, anche non attiva, senza cambiare quella dei giocatori | solo GM |
| `#/view/player/<userId>` | **vista giocatore**: la mappa come la riceve quel membro, in sola lettura | solo GM |

Un id non valido o una vista sconosciuta riporta al tavolo; un giocatore che apre una vista solo-GM torna al tavolo (e il server rifiuterebbe comunque: vedi sotto).

**Aprire le finestre.** Nella barra del tavolo il pulsante "Apri in nuova finestra" (icona finestra) elenca Mappa, Schede e note, Chat, Combattimento e, per il GM, ogni scena e "Vista di <giocatore>". In cima al pannello laterale un pulsante apre in una finestra a parte la scheda visibile (Chat, Schede, Scena). `window.open` usa un nome per vista (`lanterna-view-…`): la stessa vista riporta in primo piano la finestra già aperta. Se il browser blocca il popup compare un avviso non bloccante.

**Disposizione preferita.** Ogni finestra secondaria salva posizione e dimensioni (per tipo di vista) in `localStorage`, chiave `lanterna.windows.v1`, al ridimensionamento e alla chiusura; alla riapertura `window.open` le riusa (anche su un secondo schermo), altrimenti usa dimensioni di default centrate. Ogni accesso allo storage è in `try/catch`: senza storage si usano i default. Nessun dato di gioco passa da lì.

**Layout.** Le viste secondarie non hanno la barra del tavolo: solo una pillola in alto a destra con il nome della vista e lo stato della connessione, che dopo 3 s senza attività si attenua (proiettori, schermi esterni) e torna al primo movimento o al focus. Gli avvisi di connessione compaiono in basso. Componenti e token del design system, animazioni solo di `opacity`/`transform`, movimento ridotto rispettato.

**Connessione per finestra.** Ogni finestra ha il suo `RealtimeProvider`/`RealtimeClient`: riconnessione con backoff, indicatore di stato e banner sono indipendenti. Chiudere una finestra chiude solo la sua connessione.

**Scheda → token.** La sincronizzazione PF/condizioni dalla scheda al token (`planTokenSync`) gira solo nella finestra del tavolo (`SheetsProvider syncTokens={false}` nelle altre), così più finestre dello stesso GM non inviano comandi doppi.

## Vista giocatore: generata dal server

La vista giocatore **non** si ricostruisce nel client filtrando lo stato del GM. La finestra apre una connessione "come utente X":

```
ws(s)://<host>/api/ws?viewAs=<userId>
```

- **Prima dell'handshake**: `viewAs` deve essere un id valido (altrimenti 400). Se `viewAs` è diverso dall'utente della sessione e l'utente non è admin (GM) → **403**. `viewAs` di se stessi è ammesso.
- **All'`hello`** (`viewerActor` in `realtime/hub.ts`): chi guarda deve essere GM **di quella campagna** e X un suo membro; altrimenti `error FORBIDDEN "vista non consentita"` (messaggio fisso, non dice se X esiste) e chiusura **4403**. Il client della vista tratta 4403 come definitivo (`stopOnForbidden`) invece di riconnettersi in loop.
- L'attore della connessione è quello di X: snapshot, delta (`deltaFor`), cronologia della chat, chat e tiri in diretta (`canSeeEntry`), forme effimere ritagliate per la nebbia (`shapeForViewer`), tracker del combattimento: **esattamente i byte che riceve X** (test che confronta il traffico frame per frame).
- **Sola lettura**: con `viewAs` (sempre) o con `?readOnly=1` (qualsiasi utente, per esempio un PC collegato al proiettore) ogni richiesta che cambierebbe qualcosa riceve `FORBIDDEN "connessione in sola lettura"` prima di guardare lo stato: comandi, annulla/ripeti, `chat.send`, `roll.request`, `initiative.roll`, `ephemeral.show/clear`. Ammessi solo `hello`, `ping` e `history.request`. Niente viene mai inviato "come" X.
- **Membri e ruoli**: se X esce dalla campagna o cambia ruolo, o chi guarda smette di essere GM, `refreshMembers` chiude la connessione (4403).
- **Tessere della mappa** con la stessa identità: `GET /campaigns/:id/scenes/:sceneId/tiles/:col/:row?viewAs=<userId>`. Solo il GM della campagna; un giocatore che chiede le tessere di un altro riceve **403**, verso se stesso è come senza parametro; un `viewAs` non valido o non membro dà il solito 404. Il client aggiunge `&viewAs=` agli URL delle tessere (`toMapFog(..., { tilesAs })`), quindi riceve le stesse tessere mascherate (stesso ETag) di X.
- **Banner** non invasivo in alto al centro: "Stai guardando come <nome> · Sola lettura". Nessuno strumento, nessun trascinamento, nessun annulla da tastiera.

### Cosa vede in più il GM (e perché non è una fuga)

La vista di X mostra al GM solo ciò che X già riceve. L'unico dato che il GM non vedrebbe altrimenti sono i whisper fra X e un **altro** GM: gli admin però hanno già il log completo (`GET /campaigns/:id/log`, scope `full`), quindi non si apre nulla di nuovo.

## Proiettore

Per uno schermo condiviso coi giocatori il GM apre "Vista di <giocatore>" (sola lettura, nebbia di quel giocatore). Per la nebbia "di tutti" si può creare un account giocatore dedicato (es. "Proiettore") senza maschera personale e senza token: la sua vista è la maschera `everyone`. In alternativa il PC del proiettore accede con quell'account e apre `#/view/map`; il percorso `/ws?readOnly=1` è disponibile per chi vuole una connessione che non possa inviare nulla.

## Test

- Server: `packages/server/src/realtime/viewas.test.ts` (WebSocket e HTTP reali): stessi frame di A per la vista come A (snapshot, delta, whisper, tiri segreti, effimeri), nessun segreto del GM o di B nel traffico, cronologia identica, tutte le richieste di scrittura FORBIDDEN, giocatore con `viewAs` di un altro = 403, `viewAs` non membro = FORBIDDEN + 4403, A rimosso = 4403, tessere identiche byte per byte a quelle di A, 403/404 sulle tessere, token mosso in una finestra visto nelle altre.
- Client: `src/windows/windowsLogic.test.ts` (route, disposizione, menu), `src/windows/windows.test.tsx` (vista giocatore in sola lettura, scena precisa, `window.open`, popup bloccato, tracker), `RealtimeClient.test.ts` (4403 definitivo, `wsUrl`).
- e2e: `packages/client/e2e/windows.e2e.test.ts` (veri `RealtimeClient` contro il vero server: tre finestre sincronizzate, vista giocatore identica a quella del giocatore, scritture rifiutate, tessere con `?viewAs`).
- Verifica manuale con Brave headless via CDP (due profili, GM e giocatore, DB temporaneo fuori dal repo): menu delle finestre, vista giocatore identica alla schermata del giocatore, WebSocket `?viewAs=`, tessere con `&viewAs=`, spostamento di un token visto da tutte le finestre, comando dalla vista rifiutato.

## Limiti noti

- Il browser decide se onorare posizione e dimensioni di `window.open` (alcuni le ignorano o aprono una scheda); i popup bloccati vanno consentiti per il sito.
- Più finestre aprono più connessioni (massimo 16 per utente, `MAX_CONNECTIONS_PER_USER`).
- Le viste aprono la stessa campagna della finestra di partenza (`?campaign=<id>` nell'hash, come il tavolo dal M10); senza parametro, la prima campagna dell'utente.
- Un giocatore che forza `#/view/player/<altro>` torna al tavolo; se forzasse la connessione a mano riceverebbe 403 (il browser lo vede come una caduta e riprova con backoff).
- La finestra `#/view/combat` è un tracker grande e leggibile (adatto al proiettore) del combattimento della scena attiva (o il primo), con solo avanti/indietro per il GM; la gestione completa dell'iniziativa resta nel pannello "Iniziativa" del tavolo (UI del M7), che ha anche il pulsante "Apri in nuova finestra".
