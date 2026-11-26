# Výšky a strechy domov z LiDAR-u (ÚGKK SR)

Spúšťať na počítači so slovenským pripojením – z cloudových serverov `*.skgeodesy.sk` ani Overpass neodpovedajú.

```
pip install numpy rasterio
python scripts/stiahni_budovy.py                      # pôdorysy z OSM -> data/raw/budovy_*.json
python scripts/vysky_z_lidaru.py --dmp data/raw/dmp/*.tif --dmr data/raw/dmr/*.tif
python -m http.server                                 # skontrolovať mapu na http://localhost:8000
```

Výsledok je `data/vysky.json` (jediný súbor, ktorý patrí do repozitára; `data/raw/` je v `.gitignore`).

## Odkiaľ vziať rastre DMP 1.0 a DMR 5.0
Stav: **neoverené** – spôsob sťahovania treba potvrdiť zo slovenského pripojenia.
- Podľa stránok ÚGKK SR/GKÚ sa výrezy DMR 5.0 a DMP 1.0 (do cca 400 km², TIFF, 1 m) exportujú v aplikácii
  Mapka (https://zbgis.skgeodesy.sk/mkzbgis/) v téme **Terén** → nástroj na export údajov LLS → nakresliť
  obdĺžnik okolo troch obcí → stiahnuť ZIP pre DMR 5.0 aj DMP 1.0 a rozbaliť do `data/raw/dmr/` a `data/raw/dmp/`.
- Celoštátne balíky (155–200 GB) sú pre túto úlohu zbytočne veľké.
- Či existuje aj strojové rozhranie (WCS / ImageServer), sa nepodarilo overiť.

Ak TIFF nemá zapísaný súradnicový systém (TIFF + TFW), pridať `--crs EPSG:5514`.

## Ako skript rozhoduje
- pracuje s rozdielom DMP − DMR vnútri pôdorysu zmenšeného o 1 m (okrajové bunky sú zmes strechy a dvora),
- najprv nájde spoločný posun pôdorysov voči rastru (do ±3 m),
- porovná modely plochá / sedlová (hrebeň pozdĺž dlhšej aj kratšej strany) / valbová / pultová a vyberie najlepší,
- vynechá dom: pôdorys < 20 m², medián výšky < 2 m (pri skenovaní nestál), drsný povrch (stromy), chýbajúce dáta,
- na konci vypíše, koľko domov spracoval a koľko vynechal z akého dôvodu.

Algoritmus bol zatiaľ overený len na umelých dátach; prahy (`MAX_RMSE`, `DRSNOST_STROM`…) treba doladiť
podľa porovnania s ortofotom.
