# Design system di Lanterna

Guida per chi costruisce le schermate del client. Il design system vive in `packages/client/src/ui` (componenti) e `packages/client/src/styles` (token e stili base). Lo stile segue le Human Interface Guidelines di Apple (iOS): chiaro, concentrato sul contenuto, movimento sobrio. Non usa SF Symbols, non include font Apple.

Vedere tutto dal vivo: `npm run dev`, poi `http://localhost:5173/#/ui` (solo in sviluppo; il selettore in alto passa da Auto a Chiaro, Scuro e "Affianca"). Non entra nel bundle di produzione.

## Come si usa

```tsx
import { Button, List, ListRow, NavigationBar, Sheet } from "./ui";
```

`ui/index.ts` importa anche i CSS. `main.tsx` carica `styles/tokens.css` e `styles/base.css`. Le schermate si compongono solo con questi componenti e con le variabili CSS: niente colori, px o durate scritti a mano.

## Regole (leggere prima di scrivere UI)

1. **Colori solo da token.** Mai `#fff` o `rgb()` nei componenti di schermata. Usa i token semantici (`--label`, `--bg-grouped-secondary`, `--tint`...). Chiaro e scuro funzionano da soli perche' i token usano `light-dark()`.
2. **Testo sul tint:** per testo e icone su sfondo neutro usa `--tint-text` (AA), non `--tint`. `--tint` va bene per riempimenti, indicatori, focus.
3. **Tipografia in rem**, con le classi `.t-large-title` ... `.t-caption2` o le variabili `--text-*`. Mai px per i font: il testo deve seguire le impostazioni dell'utente. Gli input restano >= 16px (altrimenti iOS fa zoom).
4. **Spaziatura** solo dalla scala `--space-*` (multipli di 4px). **Raggi** da `--radius-*`; contenitori grandi tondi, controlli piccoli meno.
5. **Target minimo 44x44 px** (`--hit-min`). Un controllo visivamente piu' piccolo estende l'area con un pseudo-elemento. Non ridurre mai l'area di tocco.
6. **Safe area:** barre e sheet usano `--safe-top/right/bottom/left`. Il contenuto a tutto schermo deve rispettarle. `index.html` dichiara `viewport-fit=cover`, quindi senza safe area il contenuto finirebbe sotto notch e home indicator.
7. **Focus visibile da tastiera:** `:focus-visible` ha un anello di 3px (`--focus-ring`). Non rimuovere `outline`. Ogni componente interattivo deve essere raggiungibile e usabile da tastiera.
8. **ARIA:** i componenti gia' impostano ruoli e nomi. Quando li usi: le `IconButton` richiedono sempre `label`; `SegmentedControl`, `Slider`, `Tabs`, `Toolbar`, `Sidebar` richiedono `aria-label`; non annidare controlli interattivi dentro un `ListRow` con `onPress`.
9. **Hover solo con puntatore fine:** `@media (hover: hover) and (pointer: fine)`. Su touch lo stato `:active` da' il feedback (alla pressione, non al rilascio).
10. **Materiali:** `Material`/`.l-material--ultrathin|regular|thick` danno traslucenza con fallback opaco (nessun `backdrop-filter` -> colore pieno). Mai impilare due materiali chiari. Piu' grande la superficie, piu' spessa: barre `regular`, sidebar e toast `thick`.
11. **Pattern iOS da preferire:** liste "inset grouped" (`List`/`ListRow`) per impostazioni ed elenchi; `Sheet` per compiti secondari (dal basso su telefono, centrato su schermi larghi); `Alert` solo per conferme distruttive o irreversibili; `Toast`/`Banner` per stato non bloccante; azioni distruttive sempre in rosso e mai l'azione di default.

## Token

| Famiglia | Variabili | Note |
|---|---|---|
| Etichette | `--label`, `--label-secondary`, `--label-tertiary`, `--label-quaternary` | secondary/tertiary leggermente piu' scure dei valori Apple per rispettare il contrasto AA |
| Sfondi | `--bg`, `--bg-secondary`, `--bg-tertiary`, `--bg-grouped`, `--bg-grouped-secondary`, `--bg-grouped-tertiary` | le liste raggruppate stanno su `--bg-grouped` con righe `--bg-grouped-secondary` |
| Riempimenti | `--fill`, `--fill-secondary`, `--fill-tertiary`, `--fill-quaternary` | campi, segmented, bottoni grigi |
| Separatori | `--separator`, `--separator-opaque`, `--hairline` | bordi da 0.5px |
| Accento | `--tint`, `--tint-text`, `--tint-solid`, `--tint-bg`, `--on-tint` | `--tint-solid` e' il riempimento dei bottoni con testo bianco (4.5:1) |
| Sistema | `--red`, `--green`, `--orange`, `--yellow`, `--teal`, `--indigo`, `--purple`, `--pink`, `--gray` | usabili come testo; per riempimenti `--red-solid`, `--green-fill`, `--orange-fill` |
| Materiali | `--material-ultrathin/regular/thick/opaque`, `--blur-*`, `--scrim` | |
| Ombre | `--shadow-sm/md/lg/sheet` | morbide, piu' scure in tema scuro |
| Tipografia | `--text-large-title` (34), `--text-title1` (28), `--text-title2` (22), `--text-title3` (20), `--text-headline` (17), `--text-body` (17), `--text-callout` (16), `--text-subhead` (15), `--text-footnote` (13), `--text-caption1` (12), `--text-caption2` (11) | stack `--font-sans`: `-apple-system, BlinkMacSystemFont, "SF Pro", system-ui` |
| Spazio | `--space-1` (4) ... `--space-12` (48) | |
| Movimento | `--ease-out`, `--ease-in-out`, `--ease-ios`, `--ease-spring`, `--dur-press` (120ms), `--dur-fast` (160), `--dur-base` (220), `--dur-slow` (340) | |

Temi: automatico con `prefers-color-scheme`; forzato con `data-theme="light|dark"` su `<html>` o su qualsiasi sotto-albero (utile per anteprime affiancate). Implementato con `color-scheme` + `light-dark()`, quindi una sola definizione per colore. Richiede browser recenti (Safari 17.5+, Chrome 123+, Firefox 120+).

Preferenze di sistema gestite nei token: `prefers-contrast: more` (testo e bordi piu' forti, materiali opachi), `prefers-reduced-transparency` (materiali opachi), `prefers-reduced-motion` (durate quasi nulle, niente scala sulla pressione).

Angoli continui (squircle): `corner-shape: squircle` e' abilitato dove supportato (`@supports` in `ui.css`); altrove resta il raggio normale.

## Movimento

- **Anima solo `transform` e `opacity`.** Mai `width`, `height`, `top`, `margin`, `box-shadow`, `filter` in animazione.
- Breve: pressione 120ms, popover 160ms, sheet 340ms. Mai oltre ~350ms per UI ricorrente.
- **Mai animare azioni da tastiera ripetute** (apertura palette, navigazione liste).
- Curve: `--ease-out` per ingressi e feedback; `--ease-ios` (la curva dei drawer) per sheet e spostamenti; `--ease-spring` ha un overshoot lieve e va usato solo dove c'e' una gesto con slancio (toggle, segmented, ritorno dello sheet) o per l'ingresso di un alert.
- **Pressione:** `scale(var(--press-scale))` (0.97) su `:active`, subito alla pressione.
- **Interrompibile:** si usano transizioni CSS (che ripartono dal valore corrente) e, per il trascinamento, il valore live. Lo `Sheet` rilegge la posizione attuale se lo riprendi mentre si muove e non blocca mai l'input.
- **Mai da `scale(0)`:** partire da 0.95-0.97 con opacity. I popover usano `transform-origin` dal lato del trigger; i modali restano centrati.
- **Spaziale coerente:** cio' che entra dal basso esce dal basso. Esci piu' in fretta di come entri.
- **Gesti:** trascinamento 1:1 con il dito, Pointer Events con `setPointerCapture`, velocita' di rilascio e proiezione (decelerazione 0.998) per decidere chiusura/ritorno, resistenza progressiva oltre il limite (`rubberband` in `Sheet.tsx`).
- **Movimento ridotto:** niente spostamenti, solo dissolvenze brevi o cambi istantanei. Gli indicatori indeterminati (Spinner, ProgressView) passano a una pulsazione di opacita' lenta. Gli hook React usano `useReducedMotion()`; con movimento ridotto i layer (sheet, alert, popover) si smontano subito senza attendere l'uscita.
- Niente animazioni decorative continue. Le uniche in loop sono gli indicatori di caricamento.

## Componenti

Controlli: `Button` (filled, tinted, gray, plain, destructive; sm/md/lg; `loading`), `IconButton`, `TextField`, `SecureField`, `SearchField`, `SegmentedControl`, `Toggle`, `Slider`, `Stepper`, `Picker`.
Navigazione e struttura: `NavigationBar` (titolo grande che si comprime allo scorrimento), `Toolbar`, `Sidebar`, `Tabs`, `List`/`ListRow`, `Card`, `Material`.
Sovrapposizioni: `Sheet`, `Popover`, `Menu`, `ContextMenu`, `Alert`, `Tooltip`.
Feedback e dati: `ToastProvider` + `useToast()`, `Banner`, `Badge`, `Avatar`, `Spinner`, `ProgressView`.

Convenzioni dell'API: componenti controllabili o non (`value`/`defaultValue`/`onValueChange`, `open`/`onOpenChange`); testi per gli screen reader in italiano; nessuno stato globale tranne `ToastProvider`. Classi CSS con prefisso `l-` (componenti) e `t-` (tipografia).

Limiti noti: `Popover`/`Menu` si posizionano con CSS rispetto al trigger e non si ribaltano da soli ai bordi dello schermo (usare `placement`); `ContextMenu` si limita ai bordi della finestra. Se serve un posizionamento avanzato si puo' introdurre Floating UI (MIT) dopo averlo annotato nel README.

## Test

I test dei componenti stanno in `packages/client/src/ui/ui.test.tsx` (Vitest + Testing Library + user-event). Per ogni nuovo componente interattivo testare almeno: ruolo ARIA e nome accessibile, uso da tastiera, e (per gli overlay) apertura, Esc e ritorno del focus. Per simulare il movimento ridotto si sostituisce `window.matchMedia` (vedi `mockMotion`).

## Icone

Solo Lucide (`lucide-react`, ISC). Mai SF Symbols: la licenza Apple ne vieta l'uso fuori dalle piattaforme Apple. Le icone decorative hanno `aria-hidden`; i pulsanti con sola icona usano `IconButton` con `label`.
