#!/usr/bin/env bash
# Sonda: overí dostupnosť a štruktúru verejných služieb (ÚGKK, ZBGIS, Overpass).
set +e
O="Origin: https://peterzahumensky11-cmd.github.io"
g(){ curl -sS -m 12 -H "$O" -A "obce3d-probe/1.0" "$@"; }
hdr(){ echo; echo "######## $1"; }
cors(){ echo "-- CORS/status $1"; curl -sS -m 12 -o /dev/null -D - -H "$O" -A "obce3d-probe/1.0" "$1" | grep -iE "^HTTP|access-control|content-type" ; }

hdr "OVERPASS obce"
g "https://overpass-api.de/api/interpreter" --data-urlencode 'data=[out:json][timeout:60];relation[boundary=administrative][name~"^(Sokoľ|Kostoľany nad Hornádom|Družstevná pri Hornáde)$"](48.70,21.10,48.90,21.40);out tags bb;' | head -c 3000
cors "https://overpass-api.de/api/status"

for d in "" "/VRM" "/NR"; do hdr "REST dir $d"; g "https://kataster.skgeodesy.sk/eskn/rest/services$d?f=json" | head -c 2500; done

for s in VRM/parcels_c_view VRM/parcels_e_view NR/kn_wms_norm NR/uo_wms_norm; do
  hdr "REST $s"; g "https://kataster.skgeodesy.sk/eskn/rest/services/$s/MapServer?f=json" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin); print({k:d.get(k) for k in ["capabilities","maxRecordCount","supportedQueryFormats"]}); print(d.get("spatialReference")); print([(l["id"],l["name"],l.get("minScale"),l.get("maxScale")) for l in d.get("layers",[])]); print(d.get("error"))
except Exception as e: print("ERR",e)'
done
for s in VRM/parcels_c_view VRM/parcels_e_view; do for l in 0 1; do
  hdr "FIELDS $s/$l"; g "https://kataster.skgeodesy.sk/eskn/rest/services/$s/MapServer/$l?f=json" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin); print(d.get("name"),d.get("geometryType"),d.get("minScale"),d.get("maxScale")); print([(f["name"],f["type"].replace("esriFieldType","")) for f in (d.get("fields") or [])]); print(d.get("error"))
except Exception as e: print("ERR",e)'
done; done
BB="21.213,48.814,21.220,48.819"
for s in VRM/parcels_c_view VRM/parcels_e_view; do
  hdr "QUERY $s json"; g "https://kataster.skgeodesy.sk/eskn/rest/services/$s/MapServer/0/query?where=1%3D1&geometry=$BB&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=false&resultRecordCount=3&f=json" | head -c 2500
  hdr "QUERY $s geojson"; g "https://kataster.skgeodesy.sk/eskn/rest/services/$s/MapServer/0/query?where=1%3D1&geometry=$BB&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326&resultRecordCount=1&f=geojson" | head -c 1500
  hdr "COUNT $s"; g "https://kataster.skgeodesy.sk/eskn/rest/services/$s/MapServer/0/query?where=1%3D1&geometry=$BB&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&returnCountOnly=true&f=json" | head -c 300
done
cors "https://kataster.skgeodesy.sk/eskn/rest/services/VRM/parcels_c_view/MapServer?f=json"

hdr "ODATA metadata"
g 'https://kataster.skgeodesy.sk/PortalOData/$metadata' > /tmp/md.xml; wc -c /tmp/md.xml
python3 - <<'PY'
import re
x=open('/tmp/md.xml',encoding='utf-8',errors='replace').read()
print(x[:300])
print(re.findall(r'<EntitySet Name="([^"]+)"',x)[:80])
for t in ["ParcelC","ParcelE","Folio","CadastralUnit","Kind","LandUse","Utilisation"]:
    m=re.search(r'<EntityType Name="%s".*?</EntityType>'%t,x,re.S)
    if m: print(t, re.findall(r'<(?:Navigation)?Property Name="([^"]+)" Type="([^"]+)"',m.group(0)))
PY
hdr "ODATA sample"
g 'https://kataster.skgeodesy.sk/PortalOData/ParcelsC?$top=2&$select=Id,No,Area&$expand=Kind($select=Name,Code),Folio($select=No),CadastralUnit($select=Name,Code)' | head -c 2000
hdr "ODATA cadastral units"
g "https://kataster.skgeodesy.sk/PortalOData/CadastralUnits?\$filter=Name%20eq%20%27Soko%C4%BE%27%20or%20startswith(Name,%27Kosto%C4%BEany%20nad%27)%20or%20Name%20eq%20%27Mal%C3%A1%20Vieska%27%20or%20Name%20eq%20%27Tepli%C4%8Dany%27" | head -c 2500
cors 'https://kataster.skgeodesy.sk/PortalOData/CadastralUnits?$top=1'

caps(){ hdr "CAPS $1"; g "$1" > /tmp/c.xml; wc -c /tmp/c.xml; python3 - <<'PY'
import re
x=open('/tmp/c.xml',encoding='utf-8',errors='replace').read()
print(x[:200].replace("\n"," "))
print("names",re.findall(r'<(?:\w+:)?Name>([^<]+)</',x)[:60])
print("titles",re.findall(r'<(?:\w+:)?Title>([^<]+)</',x)[:40])
print("ids",re.findall(r'<ows:Identifier>([^<]+)</',x)[:40])
crs=set(re.findall(r'<(?:CRS|SRS|DefaultCRS|ows:SupportedCRS)>([^<]+)</',x)); print("crs",[c for c in crs if any(k in c for k in("3857","4326","5514","900913","CRS:84"))])
print("formats",sorted(set(re.findall(r'<(?:\w+:)?Format>([^<]+)</',x)))[:40])
print("outfmt",sorted(set(re.findall(r'<ows:Value>([^<]*(?:json|gml)[^<]*)</',x,re.I)))[:20])
print("tpl",re.findall(r'template="([^"]+)"',x)[:5])
PY
}
caps "https://kataster.skgeodesy.sk/eskn/services/NR/kn_wms_norm/MapServer/WmsServer?service=WMS&version=1.3.0&request=GetCapabilities"
caps "https://kataster.skgeodesy.sk/eskn/services/NR/uo_wms_norm/MapServer/WmsServer?service=WMS&version=1.3.0&request=GetCapabilities"
caps "https://zbgisws.skgeodesy.sk/zbgis_ortofoto_wms/service.svc/get?service=WMS&version=1.3.0&request=GetCapabilities"
caps "https://zbgisws.skgeodesy.sk/zbgis_ortofoto_wmts/service.svc/get?service=WMTS&request=GetCapabilities"
caps "https://inspirews.skgeodesy.sk/geoserver/cp/ows?service=WMS&version=1.3.0&request=GetCapabilities"
caps "https://inspirews.skgeodesy.sk/geoserver/cp_uo/ows?service=WMS&version=1.3.0&request=GetCapabilities"
caps "https://inspirews.skgeodesy.sk/geoserver/cp/ows?service=WFS&version=2.0.0&request=GetCapabilities"
caps "https://inspirews.skgeodesy.sk/geoserver/cp_uo/ows?service=WFS&version=2.0.0&request=GetCapabilities"

hdr "WFS sample json"
g "https://inspirews.skgeodesy.sk/geoserver/cp/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=cp:CadastralParcel&count=1&srsName=EPSG:4326&bbox=48.814,21.213,48.819,21.220,urn:ogc:def:crs:EPSG::4326&outputFormat=application/json" | head -c 2500
hdr "WFS sample gml"
g "https://inspirews.skgeodesy.sk/geoserver/cp/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=cp:CadastralParcel&count=1&srsName=EPSG:4326&bbox=48.814,21.213,48.819,21.220,urn:ogc:def:crs:EPSG::4326" | head -c 3500

hdr "CORS"
cors "https://zbgisws.skgeodesy.sk/zbgis_ortofoto_wms/service.svc/get?service=WMS&version=1.3.0&request=GetMap&layers=1&styles=&crs=EPSG:3857&bbox=2361000,6243000,2361600,6243600&width=256&height=256&format=image/jpeg"
cors "https://zbgisws.skgeodesy.sk/zbgis_ortofoto_wmts/service.svc/get?service=WMTS&request=GetCapabilities"
cors "https://ofmozaika.tiles.freemap.sk/16/36630/22467.jpg"
cors "https://kataster.skgeodesy.sk/eskn/services/NR/kn_wms_norm/MapServer/WmsServer?service=WMS&version=1.3.0&request=GetCapabilities"
cors "https://kataster.skgeodesy.sk/eskn/rest/services/NR/kn_wms_norm/MapServer/export?bbox=2361000,6243000,2361600,6243600&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image"
cors "https://inspirews.skgeodesy.sk/geoserver/cp/ows?service=WMS&version=1.3.0&request=GetMap&layers=CP.CadastralParcel&styles=&crs=EPSG:3857&bbox=2361000,6243000,2361600,6243600&width=256&height=256&format=image/png&transparent=true"
cors "https://inspirews.skgeodesy.sk/geoserver/cp/ows?service=WFS&version=2.0.0&request=GetCapabilities"
echo; echo DONE
