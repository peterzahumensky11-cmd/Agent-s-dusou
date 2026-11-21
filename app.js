/* 3D mapa obcí – MapLibre GL JS, OpenStreetMap (Overpass), ÚGKK SR (kataster, ZBGIS).
   Zobrazuje len údaje o parcelách (číslo, LV, druh pozemku, výmera). Údaje o vlastníkoch
   sa nikdy nenačítavajú ani nezobrazujú. */
'use strict';

// ---------------------------------------------------------------- konfigurácia
const OBCE = [
  { id: 'sokol', nazov: 'Sokoľ', stred: [21.2165, 48.8165], zoom: 15.3 },
  { id: 'kostolany', nazov: 'Kostoľany nad Hornádom', stred: [21.2282, 48.7876], zoom: 14 },
  { id: 'druzstevna', nazov: 'Družstevná pri Hornáde', stred: [21.2536, 48.8043], zoom: 14 },
];
const OKOLIE = '(48.70,21.10,48.90,21.40)'; // rámec pre vyhľadanie obcí v Overpass (juh, západ, sever, východ)

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const KN = 'https://kataster.skgeodesy.sk';
const INSPIRE = 'https://inspirews.skgeodesy.sk/geoserver';
const WMS_Q = 'service=WMS&version=1.3.0&request=GetMap&styles=&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512';

// Kandidáti na rastrové vrstvy – použije sa prvý, ktorý prehliadaču odpovie (vyžaduje CORS).
// Služby REST a OData katastra prístup z cudzej stránky nepovoľujú, preto sa nepoužívajú.
const RASTRE = {
  orto: [
    { nazov: 'ZBGIS ortofoto (WMS)', caps: 'https://zbgisws.skgeodesy.sk/zbgis_ortofoto_wms/service.svc/get', fmt: 'image/jpeg' },
    { nazov: 'Esri World Imagery (náhrada)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', tile: 256,
      attr: 'Snímky © Esri, Maxar, Earthstar Geographics' },
  ],
  c: [
    { nazov: 'WMS katastra – register C', caps: KN + '/eskn/services/NR/kn_wms_norm/MapServer/WmsServer', fmt: 'image/png&transparent=true' },
    { nazov: 'INSPIRE WMS – parcely C', url: INSPIRE + '/cp/ows?' + WMS_Q + '&format=image/png&transparent=true&layers=CP.CadastralParcel' },
  ],
  e: [
    { nazov: 'WMS katastra – register E', caps: KN + '/eskn/services/NR/uo_wms_norm/MapServer/WmsServer', fmt: 'image/png&transparent=true' },
    { nazov: 'INSPIRE WMS – parcely E', caps: INSPIRE + '/cp_uo/ows', fmt: 'image/png&transparent=true' },
  ],
};

// Vektorové parcely (geometria + atribúty): INSPIRE WFS; názov typu sa overí z GetCapabilities.
const PARCELY = {
  c: { wfs: INSPIRE + '/cp/ows', typ: 'cp:CP.CadastralParcel' },
  e: { wfs: INSPIRE + '/cp_uo/ows', typ: 'cp_uo:CP.CadastralParcel' },
};

// Číselník druhov pozemkov katastra nehnuteľností.
const DRUHY = { 2: 'orná pôda', 3: 'chmeľnica', 4: 'vinica', 5: 'záhrada', 6: 'ovocný sad', 7: 'trvalý trávny porast',
  10: 'lesný pozemok', 11: 'vodná plocha', 13: 'zastavaná plocha a nádvorie', 14: 'ostatná plocha' };
const FARBY_DRUH = ['match', ['get', 'druh'],
  'orná pôda', '#d9a441', 'záhrada', '#6fbf73', 'ovocný sad', '#3f9d6b', 'vinica', '#9c6bb5', 'chmeľnica', '#8fb14a',
  'trvalý trávny porast', '#b5d56a', 'lesný pozemok', '#2f6b45', 'vodná plocha', '#4a90c2',
  'zastavaná plocha a nádvorie', '#c8553d', 'ostatná plocha', '#9aa3a0', '#e0c341'];

// ---------------------------------------------------------------- pomôcky
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtM2 = (v) => (v == null || isNaN(v) ? '—' : Math.round(v).toLocaleString('sk-SK') + ' m²');

function toast(text, ms = 3500) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); if (ms) toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
function stav(kluc, trieda, text) {
  let li = document.querySelector(`#stav li[data-k="${kluc}"]`);
  if (!li) { li = document.createElement('li'); li.dataset.k = kluc; $('stav').appendChild(li); }
  li.className = trieda; li.textContent = text;
}
async function fetchT(url, opts = {}, ms = 25000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
}
const cache = {
  get(k, maxAge) { try { const o = JSON.parse(localStorage.getItem(k)); if (o && Date.now() - o.t < maxAge) return o.d; } catch (e) {} return null; },
  set(k, d) { try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), d })); } catch (e) {} },
};

// geometria
function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; } // >0 = v smere hod. ručičiek
function inRing(p, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function polys(g) { return !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; }
function inGeom(p, g) { return polys(g).some((pl) => inRing(p, pl[0]) && !pl.slice(1).some((h) => inRing(p, h))); }
function bboxOf(g) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const pl of polys(g)) for (const c of pl[0]) { if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1]; if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1]; }
  return b;
}
function centroid(ring) { let x = 0, y = 0; for (const c of ring) { x += c[0]; y += c[1]; } return [x / ring.length, y / ring.length]; }
// plocha v m² zo súradníc WGS84 (lokálna rovinná aproximácia – postačuje pre parcely)
function areaM2(g) {
  let s = 0;
  for (const pl of polys(g)) pl.forEach((r, i) => {
    const k = Math.cos((r[0][1] * Math.PI) / 180) * 111320, a = Math.abs(ringArea(r.map((c) => [c[0] * k, c[1] * 110574])));
    s += i ? -a : a;
  });
  return s;
}
// Slovensko: zem. dĺžka 16.8–22.6, šírka 47.7–49.7 → poradie osí sa dá spoľahlivo rozpoznať
function fixOrder(coords) {
  const walk = (a) => (typeof a[0] === 'number' ? (a[0] > 40 ? [a[1], a[0]] : a) : a.map(walk));
  return walk(coords);
}
// pospájanie úsekov (ways) do uzavretých prstencov
function stitch(lines) {
  const rings = []; const rest = lines.map((l) => l.slice());
  while (rest.length) {
    let r = rest.pop(), zmena = true;
    const key = (c) => c[0].toFixed(7) + ',' + c[1].toFixed(7);
    while (zmena && key(r[0]) !== key(r[r.length - 1])) {
      zmena = false;
      for (let i = 0; i < rest.length; i++) {
        const l = rest[i], e = key(r[r.length - 1]);
        if (key(l[0]) === e) { r = r.concat(l.slice(1)); } else if (key(l[l.length - 1]) === e) { r = r.concat(l.slice().reverse().slice(1)); } else continue;
        rest.splice(i, 1); zmena = true; break;
      }
    }
    if (r.length >= 4 && key(r[0]) === key(r[r.length - 1])) rings.push(r);
  }
  return rings;
}

// ---------------------------------------------------------------- mapa
const prazdne = () => ({ type: 'FeatureCollection', features: [] });
const map = new maplibregl.Map({
  container: 'map', center: OBCE[0].stred, zoom: OBCE[0].zoom, pitch: 55, bearing: -15, maxPitch: 75, minZoom: 11, maxZoom: 20,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
      hranica: { type: 'geojson', data: prazdne() }, budovy: { type: 'geojson', data: prazdne() },
      parcely: { type: 'geojson', data: prazdne() }, vyber: { type: 'geojson', data: prazdne() },
    },
    layers: [
      { id: 'pozadie', type: 'background', paint: { 'background-color': '#dfe6dc' } },
      { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
      { id: 'parcely-fill', type: 'fill', source: 'parcely', paint: { 'fill-color': FARBY_DRUH, 'fill-opacity': 0.5 } },
      { id: 'parcely-line', type: 'line', source: 'parcely', paint: { 'line-color': '#fff', 'line-width': 1 } },
      { id: 'hranica', type: 'line', source: 'hranica', paint: { 'line-color': '#ffdd55', 'line-width': 3, 'line-dasharray': [2, 1.5] } },
      { id: 'vyber-fill', type: 'fill', source: 'vyber', paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.3 } },
      { id: 'vyber-line', type: 'line', source: 'vyber', paint: { 'line-color': '#00e5ff', 'line-width': 3 } },
      { id: 'budovy', type: 'fill-extrusion', source: 'budovy', paint: {
        'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'sel'], false], '#00e5ff', ['get', 'farba']],
        'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.92 } },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Kataster a ZBGIS © ÚGKK SR' }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

const S = { obec: OBCE[0], data: {}, rastre: {}, parcely: null, vybranaBudova: null };

// ---------------------------------------------------------------- rastrové vrstvy
function tileBBox(lngLat, z = 16) {
  const R = 20037508.342789244, n = 2 ** z;
  const x = Math.floor(((lngLat[0] + 180) / 360) * n), lat = (lngLat[1] * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
  const w = (2 * R) / n;
  return { z, x, y, bbox: [x * w - R, R - (y + 1) * w, (x + 1) * w - R, R - y * w].join(',') };
}
async function capsLayers(base) {
  const r = await fetchT(base + '?service=WMS&version=1.3.0&request=GetCapabilities', {}, 15000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
  // pomenované vrstvy bez podvrstiev (listy stromu vrstiev)
  const names = [...xml.getElementsByTagName('Layer')]
    .filter((l) => ![...l.children].some((c) => c.tagName === 'Layer'))
    .map((l) => [...l.children].find((c) => c.tagName === 'Name')?.textContent).filter(Boolean);
  if (!names.length) throw new Error('žiadne vrstvy');
  return names.reverse().join(','); // ArcGIS uvádza vrstvy zhora nadol, WMS kreslí zdola nahor
}
async function vyberRaster(kluc) {
  if (S.rastre[kluc] !== undefined) return S.rastre[kluc];
  const t = tileBBox(S.obec.stred);
  for (const k of RASTRE[kluc]) {
    try {
      let url = k.url, vrstvy;
      if (k.caps) { vrstvy = await capsLayers(k.caps); url = `${k.caps}?${WMS_Q}&format=${k.fmt}&layers=${encodeURIComponent(vrstvy)}`; }
      const test = url.replace('{bbox-epsg-3857}', t.bbox).replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
      const r = await fetchT(test, {}, 15000);
      if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) throw new Error('HTTP ' + r.status);
      return (S.rastre[kluc] = { ...k, url, vrstvy });
    } catch (e) { console.warn('Raster nedostupný:', k.nazov, e.message); }
  }
  return (S.rastre[kluc] = null);
}
const NAZVY = { orto: 'Ortofoto', c: 'Parcely C', e: 'Parcely E' };
async function zapniRaster(kluc, viditelny) {
  const id = 'r-' + kluc;
  if (viditelny && !map.getLayer(id)) {
    stav(id, '', NAZVY[kluc] + ': overujem…');
    const k = await vyberRaster(kluc);
    if (!k) { stav(id, 'bad', NAZVY[kluc] + ': služba neodpovedá prehliadaču'); if (kluc === 'orto') prepniPodklad('osm'); return; }
    stav(id, /náhrada/.test(k.nazov) ? 'warn' : 'ok', NAZVY[kluc] + ': ' + k.nazov);
    if (map.getLayer(id)) return;
    map.addSource(id, { type: 'raster', tiles: [k.url], tileSize: k.tile || 512, minzoom: kluc === 'orto' ? 0 : 15, attribution: k.attr || '' });
    map.addLayer({ id, type: 'raster', source: id, minzoom: kluc === 'orto' ? 0 : 15, paint: kluc === 'orto' ? {} : { 'raster-opacity': 0.9 } },
      kluc === 'orto' ? 'parcely-fill' : 'hranica');
  }
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', viditelny ? 'visible' : 'none');
}
function prepniPodklad(typ) {
  document.querySelector(`input[name=base][value=${typ}]`).checked = true;
  map.setLayoutProperty('osm', 'visibility', typ === 'osm' ? 'visible' : 'none');
  zapniRaster('orto', typ === 'orto');
}

// ---------------------------------------------------------------- OpenStreetMap: hranica obce a budovy
async function overpass(q) {
  let chyba;
  for (const url of OVERPASS) {
    try {
      const r = await fetchT(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 60000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { chyba = e; }
  }
  throw chyba;
}
function vyskaBudovy(t) {
  const h = parseFloat(t.height); if (h > 0) return h;
  const l = parseFloat(t['building:levels']);
  if (l > 0) return l * 3 + (parseFloat(t['roof:levels']) > 0 ? parseFloat(t['roof:levels']) * 2 : 0);
  return /^(garage|garages|shed|hut|carport|roof|greenhouse)$/.test(t.building) ? 3 : 6;
}
function farbaBudovy(t) {
  if (/^(church|chapel|cathedral)$/.test(t.building) || t.amenity === 'place_of_worship') return '#d9b25f';
  if (/^(garage|garages|shed|hut|carport|greenhouse|roof)$/.test(t.building)) return '#b9b3a6';
  if (/^(industrial|warehouse|farm_auxiliary|barn|commercial|retail)$/.test(t.building)) return '#a9b4c2';
  if (/^(school|kindergarten|public|civic|government)$/.test(t.building)) return '#e6c7a1';
  return '#efe6d8';
}
function osmNaGeoJSON(json) {
  const budovy = [], hrany = [];
  const tagy = (e) => {
    const t = e.tags || {}, p = { osm: e.type + '/' + e.id, h: vyskaBudovy(t), farba: farbaBudovy(t) };
    for (const k of ['building', 'building:levels', 'addr:housenumber', 'addr:conscriptionnumber', 'addr:streetnumber', 'addr:street', 'name', 'amenity', 'shop']) if (t[k]) p[k] = t[k];
    return p;
  };
  const line = (g) => g.map((c) => [c.lon, c.lat]);
  for (const e of json.elements) {
    const t = e.tags || {};
    if (e.type === 'relation' && t.boundary === 'administrative') {
      for (const m of e.members) if (m.type === 'way' && m.geometry && m.role !== 'inner') hrany.push(line(m.geometry));
    } else if (e.type === 'way' && t.building && e.geometry && e.geometry.length >= 4) {
      budovy.push({ type: 'Feature', id: budovy.length + 1, properties: tagy(e), geometry: { type: 'Polygon', coordinates: [line(e.geometry)] } });
    } else if (e.type === 'relation' && t.building) {
      const von = stitch(e.members.filter((m) => m.geometry && m.role !== 'inner').map((m) => line(m.geometry)));
      const dnu = stitch(e.members.filter((m) => m.geometry && m.role === 'inner').map((m) => line(m.geometry)));
      for (const o of von) budovy.push({ type: 'Feature', id: budovy.length + 1, properties: tagy(e),
        geometry: { type: 'Polygon', coordinates: [o].concat(dnu.filter((d) => inRing(d[0], o))) } });
    }
  }
  const obrys = stitch(hrany);
  return { budovy: { type: 'FeatureCollection', features: budovy },
    hranica: { type: 'Feature', properties: {}, geometry: obrys.length ? { type: 'MultiPolygon', coordinates: obrys.map((r) => [r]) } : null },
    hrany: { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: hrany } } };
}
async function nacitajObec(obec) {
  if (S.data[obec.id]) return S.data[obec.id];
  const kluc = 'obec3d:v3:' + obec.id;
  let d = cache.get(kluc, 7 * 864e5);
  if (!d) { // predpripravený súbor (GitHub Actions), inak živý dopyt na Overpass
    try { const r = await fetchT(`data/${obec.id}.json`, {}, 20000); if (r.ok) d = osmNaGeoJSON(await r.json()); } catch (e) {}
    if (d && !d.budovy.features.length) d = null;
    if (d) cache.set(kluc, d);
  }
  if (!d) {
    const q = `[out:json][timeout:60];
relation[boundary=administrative][name="${obec.nazov}"]${OKOLIE}->.r;
.r out geom;
.r map_to_area->.a;
(way[building](area.a);relation[building](area.a););
out tags geom;`;
    d = osmNaGeoJSON(await overpass(q));
    if (d.budovy.features.length) cache.set(kluc, d);
  }
  return (S.data[obec.id] = d);
}
async function zobrazObec(obec) {
  S.obec = obec; zrusVyber(); zavriInfo();
  map.getSource('parcely').setData(prazdne()); S.parcely = null;
  if ($('fOn').checked) { $('fOn').checked = false; $('fBox').classList.add('off'); $('fStav').textContent = ''; }
  map.flyTo({ center: obec.stred, zoom: obec.zoom, pitch: 55, bearing: -15, duration: 1200 });
  stav('osm', '', 'Budovy OSM: načítavam…');
  try {
    const d = await nacitajObec(obec);
    if (S.obec !== obec) return;
    map.getSource('budovy').setData(d.budovy);
    map.getSource('hranica').setData(d.hrany);
    stav('osm', d.budovy.features.length ? 'ok' : 'warn', `Budovy OSM: ${d.budovy.features.length}`);
    if (d.hranica.geometry) {
      const b = bboxOf(d.hranica.geometry);
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, pitch: 55, bearing: -15, duration: 1000, maxZoom: 16 });
    }
  } catch (e) {
    console.error(e); stav('osm', 'bad', 'Budovy OSM: Overpass API neodpovedá');
    toast('Budovy sa nepodarilo načítať (Overpass API). Skúste to neskôr.');
  }
}

// ---------------------------------------------------------------- parcely (vektor)
// Zjednotenie atribútov z rôznych služieb. Polia s menami/vlastníkmi sa zámerne nepreberajú.
function normalizuj(a, register, geom) {
  const kluce = Object.keys(a).map((k) => [k.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), k]);
  const najdi = (re, zakaz) => { for (const [n, k] of kluce) if (re.test(n) && !(zakaz && zakaz.test(n)) && a[k] != null && a[k] !== '' && a[k] !== 'Null') return a[k]; return null; };
  const p = { register: register.toUpperCase() };
  p.cislo = najdi(/^(parcel_?(number|no)|no|parcelne_cislo|cislo_parcely|cislo|label)$/) ?? najdi(/parcel.*(num|no|cis)|cislo.*parc/, /id|folio|unit|lv/);
  const ref = najdi(/nationalcadastralreference/);
  if (ref && !p.cislo) p.cislo = String(ref).split(/[.\-_ ]/).pop();
  p.ku = najdi(/^(cadastral_?unit_?code|ku_?code|kod_?ku|ku|cislo_ku)$/) ?? najdi(/cadastral.*code|zoning.*code|kod.*(ku|katastr)/);
  if (!p.ku && ref) { const m = String(ref).match(/(?:^|\D)(8\d{5})(?:\D|$)/); if (m) p.ku = m[1]; }
  p.kuNazov = najdi(/^(cadastral_?unit(_?name)?|katastralne_uzemie|nazov_ku)$/);
  p.lv = najdi(/^(folio_?(number|no)?|lv|cislo_?lv|list_?vlastnictva|cislo_listu_vlastnictva)$/) ?? najdi(/folio.*(num|no)|_lv$|^lv_|list.*vlast/, /id$/);
  let druh = najdi(/^(kind|druh|druh_?pozemku|land_?(use|kind)|nature)(_?(name|code))?$/) ?? najdi(/kind|druh.*poz/, /id$/);
  if (druh != null && DRUHY[+druh]) druh = DRUHY[+druh];
  p.druh = druh == null ? null : String(druh).toLowerCase();
  const vym = najdi(/^(area|areavalue|vymera|parcel_?area)$/) ?? najdi(/area|vymer/, /shape|st_?area|len/);
  const vymN = vym == null ? NaN : parseFloat(String(vym).replace(/\s/g, '').replace(',', '.'));
  p.vymera = isNaN(vymN) ? null : vymN;
  if (p.vymera == null && geom) { p.vymera = Math.round(areaM2(geom)); p.vymeraOdhad = true; }
  for (const k of Object.keys(p)) if (p[k] == null) delete p[k];
  return p;
}
async function wfsTyp(reg) {
  const P = PARCELY[reg];
  if (!P.overene) {
    P.overene = true;
    try {
      const x = await (await fetchT(P.wfs + '?service=WFS&version=2.0.0&request=GetCapabilities', {}, 15000)).text();
      const m = [...x.matchAll(/<Name>([^<]*CadastralParcel[^<]*)<\/Name>/g)].map((y) => y[1]);
      if (m.length && !m.includes(P.typ)) P.typ = m[0];
    } catch (e) {}
  }
  return P.typ;
}
async function wfsQuery(reg, bbox, count) {
  const q = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: await wfsTyp(reg), srsName: 'EPSG:4326',
    outputFormat: 'application/json', count: String(count), bbox: [bbox[1], bbox[0], bbox[3], bbox[2]].join(',') + ',urn:ogc:def:crs:EPSG::4326' });
  const r = await fetchT(PARCELY[reg].wfs + '?' + q, {}, 40000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return { exceeded: (j.features || []).length >= count, features: (j.features || []).filter((f) => f.geometry).map((f) => {
    const g = { type: f.geometry.type, coordinates: fixOrder(f.geometry.coordinates) };
    return { type: 'Feature', id: f.id, properties: normalizuj(f.properties || {}, reg, g), geometry: g };
  }) };
}
// Doplnenie LV a druhu pozemku cez WMS GetFeatureInfo katastra. Preberajú sa len údaje o parcele.
async function doplnInfo(reg, p, ll) {
  const k = S.rastre[reg] === undefined ? await vyberRaster(reg) : S.rastre[reg];
  if ((p.lv && p.druh) || !k || !k.caps || !k.vrstvy) return p;
  try {
    const R = 20037508.342789244, x = (ll.lng * R) / 180, y = (Math.log(Math.tan(((90 + ll.lat) * Math.PI) / 360)) * R) / Math.PI, d = 15;
    const q = `service=WMS&version=1.3.0&request=GetFeatureInfo&styles=&crs=EPSG:3857&bbox=${x - d},${y - d},${x + d},${y + d}&width=101&height=101&i=50&j=50` +
      `&layers=${encodeURIComponent(k.vrstvy)}&query_layers=${encodeURIComponent(k.vrstvy)}&feature_count=20&info_format=text/xml`;
    const r = await fetchT(k.caps + '?' + q, {}, 12000);
    if (!r.ok) return p;
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    for (const el of xml.getElementsByTagName('*')) {
      if (!el.attributes.length || el.children.length) continue;
      const a = {}; for (const at of el.attributes) a[at.name] = at.value;
      const n = normalizuj(a, reg);
      if (n.cislo && p.cislo && String(n.cislo) !== String(p.cislo)) continue; // iná parcela
      for (const f of ['cislo', 'lv', 'druh', 'ku', 'kuNazov']) if (p[f] == null && n[f] != null) p[f] = n[f];
      if (n.vymera != null && (p.vymera == null || p.vymeraOdhad)) { p.vymera = n.vymera; delete p.vymeraOdhad; }
    }
  } catch (e) { /* služba nedostupná – ponecháme, čo máme */ }
  return p;
}
async function parcelaVBode(reg, ll) {
  const p = [ll.lng, ll.lat], d = 0.0003;
  const r = await wfsQuery(reg, [p[0] - d, p[1] - d, p[0] + d, p[1] + d], 300);
  return r.features.find((f) => inGeom(p, f.geometry)) || null;
}
async function nacitajParcelyObce() {
  if (S.parcely) return S.parcely;
  const d = await nacitajObec(S.obec), hr = d.hranica.geometry;
  if (!hr) throw new Error('Chýba hranica obce');
  const b = bboxOf(hr); let feats = [];
  const zdroj = 'INSPIRE WFS';
  const N = 4, dx = (b[2] - b[0]) / N, dy = (b[3] - b[1]) / N; // po dlaždiciach, aby sme neprekročili limit služby
  const dlazdice = []; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) dlazdice.push([b[0] + i * dx, b[1] + j * dy, b[0] + (i + 1) * dx, b[1] + (j + 1) * dy]);
  let hotovo = 0;
  const jedna = async (bb, hlbka = 0) => {
    const r = await wfsQuery('c', bb, 2000);
    if (r.exceeded && hlbka < 4) { // rozdeliť na štvrtiny
      const mx = (bb[0] + bb[2]) / 2, my = (bb[1] + bb[3]) / 2;
      for (const q of [[bb[0], bb[1], mx, my], [mx, bb[1], bb[2], my], [bb[0], my, mx, bb[3]], [mx, my, bb[2], bb[3]]]) await jedna(q, hlbka + 1);
    } else feats = feats.concat(r.features);
  };
  for (const bb of dlazdice) { await jedna(bb); $('fStav').textContent = `Načítavam parcely… ${Math.round((++hotovo / dlazdice.length) * 100)} %`; }
  // odstrániť duplicity a parcely mimo obce, vyznačiť zastavanosť
  const videne = new Set(), stredy = d.budovy.features.map((f) => centroid(f.geometry.coordinates[0]));
  feats = feats.filter((f) => {
    const k = f.id ?? (f.properties.ku + '/' + f.properties.cislo + '/' + f.properties.vymera); if (videne.has(k)) return false; videne.add(k);
    return inGeom(centroid(polys(f.geometry)[0][0]), hr);
  });
  feats.forEach((f, i) => {
    f.id = i + 1; const bb = bboxOf(f.geometry);
    const maBudovu = stredy.some((c) => c[0] >= bb[0] && c[0] <= bb[2] && c[1] >= bb[1] && c[1] <= bb[3] && inGeom(c, f.geometry));
    f.properties.zastavana = maBudovu || /zastavan/.test(f.properties.druh || '');
    f.properties.vymera = f.properties.vymera ?? 0;
  });
  return (S.parcely = { zdroj, fc: { type: 'FeatureCollection', features: feats } });
}
function pouziFilter() {
  if (!S.parcely) return;
  const f = ['all'], druh = $('fDruh').value, mn = parseFloat($('fMin').value), mx = parseFloat($('fMax').value);
  if ($('fVolne').checked) f.push(['!=', ['get', 'zastavana'], true]);
  if (druh) f.push(['==', ['get', 'druh'], druh]);
  if (mn > 0) f.push(['>=', ['get', 'vymera'], mn]);
  if (mx > 0) f.push(['<=', ['get', 'vymera'], mx]);
  map.setFilter('parcely-fill', f); map.setFilter('parcely-line', f);
  const n = S.parcely.fc.features.filter((x) => {
    const p = x.properties;
    return !($('fVolne').checked && p.zastavana) && !(druh && p.druh !== druh) && !(mn > 0 && p.vymera < mn) && !(mx > 0 && p.vymera > mx);
  }).length;
  $('fStav').textContent = `Vyhovuje ${n} z ${S.parcely.fc.features.length} parciel (zdroj: ${S.parcely.zdroj}).`;
}
async function zapniFilter(on) {
  $('fBox').classList.toggle('off', !on);
  for (const id of ['parcely-fill', 'parcely-line']) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  if (!on) return;
  try {
    $('fStav').textContent = 'Načítavam parcely…';
    const p = await nacitajParcelyObce();
    map.getSource('parcely').setData(p.fc);
    const druhy = [...new Set(p.fc.features.map((f) => f.properties.druh).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'sk'));
    $('fDruh').innerHTML = '<option value="">všetky</option>' + druhy.map((d) => `<option>${esc(d)}</option>`).join('');
    $('fDruh').disabled = !druhy.length;
    if (!druhy.length) $('fDruh').title = 'Služba neposkytla druh pozemku';
    pouziFilter();
  } catch (e) {
    console.error(e); $('fStav').textContent = 'Parcely sa nepodarilo načítať – katastrálna služba neodpovedá prehliadaču.';
  }
}

// ---------------------------------------------------------------- klik a informačný panel
function zrusVyber() {
  map.getSource('vyber').setData(prazdne());
  if (S.vybranaBudova != null) map.setFeatureState({ source: 'budovy', id: S.vybranaBudova }, { sel: false });
  S.vybranaBudova = null;
}
function zavriInfo() { $('info').hidden = true; }
function odkazy(p, ll) {
  const z = p && p.ku && p.cislo
    ? `https://zbgis.skgeodesy.sk/mapka/sk/kataster/detail/kataster/parcela-${p.register === 'E' ? 'e' : 'c'}/${encodeURIComponent(p.ku)}/${encodeURIComponent(p.cislo)}`
    : `https://zbgis.skgeodesy.sk/mapka/sk/kataster?pos=${ll.lat.toFixed(6)},${ll.lng.toFixed(6)},19`;
  return `<div class="links"><a href="https://www.katasterportal.sk/kapor/" target="_blank" rel="noopener">katasterportal.sk</a>
    <a href="${z}" target="_blank" rel="noopener">Detail v ZBGIS</a></div>`;
}
function htmlParcela(p) {
  if (!p) return '<p class="muted">Údaje o parcele sa nepodarilo získať – katastrálna služba neodpovedá prehliadaču. Použite odkazy nižšie.</p>';
  const r = [['Register', p.register], ['Katastrálne územie', [p.kuNazov, p.ku].filter(Boolean).join(' · ') || '—'],
    ['List vlastníctva', p.lv ?? '—'], ['Druh pozemku', p.druh ?? '—'], ['Výmera', fmtM2(p.vymera) + (p.vymeraOdhad ? ' (z kresby)' : '')]];
  return `<h3>Parcela ${esc(p.cislo ?? '—')}</h3><dl>${r.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}
function htmlBudova(b) {
  const cislo = b['addr:conscriptionnumber'] || b['addr:housenumber'];
  const adresa = [b['addr:street'], b['addr:streetnumber'] || (b['addr:conscriptionnumber'] ? b['addr:housenumber'] : null)].filter(Boolean).join(' ');
  const r = [['Súpisné č.', cislo], ['Adresa', adresa], ['Názov', b.name], ['Typ', b.building !== 'yes' ? b.building : null],
    ['Podlažia', b['building:levels']], ['Výška v modeli', b.h + ' m']].filter((x) => x[1]);
  return `<h4>Dom (OpenStreetMap)</h4><dl>${r.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}
let klikN = 0;
async function naKlik(e) {
  const n = ++klikN, ll = e.lngLat;
  zrusVyber();
  const bud = map.queryRenderedFeatures(e.point, { layers: ['budovy'] })[0];
  const lok = $('fOn').checked ? map.queryRenderedFeatures(e.point, { layers: ['parcely-fill'] })[0] : null;
  if (bud) { S.vybranaBudova = bud.id; map.setFeatureState({ source: 'budovy', id: bud.id }, { sel: true }); }
  const hlava = bud ? htmlBudova(bud.properties) : '';
  $('infoBody').innerHTML = '<p class="muted">Zisťujem parcelu…</p>' + hlava; $('info').hidden = false;

  let f = null, reg = 'c';
  if (lok && S.parcely) f = S.parcely.fc.features.find((x) => x.id === lok.id);
  try {
    if (!f) f = await parcelaVBode('c', ll);
    if (!f && $('lyrE').checked) { f = await parcelaVBode('e', ll); reg = 'e'; }
  } catch (err) { console.warn(err); }
  if (n !== klikN) return;
  let p = null;
  if (f) { map.getSource('vyber').setData(f); p = await doplnInfo(reg, { ...f.properties }, ll); if (n !== klikN) return; }
  let eHtml = '';
  if (f && reg === 'c' && $('lyrE').checked) {
    try { const fe = await parcelaVBode('e', ll); if (fe && n === klikN) eHtml = htmlParcela(await doplnInfo('e', { ...fe.properties }, ll)).replace('<h3>', '<h4>Register E</h4><h3>'); } catch (err) {}
  }
  if (n !== klikN) return;
  $('infoBody').innerHTML = htmlParcela(p) + hlava + eHtml + odkazy(p, ll);
}

// ---------------------------------------------------------------- ovládanie
function init() {
  const sel = $('obec');
  sel.innerHTML = OBCE.map((o) => `<option value="${o.id}">${esc(o.nazov)}</option>`).join('');
  const zHash = OBCE.find((o) => o.id === location.hash.slice(1));
  if (zHash) sel.value = zHash.id;
  sel.onchange = () => { const o = OBCE.find((x) => x.id === sel.value); history.replaceState(null, '', '#' + o.id); zobrazObec(o); };

  $('btnPanel').onclick = () => { const p = $('panel'); p.hidden = !p.hidden; $('btnPanel').setAttribute('aria-expanded', String(!p.hidden)); };
  $('infoClose').onclick = () => { zavriInfo(); zrusVyber(); };
  document.querySelectorAll('input[name=base]').forEach((r) => (r.onchange = () => prepniPodklad(r.value)));
  $('lyrBudovy').onchange = (e) => map.setLayoutProperty('budovy', 'visibility', e.target.checked ? 'visible' : 'none');
  $('lyrHranica').onchange = (e) => map.setLayoutProperty('hranica', 'visibility', e.target.checked ? 'visible' : 'none');
  $('lyrC').onchange = (e) => zapniRaster('c', e.target.checked);
  $('lyrE').onchange = (e) => zapniRaster('e', e.target.checked);
  $('fOn').onchange = (e) => zapniFilter(e.target.checked);
  for (const id of ['fVolne', 'fDruh', 'fMin', 'fMax']) $(id).oninput = pouziFilter;

  for (const id of ['parcely-fill', 'parcely-line']) map.setLayoutProperty(id, 'visibility', 'none');
  map.on('click', naKlik);
  map.on('mouseenter', 'budovy', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'budovy', () => (map.getCanvas().style.cursor = ''));

  prepniPodklad('orto');
  zapniRaster('c', true);
  zobrazObec(zHash || OBCE[0]);
}
map.on('load', init);
