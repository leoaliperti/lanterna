# Combattimento e azioni sulla mappa (M7)

Logica condivisa (`packages/shared/src/state/combat*.ts`, `shapes.ts`, `protocol/ephemeral.ts`) e server. La UI del client non c'è ancora: l'elenco di cosa fare è in fondo.

## Iniziativa

- Un combattimento per scena (`state.combats`), `participants` nell'ordine dei turni. Partecipante = token della scena (nome letto dal token) o voce libera con nome. Flag per voce: `hidden` (i giocatori non sanno che esiste) e `hideInitiative` (si vede la voce, non il valore).
- Comandi (solo GM): `combat.add/update/remove/reorder/setInitiative/sort/start/next/previous/end/restore`. `add` inserisce per iniziativa decrescente (i senza valore in fondo). Il tiro è un messaggio a parte, `initiative.roll`: il server tira d20 + bonus (vantaggio/svantaggio) con `crypto.randomInt` e applica un solo `combat.setInitiative` annullabile.
- `start` porta a round 1 sul primo; `next` passa al successivo e al giro incrementa il round; `previous` torna indietro (non va prima del primo turno del round 1); `end` toglie il combattimento. Togliere chi è di turno (o cancellarne il token) passa il turno al successivo.
- `step`/`maxStep`: gli effetti scalano solo andando oltre il massimo raggiunto, così `previous` e di nuovo `next` non li scalano due volte. `previous` non ripristina gli effetti già scaduti (per questo c'è l'annulla del GM, che ripristina tutto).
- Visibilità giocatore: solo la scena attiva; niente voci nascoste né di token nascosti o sotto la nebbia; iniziative nascoste a `null`; se il turno è di una voce invisibile `turnId` è `null`. Il tracker si ricalcola anche quando cambiano nebbia, token o scena attiva (cambiamenti derivati in `reducer-util.ts`).

## Effetti temporanei

- Stanno nel token (`token.effects`, max 16): `{ id, name, condition|null, remaining|null, timing: start|end, turnOf|null, secret }` più `addedCondition` interno. `remaining` = quante volte deve ripetersi il momento `timing` del turno dell'ancora (`turnOf`, o il token stesso); un round = un turno dell'ancora. `null` = senza scadenza.
- Comandi (solo GM): `effect.add/update/remove`. La condizione dell'effetto viene aggiunta al token se manca e tolta alla scadenza solo se l'ha aggiunta l'effetto; con due effetti sulla stessa condizione resta finché ne resta uno. Alla fine del combattimento gli effetti con durata terminano (motivo `combatEnded`).
- Avvisi (non cambiano lo stato): `combat.turn`, `effect.expiring` (remaining arriva a 1, oppure inizia il turno dell'ancora e l'effetto scade a fine turno), `effect.expired`. Solo a GM e proprietario del token (se lo vede); gli effetti `secret` solo al GM. Non sono persistiti oltre il registro dei delta.
- Ai giocatori gli effetti arrivano in `token.effects` senza `secret`, `turnOf` né `addedCondition`; i segreti non arrivano.

## Gruppi e azioni di gruppo

- Gruppi salvati (`state.groups`, solo GM, mai inviati ai giocatori): `group.create/update/delete/restore`. `token.faction` (facoltativo, solo GM) serve alla selezione.
- Selezione (`TokenTarget`, risolta da `resolveTarget`, utilizzabile anche dal client): `tokens`, `group`, `category` (`tokenKind`, `faction`, `includeHidden`).
- `group.apply { target, action }`: azioni `damage`, `heal`, `tempHp`, `addCondition`, `removeCondition`, `addEffect`, `move` (offset in pixel, senza aggancio). È una macro di comandi ordinari, quindi atomica (tutti o nessuno) e annullabile in un colpo solo, con gli stessi permessi dei comandi singoli. Il giocatore può solo `move`/`addCondition`/`removeCondition` sui propri token (`tokens`); il resto è FORBIDDEN.
- Regole 5e (`rules5e/hp.ts`): danno prima sui PF temporanei; a 0 PF un PG diventa "Privo di sensi" (`unconscious`), un mostro o oggetto "Morto" (`dead`); morte istantanea se il resto supera i PF massimi; i morti non si curano né subiscono altro danno; PF temporanei non si sommano. I tiri salvezza contro la morte restano nella scheda, non nel token.
- `addEffect` di gruppo: l'id di ogni effetto è derivato (`derivedEffectId(base, tokenId)`), quindi ripetere l'azione non duplica e annulla/ripeti sono esatti.

## Forme effimere (misure, frecce, ping)

- Messaggi `ephemeral.show` / `ephemeral.clear` (client) ed `ephemeral.shown` / `ephemeral.cleared` (server). Mai salvati. `audience`: `private` (resta sul client: il server risponde `ack` e non invia nulla), `gm`, `all`. TTL predefinito 4 s (ping), 6 s (freccia), 10 s (misure), massimo 30 s; rimandare lo stesso `id` sostituisce la forma. Max 8 forme vive per utente; rate limit `EPHEMERAL_PER_SECOND`/`EPHEMERAL_BURST`.
- Il giocatore agisce solo sulla scena attiva (un'altra scena è NOT_FOUND come se non esistesse); i punti devono stare dentro la mappa.
- Nebbia: ogni destinatario riceve la forma ritagliata per la sua maschera (`shapeForViewer`). Tutte le celle rivelate: forma intera. Solo alcune: forma `cells` con le sole celle rivelate (nessuna coordinata o misura). Nessuna: nulla, nemmeno il messaggio. Il GM vede tutto. Una forma troppo grande da calcolare non va ai giocatori. `ephemeral.cleared` va solo a chi aveva ricevuto la forma.

## Geometria (`shapes.ts`)

- Asse y verso il basso; angoli in gradi da +x, orari sullo schermo (90 = giù).
- Una cella è coperta se il suo centro è dentro la forma (bordo incluso); la cella dell'origine è sempre inclusa.
- **Cono 5e: angolo totale 2·atan(1/2) = 53,13°** (la larghezza a una distanza d è d, come da regola del cono), lunghezza misurata radialmente; `angle` permette varianti (es. 90°).
- Cerchio: raggio; linea: striscia di `width` a estremi piatti; righello/freccia: celle attraversate (campionamento a mezza cella). Distanza del righello: `euclid`, `chebyshev` (diagonale = 1 cella), `alternating` (5-10-5).

## Da fare nel client

- Pannello iniziativa: partecipanti (aggiungi token selezionati/voce libera), tiro (`initiative.roll` con bonus e modo), riordino a trascinamento, flag nascosto/iniziativa nascosta, start/next/previous/end; evidenziare `turnId`; mostrare `round`.
- Gestire `combat.updated`, `group.*`, `token.updated` con `effects`, e gli avvisi `combat.turn`, `effect.expiring`, `effect.expired` in modo discreto (riga nel tracker, lampo sul token), mai un popup obbligato.
- Effetti sul token: icona/elenco con durata residua, editor (nome, condizione 5e, durata, momento, ancora, segreto).
- Gruppi: gestione (solo GM), selezione per categoria/fazione (usare `resolveTarget`), barra azioni rapide (danno, cura, PF temporanei, condizioni, effetto, sposta di un offset) con `group.apply`.
- Righello/cerchio/cono/linea: disegno locale; le misure private non si inviano; pubbliche con `ephemeral.show` (inviare di continuo durante il trascinamento con lo stesso `id`, poi `ephemeral.clear`); mostrare le forme `cells` come celle evidenziate sulla griglia della nebbia; scadere in locale dopo `ttlMs`.
- Frecce di intenzione e ping dei giocatori (a tutti o solo GM).
