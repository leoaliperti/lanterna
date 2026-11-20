# QA visiva del client

Prima verifica del client in un browser vero, non solo in jsdom. Il client era stato scritto senza poterlo vedere.

## Come è stata fatta

- Build di produzione (`npm run build`), server avviato con `NODE_ENV=production`, `ALLOW_INSECURE_HTTP=true`, database e upload in una cartella temporanea fuori dal repo. Admin creato con `npm run create-admin -w @lanterna/server` (variabili `LANTERNA_ADMIN_*`).
- Browser: Brave (Chromium 157) senza interfaccia, pilotato da puppeteer-core via CDP, con `--enable-gpu --use-angle=metal` (WebGL vero). Profili isolati per GM e giocatore.
- Viste: 1440x900 (desktop), 820x1180 (tablet), 390x844 (telefono, con touch emulato), in tema chiaro e scuro.
- Console e rete osservate in ogni passaggio: nessuna violazione CSP e nessuna richiesta fallita, a parte gli attesi 401 del login errato. Pixi (con `unsafe-eval` importato) e Three.js funzionano con la CSP restrittiva di produzione.

Percorsi coperti: login (errore e successo), tavolo vuoto e creazione della prima campagna, nuova scena con mappa PNG generata proceduralmente, griglia e snap, creazione di token (con proprietario e barra della vita), trascinamento con mouse e con touch, nascondi/rivela, chat, sussurro GM verso giocatore, tiri con animazione 3D, gestione utenti, giocatore in un secondo profilo, cambio tema, impostazioni e cambio password.

## Difetti trovati e corretti

| # | Gravità | Difetto | Correzione |
|---|---|---|---|
| 1 | Alta | In "Gestione utenti" il menu di una riga (cambio ruolo, reimposta password, elimina) era tagliato dalla lista (`overflow: hidden`): le ultime voci non erano raggiungibili. | Niente `overflow: hidden` sulla lista; gli angoli arrotondati si applicano alle righe. |
| 2 | Alta | Il GM non aveva modo di aggiungere un giocatore alla campagna dall'app: il giocatore creato restava "in attesa della mappa" per sempre (la rotta `/campaigns/:id/members` non aveva UI). | Voce "Aggiungi al tavolo" / "Togli dal tavolo" nel menu di ogni giocatore in Gestione utenti, con indicazione "non è al tavolo". |
| 3 | Alta | Rilasciando un token fuori dalla mappa (facile con il touch) il server rispondeva "Posizione fuori dalla mappa" e il token restava dov'era. | La posizione di rilascio (mouse, touch, frecce) viene riportata dentro la mappa: con lo snap di celle intere, senza snap sul bordo. |
| 4 | Media | Il modulo del token (e della scena) andava in overflow orizzontale quando compariva la barra della vita: interruttori e campi tagliati sul bordo destro. | Griglie con `minmax(0, 1fr)` nel form. |
| 5 | Media | I token nuovi comparivano tutti nella stessa cella al centro, uno sopra l'altro. | `spawnPoint` cerca la cella libera più vicina al centro. |
| 6 | Media | Menu a comparsa (menu utente) traslucidi: il contenuto sotto traspariva nitido, perché il `backdrop-filter` annidato nella barra non sfoca. | Popover e menu con fondo pieno. |
| 7 | Media | Il badge "Sei il GM" e la scala della mappa ("1 cella = 5 ft · 74%") si sovrapponevano in basso a sinistra. | Con la mappa visibile il badge sta in alto a sinistra, su una pillola. |
| 8 | Media | Voci dei menu nelle righe delle liste in grigio secondario (colore ereditato dalla riga). | `color: var(--label)` sulle voci. |
| 9 | Media | Didascalia dei dadi 3D ("d8 3 · d8 4") in nero su mappa scura, illeggibile. Dadi piccoli. | Pillola con fondo pieno; area dei dadi più ampia (26 rem x 15 rem). |
| 10 | Media | Messaggio d'errore del login (banner rosso senza titolo) in grigio secondario: contrasto basso, soprattutto in scuro. | Un banner senza titolo usa il testo pieno. |
| 11 | Media | Non c'era modo di scegliere il tema chiaro/scuro (solo sistema). | Impostazioni: Auto / Chiaro / Scuro, salvato in locale. La mappa Pixi segue già `data-theme`. |
| 12 | Bassa | Testi con apostrofo al posto dell'accento ("e'", "puo'", "piu'", "gia'", "Unita'", "Opacita'"). | Accenti corretti nei testi visibili (non nei commenti). |
| 13 | Bassa | Stato vuoto sulla mappa a puntini: testo mescolato ai puntini. Onboarding "prima campagna" senza supporto. | Stato vuoto e onboarding su una scheda piena con raggio e ombra del design system. |
| 14 | Bassa | `/favicon.ico` rispondeva 404 (errore in console a ogni caricamento). | `public/favicon.svg` (disegno proprio) collegato in `index.html`. |
| 15 | Bassa | Selettore del colore della griglia a tutta larghezza (una barra nera). | Selettore compatto. |
| 16 | Bassa | Titolo della pagina Utenti allineato a sinistra dello schermo, contenuti in colonna centrale. Titolo lungo della campagna tagliato senza ellissi. | Barra e titolo allineati alla colonna; ellissi sul titolo. |
| 17 | Bassa | `/w Giulia testo` falliva se il nome visualizzato era "Giulia Rossi". | Il solo nome di battesimo vale se identifica un destinatario soltanto. |
| 18 | Bassa | Segnaposto del messaggio e della formula troncati nel pannello. | Segnaposto più brevi. |
| 19 | Bassa | Menu delle azioni con voci a capo ("Reimposta password"). | Larghezza minima 15 rem. |

Test aggiunti: `tokenDraft.test.ts` (spawn senza sovrapposizioni), `geometry.test.ts` (rilascio dentro la mappa), `chatLogic.test.ts` (/w con nome di battesimo), `settings.test.ts` (tema), `App.test.tsx` (aggiunta/rimozione dal tavolo).

## Difetti rimasti

| Gravità | Cosa |
|---|---|
| Media | Le schede personaggio (`src/sheets`, altro agente) hanno ancora apostrofi ASCII nei testi ("e'", "piu'", "non si puo' annullare"). Da correggere a merge avvenuto. |
| Bassa | Dadi 3D ancora piccoli (circa 55 px per un d20) rispetto all'area; la scala dipende dalla camera in `dice3d/scene.ts`. |
| Bassa | Su tablet in verticale (sotto 56 rem) il pannello è uno sheet che copre la mappa: non si può leggere la chat guardando la mappa. Scelta di design da rivalutare. |
| Bassa | All'apertura di uno sheet il focus va sul pulsante "Fine": con interazione da tastiera mostra l'anello di focus (corretto), meglio sul primo campo. |
| Bassa | Il tipo predefinito di un nuovo token è "Mostro" (di solito si parte dai personaggi). |
| Bassa | Il limite di connessioni WebSocket per utente (429) si raggiunge con molte schede aperte; il client riprova in silenzio senza dire il motivo. |
| Info | (risolto in M10) il titolo della campagna è ora un menu per cambiare campagna. |

## Non verificato

- Dispositivi reali (iPhone/iPad/Android), tocco vero, pinch-to-zoom, tastiera virtuale, safe area (notch), 100dvh.
- Safari e Firefox: solo Chromium. In particolare `backdrop-filter`, `light-dark()`, `corner-shape` e WebGL su Safari.
- Prestazioni su GPU modeste o rendering software; fluidità delle animazioni misurata solo a occhio (nessuno scatto evidente).
- Mappe molto grandi (tessere) e molti token.
- Lettori di schermo; contrasto misurato a occhio, non con uno strumento.
- Dietro Cloudflare Tunnel in HTTPS (la prova è su `http://localhost` con `ALLOW_INSECURE_HTTP=true`).

## Combattimento (M7, client)

Verificato in Brave headless via CDP (build di produzione, DB temporaneo, GM e giocatore in profili separati; 1440x900, 820x1180 e 390x844 con touch emulato): tracker, selezione per categoria, danno di gruppo con scorciatoia `D` e "Annulla" dalla notifica, menu contestuale (tasto destro), cono 5e privato, cerchio pubblico ritagliato per la nebbia del giocatore, ping al solo GM, avviso di turno al proprietario.

Difetti trovati e corretti: sette schede nel pannello laterale uscivano dallo schermo (ora `Tabs` compatte con sole icone); il menu contestuale si richiudeva subito nel browser vero (il listener "clic fuori" scattava sullo stesso `pointerdown` che lo apriva: test di regressione in `ui/pointMenu.test.tsx`); gli sheet dell'azione mettevano il focus su "Fine" (ora `Sheet initialFocus`); tracker troppo lungo (aggiunta e tiro in sezioni a comparsa); strumenti di misura coperti dalla scala sul telefono.

Non verificato: dispositivi reali, pressione lunga con dito vero, Safari/Firefox, lettori di schermo, movimento ridotto a occhio (solo nel codice), dissolvenza delle forme in scadenza e mappe con immagine (la prova usava una scena senza mappa).
