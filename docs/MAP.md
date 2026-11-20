# Canvas della mappa

Il canvas vive in `packages/client/src/map` ed e' costruito con PixiJS (MIT, versione fissata). E' un componente React **controllato dalle props**: non usa la rete e non modifica mai i dati. L'adattatore allo stato condiviso (WebSocket) e' a parte: `packages/client/src/table/adapter.ts` (`toMapScene`), vedi "Client in tempo reale" in `docs/PROTOCOL.md`.

Pagina di prova (solo sviluppo): `npm run dev`, poi `http://localhost:5173/#/map`. Con `#/map?bench` parte un test di carico (300 token, pan e zoom continui); `&big` usa la mappa 8000x6000. La mappa e i token sono generati proceduralmente.

## Uso

```tsx
import { MapCanvas } from "./map";

<MapCanvas
  background={{ url, width: 4000, height: 3000 }}
  grid={{ cellSize: 70, color: "#ffffff", opacity: 0.35, offsetX: 0, offsetY: 0, snap: true }}
  scale={{ unitsPerCell: 5, unitLabel: "piedi" }}
  tokens={tokens}                 // {id, x, y (centro, px mappa), size (celle), rotation, imageUrl/color/label, kind, hidden, conditions, health?}
  role="player"                   // "gm" | "player"
  movableTokenIds={["pg-1"]}
  onMoveToken={(id, x, y) => ...} // al rilascio, gia' agganciato alla cella se snap
  onResizeToken={(id, size) => ...}   // solo GM
  onRotateToken={(id, deg) => ...}    // solo GM
  onSelectionChange={(ids) => ...}
  onViewportChange={(vp) => ...}
/>
```

"Il server decide": durante il trascinamento il canvas mostra un'anteprima (con la cella di destinazione evidenziata); al rilascio chiama la callback e l'anteprima sparisce. Se il padre non aggiorna le props, il token torna alla posizione di prima con una breve transizione (istantanea con `prefers-reduced-motion`). `health` si disegna solo se il padre la passa. I token `hidden` si vedono (semitrasparenti, con icona) solo con `role="gm"`; **la vera protezione e' il filtro sul server**, qui e' solo presentazione.

## Interazioni

| Azione | Mouse / tastiera | Touch |
|---|---|---|
| Zoom centrato sul cursore | rotella (Ctrl+rotella piu' veloce), `+` `-`, `0` adatta | pinch |
| Pan | tasto centrale, Spazio + trascino, frecce (se nessun token selezionato) | due dita; un dito sul vuoto |
| Sposta token | trascino (soglia 4 px; snap con anteprima cella) / frecce = una cella | trascino (soglia 8 px) |
| Selezione | clic; Shift/Ctrl/Cmd aggiunge o toglie; rettangolo sul vuoto | tocco |
| Righello (locale, privato) | `R` o pulsante; trascino; `Esc` esce | pulsante |
| Ruota / ridimensiona (GM, un token) | maniglie, oppure `[` `]` (Shift = 45 gradi) | maniglie |

Rotazione a passi di 15 gradi (Alt = libera), dimensione a mezze celle (0.5 - 12). Il righello misura in unita' di gioco (`rulerMode`: `euclidean` oppure `grid`, dove la diagonale vale una cella come in 5e), si aggancia ai centri cella se lo snap e' attivo e annuncia il valore agli screen reader.

## Architettura

| File | Ruolo |
|---|---|
| `geometry.ts` | logica pura: viewport, snap, hit test, rettangolo di selezione, culling, distanze, rotazione |
| `tiles.ts` | logica pura: piano per mappe grandi |
| `color.ts` | conversione dei colori CSS (anche `color(srgb ...)` di `getComputedStyle`) |
| `controller.ts` | macchina a stati delle interazioni, senza DOM ne' Pixi (testata con Vitest) |
| `input.ts` | collega gli eventi DOM del canvas al controller |
| `renderer.ts` | resa PixiJS, caricata con `import()` dinamico |
| `theme.ts` | legge i token CSS del design system e li converte per Pixi (segue chiaro/scuro e `data-theme`) |
| `MapCanvas.tsx` | componente React, controlli di zoom/righello con il design system, fallback senza WebGL |

Resa: la scena si aggiorna **per differenza** (token creati, aggiornati e distrutti per id; ricostruiti solo se cambiano i loro dati, non a ogni render React). Si disegna solo quando qualcosa cambia (niente ticker continuo). La griglia e' **un solo `Graphics`** con tutte le linee in un percorso (`pixelLine`, 1 px a ogni zoom), ridisegnato solo se cambia la griglia; sotto le 6 px per cella si nasconde. I token fuori schermo hanno `visible = false` (culling). Le texture delle immagini dei token sono condivise per URL con conteggio dei riferimenti. Etichette, barre e badge hanno dimensione costante in pixel schermo. Il mondo e' un render group (le trasformazioni non toccano i figli). Risoluzione = `devicePixelRatio` (massimo 3); `ResizeObserver` sul contenitore. Allo smontaggio: listener, observer, texture, sprite e applicazione Pixi vengono liberati; un canvas nuovo a ogni montaggio evita il contesto WebGL perso del doppio montaggio di StrictMode.

Senza WebGL (o con contesto perso) il componente mostra un avviso del design system e l'elenco testuale dei token.

## Mappe grandi (es. 8000x6000)

Una mappa 8000x6000 decodificata sono 192 MB di RGBA (circa 256 MB con mipmap): troppo per una sola texture su molte GPU, e alcune (soprattutto mobili) hanno `MAX_TEXTURE_SIZE` di 4096. Strategia (`tiles.ts`, `planBackground`):

1. **Mappa piccola** (lati <= `MAX_TEXTURE_SIZE` e area <= 4096x4096): una sola texture con mipmap.
2. **Mappa grande**: una **panoramica** ridotta (lato massimo 2048, mipmap, sempre presente) e **tessere** da 2048 px ritagliate dall'immagine originale e create **solo se visibili e solo se lo zoom supera la risoluzione della panoramica**. Al massimo 2 tessere nuove per frame (niente blocchi), al massimo 16 in memoria (le meno recenti e non visibili sono rilasciate), tutte rilasciate quando si torna a zoom basso.

Le tessere si ritagliano dall'`HTMLImageElement` (il browser tiene la decodifica). Limiti noti: l'immagine originale resta in memoria finche' la mappa e' aperta; non c'e' ancora una piramide di livelli intermedi (tra panoramica e pieno dettaglio si passa direttamente alle tessere); per mappe oltre ~16000 px conviene generare le tessere sul server in fase di upload (da valutare in M2). Il server dovrebbe inoltre rifiutare o ridimensionare upload enormi.

## Prestazioni e come misurarle

- `npm run bench:map -w @lanterna/client`: tempo CPU per frame della logica con 300 token e griglia attiva (nessun browser).
- `http://localhost:5173/#/map?bench` (e `&big`): pan e zoom continui per 6 s nel browser reale, con fps, p95 dei frame e tempo CPU di `renderer.frame()`. Il risultato e' nell'elemento `#bench-result` (e in `window.__mapBench`).

I fps dipendono dalla GPU del dispositivo: le misure vanno ripetute sull'hardware di destinazione (telefono compreso).
