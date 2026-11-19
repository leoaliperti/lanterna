# Lanterna

Tavolo virtuale (VTT) open source per giocare di ruolo online con gli amici: mappa con griglia, token, chat, dadi e, in seguito, nebbia di guerra, iniziativa e schede D&D 5e. Pensato per essere ospitato su un server di casa e raggiunto tramite Cloudflare Tunnel.

**Stato:** milestone M0 (scaffolding) in corso. Vedi [`docs/PLAN.md`](docs/PLAN.md) per decisioni e milestone e [`CLAUDE.md`](CLAUDE.md) per stack e regole di sviluppo.

## Licenza

[AGPL-3.0-or-later](LICENSE). Chi usa o modifica questo codice, anche solo ospitandolo come servizio, deve restare open source con la stessa licenza.

## Contenuti di gioco

Il repository non contiene mostri, incantesimi, manuali o altro testo protetto. Ogni istanza li importa a mano.

## Crediti, codice e librerie di terze parti

Ogni libreria o snippet copiato va elencato qui con licenza e fonte.

| Componente | Licenza | Fonte | Uso |
|---|---|---|---|
| DiceGen (dadi 3D) | MIT | https://git.aliperti.me/alipe/DiceGen.git (stesso autore) | base dell'animazione dei dadi, con esito deciso dal server |
| Three.js 0.160.0 | MIT | https://github.com/mrdoob/three.js | rendering 3D dei dadi |

Non viene copiato codice da Owlbear Rodeo Legacy (licenza non commerciale).

## Sviluppo

Richiede Node 22 o superiore.

```
npm install
npm run dev      # server su :3000 e client Vite
npm test
npm run lint
```
