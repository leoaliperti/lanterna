# Combattimento e azioni sulla mappa (M7)

Logica condivisa (`packages/shared/src/state/combat*.ts`, `shapes.ts`, `protocol/ephemeral.ts`), server e UI del client (sezione "Client" in fondo).

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

## Client

Codice in `packages/client/src/combat/` (tracker, azioni, bersagli, effetti, avvisi, forme effimere) e `src/map/` (strumenti di misura, disegno, menu contestuale). Il client non decide nulla: invia comandi (`combat.*`, `effect.*`, `group.*`, `group.apply`, `initiative.roll`, `ephemeral.*`) e mostra solo quello che il server rimanda.

- **Tracker** (scheda "Iniziativa", `InitiativePanel`): round e turno corrente (riga evidenziata con `aria-current`, anello arancione sul token nella mappa). GM: avvia/avanti/indietro/termina (con conferma), ordina, aggiunta dei token selezionati o scelti da un menu, voce libera (anche nascosta fin dalla creazione), tiro (`initiative.roll`: il client manda solo bonus e modo, il d20 lo tira il server) per chi manca, per tutti o per una riga, valore a mano, riordino a trascinamento o con le frecce su/giù sulla maniglia, nascondi voce o valore, togli. Giocatori: sola lettura, solo cio' che arriva.
- **Effetti**: elenco con durata residua nell'editor del token (`EffectList`), aggiunta da `ActionSheet` (nome, condizione 5e, durata in round, inizio/fine turno, ancora, segreto) dal token o dall'azione di gruppo, rimozione con `effect.remove`. Sulla mappa un badge col numero di effetti.
- **Avvisi** (`combat.turn`, `effect.expiring/expired`): `RealtimeClient` li emette come evento `alert` dai delta; `useCombatFeed` li deduplica per round (`AlertDeduper`, anche dopo la riconnessione), mostra un toast breve e un richiamo sul token (anello che si espande; fermo con movimento ridotto). Mai popup bloccanti.
- **Selezione e azioni**: selezione multipla sulla mappa, per categoria (tutti/PG/mostri/oggetti, fazione) e per gruppo salvato (CRUD, richiamo con un clic) dalla scheda "Bersagli", con elenco e ricerca. Azioni (danno, cura, PF temporanei, condizione, effetto, sposta) da barra, menu contestuale (tasto destro o pressione lunga di 500 ms) e tastiera con il focus sulla mappa: `D` `H` `K` `E` `M`. Ogni azione e' un solo `group.apply` (atomico), con notifica e "Annulla". `faction` si imposta nell'editor del token.
- **Misure e segnalazioni**: pannello "Misure e segnalazioni" sulla mappa: righello `R`, cerchio `O`, cono `C`, linea `L`, freccia `F`, segnalazione `P`, con la scelta di chi la vede. **Privata** (default, "Solo io"): resta sul client, il server non riceve nulla. **Pubblica** ("Tutti", e per i giocatori "Solo GM"): `ephemeral.show` con lo stesso `id` durante il trascinamento (max ~8 al secondo) e al rilascio con `ttlMs` predefinito; `ephemeral.clear` se si annulla. L'autore non riceve la propria forma dal server: la tiene localmente con la stessa scadenza. Le forme ricevute si disegnano cosi' come arrivano (`cells` = celle evidenziate sulla griglia della nebbia, nessuna ricostruzione), scadono in locale con `ttlMs` e si dissolvono negli ultimi 700 ms (senza dissolvenza con movimento ridotto). Cono 5e: 53,13 gradi (`CONE_ANGLE_DEG`, il client non manda `angle`); la linea e' larga una cella.
- **Test**: `combat/*.test.ts(x)` (logica pura, UI sul tavolo con server finto, feed delle misure), `map/measure.test.ts`, `map/controllerCombat.test.ts`, `realtime/combatEvents.test.ts` e l'e2e su server reale `e2e/combat.e2e.test.ts` (GM + 2 giocatori con nebbia: voci nascoste assenti dal traffico, tiro del server, avvisi ai diretti interessati, azione di gruppo e annulla, effetti e gruppi segreti, forma ritagliata per la nebbia, misura privata che non parte).

Limiti noti: i gruppi non si aggiornano da soli se un token cambia scena; il righello e' a due punti (niente poligonale); gli effetti si possono solo togliere e aggiungere dall'interfaccia (`effect.update` non ha ancora un modulo); la scelta "Chi vede la misura" non si ricorda tra le sessioni.
