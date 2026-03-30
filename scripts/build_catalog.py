#!/usr/bin/env python3
"""
Build catalog.json for the Balloon Strain Lab app.
Scans balloons/ for manifest.yaml files and generates catalog.json.

Usage:
    python scripts/build_catalog.py
"""

import json
import sys
from pathlib import Path

import yaml


def main():
    repo = Path(__file__).resolve().parent.parent
    balloons_dir = repo / "balloons"
    out_dir = repo

    entries = []

    for manifest_path in sorted(balloons_dir.glob("*/manifest.yaml")):
        slug = manifest_path.parent.name
        if slug.startswith("_"):
            continue  # skip templates

        try:
            with open(manifest_path) as f:
                data = yaml.safe_load(f)
        except Exception as e:
            print(f"  ⚠ Failed to parse {manifest_path}: {e}")
            continue

        if not data:
            continue

        bdir = manifest_path.parent

        # Check for viewer data
        viewer_dir = bdir / "viewer"
        has_viewer = (viewer_dir / "frame_index.json").exists() or (viewer_dir / "strain_frames.json").exists()
        has_mesh = (viewer_dir / "mesh.json").exists()
        has_per_frame = (viewer_dir / "frames").is_dir()

        entry = {
            "slug": slug,
            "title": data.get("title", slug),
            "balloon": data.get("balloon", {}),
            "test": data.get("test", {}),
            "results": data.get("results", {}),
            "methods": data.get("methods", ""),
            "conclusions": data.get("conclusions", ""),
            "media": data.get("media", {}),
            "tags": data.get("tags", []),
            "has_viewer": has_viewer,
            "has_mesh": has_mesh,
            "has_per_frame": has_per_frame,
        }

        entries.append(entry)
        print(f"  ✓ {slug} (viewer={has_viewer}, mesh={has_mesh}, per_frame={has_per_frame})")

    catalog = {
        "count": len(entries),
        "balloons": entries,
    }

    out_path = out_dir / "catalog.json"
    with open(out_path, "w") as f:
        json.dump(catalog, f, indent=2, default=str)

    print(f"\n✓ catalog.json written: {len(entries)} balloons → {out_path}")


if __name__ == "__main__":
    main()
