#!/usr/bin/env python3
"""Stiahne hranice obcí a pôdorysy budov z OpenStreetMap (Overpass API).

Dopyt je zhodný s funkciou nacitajObec v app.js, takže OSM id domov sedia s mapou.
Výstup: data/raw/budovy_<id>.json (surová odpoveď Overpass, v .gitignore).

Použitie:  python scripts/stiahni_budovy.py
"""
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

OBCE = {"sokol": "Sokoľ", "kostolany": "Kostoľany nad Hornádom", "druzstevna": "Družstevná pri Hornáde"}
OKOLIE = "(48.70,21.10,48.90,21.40)"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
VON = pathlib.Path(__file__).resolve().parent.parent / "data" / "raw"


def dopyt(nazov):
    return f"""[out:json][timeout:60];
relation[boundary=administrative][name="{nazov}"]{OKOLIE}->.r;
.r out geom;
.r map_to_area->.a;
(way[building](area.a);relation[building](area.a););
out tags geom;"""


def overpass(q):
    chyba = None
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=("data=" + urllib.parse.quote(q)).encode(),
                                         headers={"User-Agent": "mapa-obci-3d/1.0", "Content-Type": "application/x-www-form-urlencoded"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # skúsiť ďalší server
            chyba = e
            print(f"  {url}: {e}", file=sys.stderr)
    raise chyba


def main():
    VON.mkdir(parents=True, exist_ok=True)
    for oid, nazov in OBCE.items():
        j = overpass(dopyt(nazov))
        n = sum(1 for e in j["elements"] if (e.get("tags") or {}).get("building"))
        (VON / f"budovy_{oid}.json").write_text(json.dumps(j), encoding="utf-8")
        print(f"{nazov}: {n} budov")
        time.sleep(2)


if __name__ == "__main__":
    main()
