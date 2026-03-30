# 🎈 Balloon Catalog

Open catalog of balloon inflation tests with stereo-vision surface strain analysis and interactive CesiumJS visualization.

**[View the live catalog →](https://stratosonde.github.io/balloon-catalog/)**

## What is this?

This repository contains:
- **Balloon test results** — pressure, diameter, strain, creep metrics, and burst data
- **Analysis plots** — pressure vs. time, diameter vs. pressure, strain heatmaps, and more
- **3D CesiumJS viewer** — interactive surface mesh with per-vertex strain colouring
- **Comparison table** — sortable data across all tested balloons

Each balloon test lives in its own directory under `balloons/`, following a standard manifest format. Adding a new test entry automatically updates the website.

## Repository Structure

```
balloon-catalog/
├── balloons/                     # Catalog entries (one dir per test)
│   ├── _template/                # Template for new entries
│   │   └── manifest.yaml
│   ├── 2026-02-23_test-session/  # Example entry
│   │   ├── manifest.yaml         # Balloon specs, results, conclusions
│   │   ├── plots/                # Analysis plots (PNG, GIF)
│   │   ├── viewer/               # CesiumJS 3D data (JSON)
│   │   ├── data/                 # CSV/JSON data tables
│   │   ├── images/               # Photos
│   │   └── video/                # Burst video
│   └── README.md
├── site/                         # Static CesiumJS website
│   ├── index.html
│   ├── css/style.css
│   └── js/                       # catalog.js, cesium-viewer.js, plots.js, app.js
├── scripts/
│   ├── build_catalog.py          # Builds site/catalog.json from balloons/
│   └── validate_balloon.py       # Validates catalog entries
├── .github/workflows/
│   └── deploy-pages.yml          # Auto-deploy to GitHub Pages
└── Makefile
```

## Adding a New Balloon Test

### 1. Create the entry

Use the companion analysis tool (`balloon-analyzer`) to run the analysis, then export:

```bash
# In the balloon-analyzer repo
python scripts/export_balloon.py \
    --analysis_dir /path/to/analysis \
    --run_dir /path/to/session \
    --name "2026-03-15_brand-x-16in" \
    --out /path/to/balloon-catalog/balloons/2026-03-15_brand-x-16in/
```

Or manually: copy `balloons/_template/` to a new directory and fill in `manifest.yaml`.

### 2. Edit the manifest

Fill in balloon specs, test conditions, and conclusions in `manifest.yaml`:

```yaml
title: "Brand X 16in Latex — March 15"
balloon:
  brand: "Brand X"
  model: "16in Standard"
  material: "natural latex"
  color: "red"
  weight_g: 45
test:
  date: "2026-03-15"
  protocol: "constant-rate inflation"
results:
  burst_pressure_kpa: 12.5
  max_diameter_mm: 380.0
conclusions: |
  Burst occurred at 12.5 kPa after 3 observable strain plateaus.
  Peak areal strain reached 15% near the equator before failure.
tags: [latex, 16in, burst-test]
```

### 3. Build and preview

```bash
make build     # Generates site/catalog.json + copies assets
make serve     # Preview at http://localhost:8000
make validate  # Check all entries for completeness
```

### 4. Push to GitHub

Push to `main` and GitHub Actions will automatically rebuild and deploy to Pages.

## Analysis Pipeline

Test entries are produced by **balloon-analyzer**, a stereo-vision analysis pipeline that performs marker detection, 3D tracking, surface strain computation (Green–Lagrange), and creep metrics. The analyzer exports results directly into the catalog format used by this repo.

## Site Features

- **Sidebar catalog** — searchable, filterable by tags
- **Overview tab** — balloon specs, test results, conclusions, methods
- **Plots tab** — all analysis plots with click-to-zoom lightbox
- **3D Viewer tab** — CesiumJS mesh with frame scrubbing, strain colormap, camera controls
- **Data tab** — plateau summary table, analysis config
- **Comparison table** — sortable across all balloons

## License

Apache License 2.0 — see [LICENSE](LICENSE).
