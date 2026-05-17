#!/usr/bin/env python3
"""
Build catalog.json for the Balloon Strain Lab app.

Scans balloons/ for manifest.yaml files and generates catalog.json.

In addition to the raw manifest fields, this script computes a `derived`
block for each balloon containing performance metrics used by the index
comparison table:

  • Diameter / height at a reference differential pressure (0.2 psi).
  • Inflated volume (oblate ellipsoid).
  • Gross & free lift at sea level assuming H₂ fill.
  • Maximum float altitude (zero payload) using ISA-1976.
  • Float altitude at a standard payload (20 g).
  • Payload capacity at 90 % of the maximum float altitude.

Constants (assumptions, surfaced in the catalog and as UI tooltips):
  Gas:                H₂   (M = 2.016 g/mol)
  Reference Δp:       0.20 psi
  Standard payload:   20   g
  Atmosphere model:   ISA-1976 (troposphere 0-11 km, stratosphere 11-25 km)

Usage:
    python scripts/build_catalog.py
"""

from __future__ import annotations

import csv
import json
import math
import re
import sys
from pathlib import Path

import yaml


# ─── Constants ─────────────────────────────────────────────────────────────
REF_PRESSURE_PSI = 0.20
REF_PRESSURE_BAND = 0.02              # ± window for sampling diameter/height
STD_PAYLOAD_G = 20.0
PAYLOAD_ALT_FRACTION = 0.90           # fraction of h_max at which to report payload
INCH_TO_M = 0.0254

# Gas masses (g/mol)
M_AIR = 28.9647
M_H2 = 2.016
# Density factor for H₂ in air: lift ≈ V × ρ_air × (1 − M_H2/M_air)
LIFT_FACTOR_H2 = 1.0 - M_H2 / M_AIR   # ≈ 0.9304

# ISA-76 sea-level reference values
T0_K = 288.15
P0_PA = 101325.0
R_AIR = 287.058                       # J/(kg·K)
G0 = 9.80665                          # m/s²
LAPSE_TROP = 0.0065                   # K/m (0–11 km)
TROPOPAUSE_KM = 11.0
T_STRAT_K = 216.65
P_TROPOPAUSE_PA = P0_PA * (T_STRAT_K / T0_K) ** (G0 / (LAPSE_TROP * R_AIR))


# ─── ISA-76 atmosphere ─────────────────────────────────────────────────────
def isa_density_kgm3(h_km: float) -> float:
    """Air density (kg/m³) at altitude h_km using ISA-1976, valid 0–25 km."""
    if h_km < 0:
        h_km = 0.0
    if h_km <= TROPOPAUSE_KM:
        T = T0_K - LAPSE_TROP * h_km * 1000.0
        P = P0_PA * (T / T0_K) ** (G0 / (LAPSE_TROP * R_AIR))
    else:
        T = T_STRAT_K
        P = P_TROPOPAUSE_PA * math.exp(-G0 * (h_km - TROPOPAUSE_KM) * 1000.0 / (R_AIR * T_STRAT_K))
    return P / (R_AIR * T)            # kg/m³


def isa_density_gL(h_km: float) -> float:
    """Air density expressed in g/L (numerically equal to kg/m³)."""
    return isa_density_kgm3(h_km)


def solve_float_altitude(volume_L: float, lifted_mass_g: float) -> float | None:
    """Find altitude (km) where V·ρ_air·LIFT_FACTOR_H2 = lifted_mass_g.

    Returns None if the balloon cannot lift this mass at any altitude
    (e.g. volume too small) or if the resulting altitude is out of range.
    """
    if volume_L is None or volume_L <= 0 or lifted_mass_g is None:
        return None
    # Required density (g/L). Lift = V × ρ × 0.9304 = lifted_mass.
    rho_required = lifted_mass_g / (volume_L * LIFT_FACTOR_H2)
    # Atmospheric density is monotonically decreasing. Bisect on h in [0, 30 km].
    rho_sl = isa_density_gL(0.0)
    if rho_required > rho_sl:
        return None  # balloon can't even lift this mass at sea level
    lo, hi = 0.0, 30.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        rho_mid = isa_density_gL(mid)
        if rho_mid > rho_required:
            lo = mid
        else:
            hi = mid
    h = 0.5 * (lo + hi)
    if h >= 29.9:                     # solver hit upper rail
        return None
    return h


def payload_at_altitude_g(volume_L: float, balloon_mass_g: float, h_km: float) -> float | None:
    """Useful payload (g) at altitude h_km given fixed balloon volume + mass."""
    if volume_L is None or balloon_mass_g is None:
        return None
    rho = isa_density_gL(h_km)
    gross = volume_L * rho * LIFT_FACTOR_H2
    return gross - balloon_mass_g


# ─── Extract size at reference pressure ────────────────────────────────────
def _median(values: list[float]) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return s[len(s) // 2]


def extract_ref_size(csv_path: Path) -> dict | None:
    """Read inflator_log.csv and return median diameter/height in a pressure
    band around the reference pressure (0.18–0.22 psi by default).

    Filters out unrealistic diameter readings (<10″ or >80″) which can occur
    during sensor startup. If no samples are found in the strict band, the
    function widens the band progressively to ±0.05 then ±0.10 psi as a
    fallback so we still report a meaningful "size near 0.2 psi" rather than
    failing entirely.

    Returns dict with diameter_in, height_in, n_samples, band_widened (bool),
    or None on failure.
    """
    if not csv_path.exists():
        return None

    bands_to_try = [
        (REF_PRESSURE_BAND, False),       # strict ±0.02 psi
        (0.05, True),                     # widen to ±0.05 psi
        (0.10, True),                     # widen to ±0.10 psi
        (0.15, True),                     # widen to ±0.15 psi (last resort)
    ]

    rows_cache: list[tuple[float, float, float | None]] = []  # (pressure, D, H)
    try:
        with open(csv_path, newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    pressure = float(row.get("pressure_psi") or "")
                    d = float(row.get("diameter_inches") or "")
                    if not (10.0 < d < 80.0):
                        continue
                except (TypeError, ValueError):
                    continue
                h_raw = row.get("height_inches")
                try:
                    h = float(h_raw) if h_raw else None
                    if h is not None and not (10.0 < h < 80.0):
                        h = None
                except (TypeError, ValueError):
                    h = None
                rows_cache.append((pressure, d, h))
    except Exception as e:
        print(f"  ⚠ Failed to read {csv_path}: {e}")
        return None

    if not rows_cache:
        return None

    for band, widened in bands_to_try:
        p_min, p_max = REF_PRESSURE_PSI - band, REF_PRESSURE_PSI + band
        diameters = [d for p, d, _ in rows_cache if p_min <= p <= p_max]
        heights   = [h for p, _, h in rows_cache if p_min <= p <= p_max and h is not None]
        if diameters:
            return {
                "diameter_in": round(_median(diameters), 3),
                "height_in":   round(_median(heights), 3) if heights else None,
                "n_samples":   len(diameters),
                "band_widened": widened,
                "band_psi":    band,
            }

    return None


# ─── Extract test conditions + plateau count from CSV ──────────────────────
_CYCLE_RE = re.compile(r"Cycle (\d+):")
_PRESSURIZE_RE = re.compile(r"PRESSURIZING to ([0-9.]+) PSI")


def extract_test_conditions(csv_path: Path) -> dict:
    """Median temperature/humidity/station-pressure + number of pressure cycles.

    Also extracts the last pressure plateau set-point from the inflator's
    `EVENT: Cycle N: PRESSURIZING to X.XXXX PSI` markers.  The raw
    `pressure_psi` maximum is dominated by transient pump spikes and is not a
    good representation of the test's actual peak hold pressure; the last
    PRESSURIZING event is the deliberate set-point of the final plateau.

    Used as fallback when those fields are missing from the manifest.
    """
    out = {
        "temperature_c": None,
        "humidity_pct": None,
        "station_pressure_hpa": None,
        "plateaus_detected": None,
        "last_plateau_psi": None,
    }
    if not csv_path.exists():
        return out

    temps: list[float] = []
    hums: list[float] = []
    sp: list[float] = []
    cycles: set[int] = set()
    last_setpoint: float | None = None

    try:
        with open(csv_path, newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                state = row.get("pump_state") or ""
                if "Cycle " in state:
                    m = _CYCLE_RE.search(state)
                    if m:
                        cycles.add(int(m.group(1)))
                    p = _PRESSURIZE_RE.search(state)
                    if p:
                        try:
                            last_setpoint = float(p.group(1))
                        except ValueError:
                            pass
                for col, bucket in (
                    ("ambient_temp_c", temps),
                    ("ambient_humidity_pct", hums),
                    ("station_pressure_hpa", sp),
                ):
                    try:
                        bucket.append(float(row.get(col) or ""))
                    except (TypeError, ValueError):
                        pass
    except Exception as e:
        print(f"  ⚠ Failed to read {csv_path}: {e}")
        return out

    if temps:
        out["temperature_c"] = round(_median(temps), 1)
    if hums:
        out["humidity_pct"] = round(_median(hums), 1)
    if sp:
        out["station_pressure_hpa"] = round(_median(sp), 1)
    if cycles:
        out["plateaus_detected"] = len(cycles)
    if last_setpoint is not None:
        out["last_plateau_psi"] = round(last_setpoint, 3)
    return out


# ─── Compute derived metrics ───────────────────────────────────────────────
def compute_derived(entry: dict, csv_path: Path) -> dict:
    """Compute the `derived` block for a balloon."""
    derived = {
        "ref_pressure_psi": REF_PRESSURE_PSI,
        "std_payload_g": STD_PAYLOAD_G,
        "payload_alt_fraction": PAYLOAD_ALT_FRACTION,
        "gas": "H2",
        "diameter_ref_in": None,
        "height_ref_in": None,
        "volume_ref_L": None,
        "gross_lift_g_sl": None,      # V × ρ_air × 0.9304 (buoyancy only)
        "free_lift_ratio": None,
        "max_alt_km": None,
        "alt_at_std_payload_km": None,
        "payload_at_90pct_hmax_g": None,
        "alt_at_90pct_hmax_km": None,
        "n_ref_samples": 0,
    }

    ref = extract_ref_size(csv_path)
    if ref is None:
        return derived

    d_in = ref["diameter_in"]
    h_in = ref["height_in"] if ref["height_in"] is not None else d_in
    derived["diameter_ref_in"] = d_in
    derived["height_ref_in"] = h_in
    derived["n_ref_samples"] = ref["n_samples"]

    # Volume of oblate ellipsoid: (π/6) D² H (in inches³ → litres)
    d_m = d_in * INCH_TO_M
    h_m = h_in * INCH_TO_M
    volume_m3 = (math.pi / 6.0) * (d_m ** 2) * h_m
    volume_L = volume_m3 * 1000.0
    derived["volume_ref_L"] = round(volume_L, 2)

    # Gross lift at sea level (g)
    rho_sl = isa_density_gL(0.0)      # ≈ 1.225 g/L
    gross_lift_g = volume_L * rho_sl * LIFT_FACTOR_H2
    derived["gross_lift_g_sl"] = round(gross_lift_g, 1)

    # Mass-dependent metrics — need balloon weight
    mass_g = entry.get("balloon", {}).get("weight_g")
    if mass_g is not None and mass_g > 0:
        free_lift = gross_lift_g - mass_g
        derived["free_lift_ratio"] = round(free_lift / mass_g, 3)

        h_max = solve_float_altitude(volume_L, mass_g)
        if h_max is not None:
            derived["max_alt_km"] = round(h_max, 2)

            # Payload at 90 % of h_max — a scale-free "service-ceiling" metric.
            h_service = PAYLOAD_ALT_FRACTION * h_max
            derived["alt_at_90pct_hmax_km"] = round(h_service, 2)
            payload = payload_at_altitude_g(volume_L, mass_g, h_service)
            if payload is not None:
                derived["payload_at_90pct_hmax_g"] = round(payload, 1)

        h_payload = solve_float_altitude(volume_L, mass_g + STD_PAYLOAD_G)
        if h_payload is not None:
            derived["alt_at_std_payload_km"] = round(h_payload, 2)

    return derived


# ─── Main ──────────────────────────────────────────────────────────────────
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
            "index": data.get("index", None),
            "title": data.get("title", slug),
            "short_description": data.get("short_description", ""),
            "balloon": data.get("balloon", {}),
            "test": data.get("test", {}),
            "results": data.get("results", {}),
            "methods": data.get("methods", ""),
            "conclusions": data.get("conclusions", ""),
            "notes": data.get("notes", ""),
            "media": data.get("media", {}),
            "tags": data.get("tags", []),
            "has_viewer": has_viewer,
            "has_mesh": has_mesh,
            "has_per_frame": has_per_frame,
        }

        # Derived performance metrics (lift, altitude, etc.)
        csv_path = bdir / "data" / "inflator_log.csv"
        entry["derived"] = compute_derived(entry, csv_path)

        # Backfill missing test conditions + plateau count from the CSV
        conditions = extract_test_conditions(csv_path)
        if not entry["test"].get("temperature_c") and conditions["temperature_c"] is not None:
            entry["test"]["temperature_c"] = conditions["temperature_c"]
        if not entry["test"].get("humidity_pct") and conditions["humidity_pct"] is not None:
            entry["test"]["humidity_pct"] = conditions["humidity_pct"]
        # Always prefer the CSV-derived cycle count for plateaus_detected — the
        # DIC pipeline sometimes reports a different number based on strain
        # plateaus, but the inflator's pressure-cycle count is consistent
        # across all balloons (including inflator-only tests).
        if conditions["plateaus_detected"] is not None:
            entry["results"]["plateaus_detected"] = conditions["plateaus_detected"]
        # Override max_pressure_psi with the last PRESSURIZING set-point.  The
        # raw `pressure_psi` maximum is dominated by transient pump spikes
        # rather than the actual peak plateau the test held.
        if conditions["last_plateau_psi"] is not None:
            entry["results"]["max_pressure_psi"] = conditions["last_plateau_psi"]

        entries.append(entry)
        d = entry["derived"]
        derived_summary = (
            f"D@0.2psi={d['diameter_ref_in']}\""
            if d["diameter_ref_in"] is not None else "no-ref-size"
        )
        print(
            f"  ✓ {slug} (viewer={has_viewer}, mesh={has_mesh}, "
            f"per_frame={has_per_frame}, {derived_summary})"
        )

    catalog = {
        "count": len(entries),
        "constants": {
            "ref_pressure_psi": REF_PRESSURE_PSI,
            "std_payload_g": STD_PAYLOAD_G,
            "payload_alt_fraction": PAYLOAD_ALT_FRACTION,
            "gas": "H2",
            "atmosphere": "ISA-1976",
        },
        "balloons": entries,
    }

    out_path = out_dir / "catalog.json"
    with open(out_path, "w") as f:
        json.dump(catalog, f, indent=2, default=str)

    print(f"\n✓ catalog.json written: {len(entries)} balloons → {out_path}")


if __name__ == "__main__":
    main()
