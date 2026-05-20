# ZIP Location Dataset — Source Data

`data/zip_locations.csv` is built by `scripts/build-zip-dataset.ts` from the
three public inputs below. The raw source files live in this directory (`data/sources/`)
and are gitignored; only the joined output CSV is committed.

---

## 1. USDA Plant Hardiness Zone Map (2023)

**Source:** phzmapi.org (S3-hosted mirror of USDA 2023 PHZM data)
**URL pattern:** `https://phzmapi.org/{zip}.json`
**Access:** Public S3 bucket — one JSON file per ZIP code, fetched concurrently.
**License:** USDA public data; mirror maintained by the open-source community.
**Columns used:** `zone` (e.g. `7a`), `coordinates.lat`, `coordinates.lon`

The USDA Plant Hardiness Zone Map uses 30-year temperature averages (1991–2020)
to assign zones based on average annual extreme minimum temperature. Published 2023.
Official source: https://planthardiness.ars.usda.gov/

---

## 2. US Census ZCTA Gazetteer (2024)

**Source:** US Census Bureau — Gazetteer Files, 2024 ZCTA
**Download URL:** `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip`
**Local file:** `data/sources/2024_Gaz_zcta_national.txt` (tab-delimited)
**License:** US Government public domain.
**Columns used:**
- `GEOID` — the ZCTA (5-digit ZIP code equivalent)
- `INTPTLAT` — internal point latitude (decimal degrees)
- `INTPTLONG` — internal point longitude (decimal degrees)

Used as the authoritative list of valid US ZCTAs and as a lat/lon fallback
when phzmapi.org coordinate data is unavailable.

---

## 3. Frost Date Climatology

**Source:** NOAA Climate Normals (1991–2020) + USDA zone boundary literature.
**Method:** Zone → frost date lookup table (`ZONE_FROST_FALLBACK` in the build script).

A per-ZIP NOAA freeze/frost climatology dataset was not readily available as a
clean bulk CSV. Instead, the build script uses a static lookup table that maps
each USDA hardiness zone to approximate average last/first frost dates derived
from NOAA's published 1991–2020 climate normals and standard horticultural
references. These are zone-level estimates — accurate to within ~1–2 weeks for
most locations.

NOAA Climate Normals reference: https://www.ncei.noaa.gov/products/land-based-station/us-climate-normals

---

## Re-building the dataset

```bash
# Download the Census Gazetteer
curl -L -o data/sources/zcta_gazetteer.zip \
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip"
cd data/sources && unzip -o zcta_gazetteer.zip && cd ../..

# Run the build script (fetches USDA zones from phzmapi.org)
bun run scripts/build-zip-dataset.ts
# OR:
bun run build:zip-dataset
```
