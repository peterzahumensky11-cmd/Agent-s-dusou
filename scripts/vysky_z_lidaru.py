#!/usr/bin/env python3
"""Výšky a tvary striech domov z leteckého laserového skenovania ÚGKK SR.

Vstup:  rastre DMP 1.0 (povrch) a DMR 5.0 (terén) vo formáte GeoTIFF (aj viac dlaždíc)
        a pôdorysy budov z Overpass (scripts/stiahni_budovy.py).
Výstup: data/vysky.json   { "domy": { "way/123": [odkvap, hrebeň, azimut, typ], ... } }
          odkvap, hrebeň – metre nad terénom (pri plochej streche sú rovnaké)
          azimut – stupne od severu v smere hodinových ručičiek:
                   sedlová/valbová = smer hrebeňa (0–179), pultová = smer, ktorým strecha stúpa (0–359)
          typ    – 0 plochá, 1 sedlová, 2 valbová/stanová, 3 pultová, 4 zložitá (známe sú len výšky)

Domy s nespoľahlivými dátami (stromy nad strechou, malý pôdorys, dom postavený po skenovaní,
chýbajúce dáta) sa vynechajú – mapa pri nich ostane pri odhade.

Použitie:
  python scripts/vysky_z_lidaru.py --dmp data/raw/dmp/*.tif --dmr data/raw/dmr/*.tif
  (ak TIFF nemá zapísaný súradnicový systém, pridať napr. --crs EPSG:5514)

Závislosti: pip install numpy rasterio
"""
import argparse
import datetime
import glob
import json
import math
import pathlib
import sys

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.warp import transform as warp_transform

KOREN = pathlib.Path(__file__).resolve().parent.parent
MIN_PLOCHA = 20.0      # m² – menšie pôdorysy sa vynechajú
MIN_PIXLOV = 12        # minimum buniek rastra vnútri pôdorysu
MIN_VYSKA = 2.0        # m – nižší „dom“ pri skenovaní nestál (alebo je to prístrešok)
MAX_VYSKA = 40.0
DRSNOST_STROM = 0.30   # podiel drsných buniek, nad ktorým ide o koruny stromov
PLOCHA_SKLON = 0.12    # sklon (m/m) pod ktorým je strecha plochá (≈ 7°)
PLOCHA_PREVYS = 0.7    # m – menšie prevýšenie strechy = plochá
MAX_RMSE = 0.45        # m – horšia zhoda modelu = „zložitá“ strecha


# ------------------------------------------------------------------ vstupy
def nacitaj_budovy(subory):
    """Vráti zoznam (osm_id, tagy, [vonkajší kruh lon/lat], [vnútorné kruhy])."""
    von, videne = [], set()
    for s in subory:
        for e in json.loads(pathlib.Path(s).read_text(encoding="utf-8"))["elements"]:
            t = e.get("tags") or {}
            if not t.get("building"):
                continue
            kluc = f"{e['type']}/{e['id']}"
            if kluc in videne:
                continue
            if e["type"] == "way" and len(e.get("geometry") or []) >= 4:
                videne.add(kluc)
                von.append((kluc, t, [[(c["lon"], c["lat"]) for c in e["geometry"]]], []))
            elif e["type"] == "relation":
                outer = [[(c["lon"], c["lat"]) for c in m["geometry"]] for m in e.get("members", [])
                         if m.get("geometry") and m.get("role") != "inner"]
                inner = [[(c["lon"], c["lat"]) for c in m["geometry"]] for m in e.get("members", [])
                         if m.get("geometry") and m.get("role") == "inner"]
                outer = [r for r in outer if len(r) >= 4 and r[0] == r[-1]]  # len uzavreté obrysy
                if outer:
                    videne.add(kluc)
                    von.append((kluc, t, outer, [r for r in inner if len(r) >= 4]))
    return von


def mozaika(subory, bounds, crs):
    srcs = [rasterio.open(s) for s in subory]
    try:
        arr, tr = merge(srcs, bounds=bounds, res=1.0, nodata=np.nan, dtype="float32", resampling=rasterio.enums.Resampling.bilinear)
    finally:
        for s in srcs:
            s.close()
    a = arr[0]
    a[(a < -500) | (a > 5000)] = np.nan
    return a, tr


# ------------------------------------------------------------------ geometria
def plocha(r):
    return abs(sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1))) / 2


def vnutri(px, py, r):
    """Vektorizovaný test bod v mnohouholníku."""
    ins = np.zeros(px.shape, bool)
    for (x1, y1), (x2, y2) in zip(r[:-1], r[1:]):
        if y1 == y2:
            continue
        c = ((y1 > py) != (y2 > py)) & (px < (x2 - x1) * (py - y1) / (y2 - y1) + x1)
        ins ^= c
    return ins


def vzdialenost_od_hran(px, py, kruhy):
    d = np.full(px.shape, np.inf)
    for r in kruhy:
        for (x1, y1), (x2, y2) in zip(r[:-1], r[1:]):
            dx, dy = x2 - x1, y2 - y1
            l2 = dx * dx + dy * dy
            if l2 == 0:
                continue
            t = np.clip(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1)
            d = np.minimum(d, np.hypot(px - (x1 + t * dx), py - (y1 + t * dy)))
    return d


def opisany_obdlznik(r):
    """Najmenší opísaný obdĺžnik podľa smerov hrán (rovnako ako app.js). Os u = dlhšia strana."""
    naj = None
    pts = r[:-1]
    for (x1, y1), (x2, y2) in zip(r[:-1], r[1:]):
        d = math.hypot(x2 - x1, y2 - y1)
        if d < 0.5:
            continue
        ux, uy = (x2 - x1) / d, (y2 - y1) / d
        us = [p[0] * ux + p[1] * uy for p in pts]
        vs = [-p[0] * uy + p[1] * ux for p in pts]
        a = (max(us) - min(us)) * (max(vs) - min(vs))
        if naj is None or a < naj[0]:
            naj = (a, ux, uy, min(us), max(us), min(vs), max(vs))
    if naj is None:
        return None
    a, ux, uy, u0, u1, v0, v1 = naj
    if u1 - u0 < v1 - v0:
        ux, uy, u0, u1, v0, v1 = -uy, ux, v0, v1, -u1, -u0
    return dict(a=a, ux=ux, uy=uy, L=u1 - u0, W=v1 - v0, cu=(u0 + u1) / 2, cv=(v0 + v1) / 2)


def azimut(dx, dy, modulo):
    """Smer vektora (x = východ, y = sever) v stupňoch od severu."""
    return round(math.degrees(math.atan2(dx, dy))) % modulo


# ------------------------------------------------------------------ modely strechy
def lsq(A, z):
    k, *_ = np.linalg.lstsq(A, z, rcond=None)
    return k, float(np.sqrt(np.mean((A @ k - z) ** 2)))


def fit_sedlova(d, z, polsirka):
    """z = hrebeň − sklon·|d − d0|; d = vzdialenosť naprieč, d0 sa hľadá do ±1,5 m (nepresná poloha pôdorysu)."""
    naj = None
    for d0 in np.arange(-1.5, 1.51, 0.5):
        k, rmse = lsq(np.c_[np.ones_like(d), -np.abs(d - d0)], z)
        if naj is None or rmse < naj[2]:
            naj = (k[0], k[1], rmse)
    hreben, sklon, rmse = naj
    return dict(hreben=hreben, odkvap=hreben - sklon * polsirka, sklon=sklon, rmse=rmse)


def fit_valbova(u, v, z, L, W):
    """z = odkvap + sklon·min(W/2 − |v|, L/2 − |u|) – zhodné s vykreslením valbovej strechy v app.js."""
    g = np.clip(np.minimum(W / 2 - np.abs(v), L / 2 - np.abs(u)), 0, None)
    k, rmse = lsq(np.c_[np.ones_like(g), g], z)
    return dict(odkvap=k[0], hreben=k[0] + k[1] * W / 2, sklon=k[1], rmse=rmse)


def spracuj_dom(kruhy_xy, diery_xy, nd, tr, posun):
    """Vráti ([odkvap, hrebeň, azimut, typ], None) alebo (None, dôvod vynechania)."""
    r = max(kruhy_xy, key=plocha)
    pl = sum(plocha(k) for k in kruhy_xy) - sum(plocha(k) for k in diery_xy)
    if pl < MIN_PLOCHA:
        return None, "malý pôdorys"
    xs = [p[0] for k in kruhy_xy for p in k]
    ys = [p[1] for k in kruhy_xy for p in k]
    c0 = max(0, int((min(xs) - tr.c) / tr.a) - 1); c1 = min(nd.shape[1], int((max(xs) - tr.c) / tr.a) + 2)
    r0 = max(0, int((max(ys) - tr.f) / tr.e) - 1); r1 = min(nd.shape[0], int((min(ys) - tr.f) / tr.e) + 2)
    if c1 - c0 < 3 or r1 - r0 < 3:
        return None, "mimo dát"
    cc, rr = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
    px = tr.c + (cc + 0.5) * tr.a - posun[0]   # stredy buniek v sústave pôdorysu
    py = tr.f + (rr + 0.5) * tr.e - posun[1]
    ins = np.zeros(px.shape, bool)
    for k in kruhy_xy:
        ins |= vnutri(px, py, k)
    for k in diery_xy:
        ins &= ~vnutri(px, py, k)
    dh = vzdialenost_od_hran(px, py, kruhy_xy + diery_xy)
    z = nd[r0:r1, c0:c1]
    maska = None
    for okraj in (1.0, 0.5):  # bunky pri obvode sú zmes strechy a dvora – vynechať
        m = ins & (dh >= okraj)
        if m.sum() >= MIN_PIXLOV:
            maska = m
            break
    if maska is None:
        return None, "malý pôdorys"
    if np.isnan(z[maska]).mean() > 0.05:
        return None, "chýbajúce dáta"
    maska &= ~np.isnan(z)
    zz = z[maska].astype(float)
    med = float(np.median(zz))
    if med < MIN_VYSKA:
        return None, "pri skenovaní nestál (alebo nízky prístrešok)"
    if med > MAX_VYSKA:
        return None, "nereálna výška"
    # drsnosť povrchu: strecha je po častiach rovinná, koruny stromov nie
    lap = np.full(z.shape, np.nan)
    lap[1:-1, 1:-1] = np.abs(z[1:-1, 1:-1] - (z[:-2, 1:-1] + z[2:, 1:-1] + z[1:-1, :-2] + z[1:-1, 2:]) / 4)
    ll = lap[maska & ~np.isnan(lap)]
    if ll.size >= 6 and float((ll > 0.5).mean()) > DRSNOST_STROM:
        return None, "stromy nad domom / nečitateľná strecha"
    nizke = float((zz < 1.0).mean())
    if nizke > 0.25:
        return None, "pôdorys nesedí s dátami"

    o = opisany_obdlznik(r)
    if o is None:
        return None, "chybný pôdorys"
    x, y = px[maska], py[maska]
    u = x * o["ux"] + y * o["uy"] - o["cu"]
    v = -x * o["uy"] + y * o["ux"] - o["cv"]
    L, W = o["L"], o["W"]
    p05, p95 = np.percentile(zz, [5, 95])
    kp, rmse_rovina = lsq(np.c_[np.ones_like(u), u, v], zz)        # všeobecná rovina
    sklon_roviny = math.hypot(kp[1], kp[2])
    rmse_plocha = float(np.std(zz))

    if p95 - p05 < PLOCHA_PREVYS or (rmse_plocha < 0.25):
        h = round(med, 1)
        return [h, h, 0, 0], None

    kand = []
    s1 = fit_sedlova(v, zz, W / 2); s1.update(typ=1, az=azimut(o["ux"], o["uy"], 180))            # hrebeň pozdĺž dlhšej strany
    s2 = fit_sedlova(u, zz, L / 2); s2.update(typ=1, az=azimut(-o["uy"], o["ux"], 180))           # hrebeň pozdĺž kratšej strany
    vb = fit_valbova(u, v, zz, L, W); vb.update(typ=2, az=azimut(o["ux"], o["uy"], 180))
    kand += [s1, s2]
    if vb["rmse"] < 0.85 * min(s1["rmse"], s2["rmse"]):
        kand.append(vb)
    kand = [k for k in kand if k["sklon"] > PLOCHA_SKLON]
    naj = min(kand, key=lambda k: k["rmse"]) if kand else None

    # pultová: jedna naklonená rovina vystihuje strechu lepšie ako sedlová
    if sklon_roviny > PLOCHA_SKLON and rmse_rovina < MAX_RMSE and (naj is None or rmse_rovina < 0.8 * naj["rmse"]):
        gx = kp[1] * o["ux"] - kp[2] * o["uy"]   # gradient v súradniciach x, y
        gy = kp[1] * o["uy"] + kp[2] * o["ux"]
        # zarovnať smer stúpania s osou pôdorysu a dopočítať výšky na okrajoch
        if abs(kp[1]) > abs(kp[2]):
            polrozmer, zn, ax = L / 2, math.copysign(1, kp[1]), (o["ux"], o["uy"])
            sk = abs(kp[1])
        else:
            polrozmer, zn, ax = W / 2, math.copysign(1, kp[2]), (-o["uy"], o["ux"])
            sk = abs(kp[2])
        odkvap, hreben = kp[0] - sk * polrozmer, kp[0] + sk * polrozmer
        if odkvap >= 1.5:
            return [round(odkvap, 1), round(hreben, 1), azimut(zn * ax[0], zn * ax[1], 360), 3], None

    if naj is not None and naj["rmse"] < MAX_RMSE and naj["odkvap"] >= 1.5 and 0.5 <= naj["hreben"] - naj["odkvap"] <= 9:
        return [round(naj["odkvap"], 1), round(naj["hreben"], 1), naj["az"], naj["typ"]], None
    if sklon_roviny <= PLOCHA_SKLON and rmse_plocha < MAX_RMSE:
        h = round(med, 1)
        return [h, h, 0, 0], None
    # zložitá strecha (tvar L, vikiere…): spoľahlivé sú len výšky
    odkvap, hreben = max(1.5, float(p05)), float(np.percentile(zz, 98))
    if hreben - odkvap > 9:
        return None, "nečitateľná strecha"
    return [round(odkvap, 1), round(hreben, 1), 0, 4], None


def najdi_posun(domy, nd, tr):
    """Spoločný posun pôdorysov voči rastru (nepresnosť prevodu WGS84 → S-JTSK a kresby v OSM).
    Hľadá sa posun do ±3 m, pri ktorom leží vo vnútri pôdorysov najviac vysokých buniek."""
    vys = np.nan_to_num(nd, nan=0.0) > 2.5
    body = []
    for kruhy, diery in domy:
        r = max(kruhy, key=plocha)
        if plocha(r) < 40:
            continue
        xs = [p[0] for p in r]; ys = [p[1] for p in r]
        gx, gy = np.meshgrid(np.arange(min(xs), max(xs), 1.0), np.arange(min(ys), max(ys), 1.0))
        m = vnutri(gx, gy, r)
        body.append(np.c_[gx[m], gy[m]])
    if not body:
        return (0.0, 0.0)
    b = np.vstack(body)
    naj, kde = -1, (0.0, 0.0)
    for dx in np.arange(-3, 3.01, 0.5):
        for dy in np.arange(-3, 3.01, 0.5):
            c = ((b[:, 0] + dx - tr.c) / tr.a).astype(int)
            rw = ((b[:, 1] + dy - tr.f) / tr.e).astype(int)
            ok = (c >= 0) & (c < nd.shape[1]) & (rw >= 0) & (rw < nd.shape[0])
            s = int(vys[rw[ok], c[ok]].sum()) - 0.001 * (abs(dx) + abs(dy))
            if s > naj:
                naj, kde = s, (float(dx), float(dy))
    return kde


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dmp", nargs="+", required=True, help="GeoTIFF súbory DMP 1.0 (povrch)")
    ap.add_argument("--dmr", nargs="+", required=True, help="GeoTIFF súbory DMR 5.0 (terén)")
    ap.add_argument("--budovy", nargs="+", default=[str(KOREN / "data" / "raw" / "budovy_*.json")])
    ap.add_argument("--crs", help="súradnicový systém rastrov, ak nie je zapísaný v súbore (napr. EPSG:5514)")
    ap.add_argument("--von", default=str(KOREN / "data" / "vysky.json"))
    ap.add_argument("--bez-posunu", action="store_true", help="nehľadať spoločný posun pôdorysov")
    a = ap.parse_args()

    rozbal = lambda zoz: sorted({f for s in zoz for f in (glob.glob(s) or [s])})
    dmp, dmr, bud = rozbal(a.dmp), rozbal(a.dmr), rozbal(a.budovy)
    budovy = nacitaj_budovy(bud)
    if not budovy:
        sys.exit("Žiadne budovy – najprv spustite scripts/stiahni_budovy.py")
    with rasterio.open(dmp[0]) as s:
        crs = a.crs or s.crs
    if not crs:
        sys.exit("Raster nemá zapísaný súradnicový systém – zadajte --crs (napr. EPSG:5514)")

    def do_xy(kruh):
        xs, ys = warp_transform("EPSG:4326", crs, [p[0] for p in kruh], [p[1] for p in kruh])
        return list(zip(xs, ys))

    domy = [([do_xy(k) for k in outer], [do_xy(k) for k in inner]) for _, _, outer, inner in budovy]
    vx = [p[0] for d in domy for k in d[0] for p in k]
    vy = [p[1] for d in domy for k in d[0] for p in k]
    bounds = (math.floor(min(vx)) - 20, math.floor(min(vy)) - 20, math.ceil(max(vx)) + 20, math.ceil(max(vy)) + 20)
    print(f"Budov: {len(budovy)}, oblasť {bounds[2] - bounds[0]:.0f} × {bounds[3] - bounds[1]:.0f} m, CRS {crs}")
    P, tr = mozaika(dmp, bounds, crs)
    R, tr2 = mozaika(dmr, bounds, crs)
    assert P.shape == R.shape and tr == tr2, "DMP a DMR sa nepodarilo zosúladiť"
    nd = P - R
    print(f"Pokrytie dátami: {100 * (1 - np.isnan(nd).mean()):.0f} % oblasti")
    posun = (0.0, 0.0) if a.bez_posunu else najdi_posun(domy, nd, tr)
    print(f"Spoločný posun pôdorysov: {posun[0]:+.1f} m (x), {posun[1]:+.1f} m (y)")

    vysledok, dovody, typy = {}, {}, {}
    for (kluc, tagy, _, _), (kruhy, diery) in zip(budovy, domy):
        v, dovod = spracuj_dom(kruhy, diery, nd, tr, posun)
        if v:
            vysledok[kluc] = v
            typy[v[3]] = typy.get(v[3], 0) + 1
        else:
            dovody[dovod] = dovody.get(dovod, 0) + 1
    nazvy = ["plochá", "sedlová", "valbová", "pultová", "zložitá"]
    print(f"\nSpracované: {len(vysledok)} z {len(budovy)} budov")
    for t in sorted(typy):
        print(f"  {nazvy[t]}: {typy[t]}")
    print("Vynechané:")
    for d, n in sorted(dovody.items(), key=lambda x: -x[1]):
        print(f"  {d}: {n}")
    von = {"zdroj": "Letecké laserové skenovanie ÚGKK SR (DMP 1.0 − DMR 5.0)",
           "vytvorene": datetime.date.today().isoformat(), "budov": len(budovy), "pocet": len(vysledok),
           "polia": ["odkvap_m", "hreben_m", "azimut", "typ"], "domy": vysledok}
    pathlib.Path(a.von).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(a.von).write_text(json.dumps(von, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\nZapísané: {a.von} ({pathlib.Path(a.von).stat().st_size / 1024:.0f} kB)")


if __name__ == "__main__":
    main()
