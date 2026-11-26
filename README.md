# 3D mapa obcí – Sokoľ, Kostoľany nad Hornádom, Družstevná pri Hornáde

Interaktívna 3D webová mapa (MapLibre GL JS) bez API kľúčov a bez servera – čisto statické súbory.

- **3D domy**: obrysy budov z OpenStreetMap cez Overpass API, výška z `height` / `building:levels` (× 3 m), inak 6 m.
- **Výšky a strechy z LiDAR-u**: ak existuje `data/vysky.json` (vyrába `scripts/vysky_z_lidaru.py`, pozri `scripts/README.md`),
  použije sa výška odkvapu, hrebeňa a tvar strechy z leteckého laserového skenovania ÚGKK SR; ostatné domy ostávajú pri odhade.
- **Kataster**: kresba parciel registra C a E (INSPIRE WMS / WMS ÚGKK SR), po kliknutí číslo parcely, LV,
  druh pozemku, výmera a odkazy na katasterportal.sk a ZBGIS.
- **Ortofoto**: ZBGIS (ÚGKK SR), s automatickou náhradou, ak služba prehliadaču neodpovie.
- **Filtre**: nezastavané parcely, druh pozemku, výmera.
- Údaje o vlastníkoch sa nenačítavajú ani nezobrazujú.

## Súbory
`index.html`, `style.css`, `app.js` – aplikácia · `diag.html` – test dostupnosti služieb z prehliadača ·
`vendor/` – MapLibre GL JS 4.7.1 (BSD-3).

## Spustenie lokálne
`python3 -m http.server` a otvoriť `http://localhost:8000`.

## Ďalšia obec
Pridať riadok do poľa `OBCE` v `app.js` (názov presne ako v OpenStreetMap, stred, zoom).

Údaje: © prispievatelia OpenStreetMap (ODbL), ÚGKK SR.
