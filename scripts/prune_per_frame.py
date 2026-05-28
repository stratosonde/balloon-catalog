#!/usr/bin/env python3
"""
Prune per-frame viewer data to keep the GitHub Pages artifact under 10 GB.

Each DIC balloon directory has:
  - viewer/frames/NNNNNN.json   (per-frame strain snapshot, ~300 KB)
  - viewer/clouds/NNNNNN.json   (per-frame stereo point cloud, ~200 KB)
  - viewer/frame_index.json     (manifest of frames listed above)

Some balloons exported every captured frame (3000+), pushing the
Pages artifact past the 10 GB limit. This script keeps:

  1. Every burst-phase frame (phase=="burst" or video_frame >= burst_start_frame)
  2. A uniform sample of `--max-inflation N` inflation frames (default 250)

Frames not selected have their per-frame files deleted from disk and from
`viewer/frame_index.json`'s `frames` array. `total_frames`, `burst_start_frame`,
and other top-level fields are preserved so the index page still reports the
original test length.

The script is idempotent: re-running with the same parameters is a no-op.

Usage:
  # Dry-run, show what would change for all balloons
  python scripts/prune_per_frame.py --all --dry-run

  # Apply default cap (250 inflation + all burst) to every balloon
  python scripts/prune_per_frame.py --all

  # Process one balloon
  python scripts/prune_per_frame.py balloons/6.QingdaoYizhou_Silver_50Inch
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def select_kept_frames(frames: list[dict], burst_start_frame: int | None,
                       max_inflation: int) -> list[dict]:
    """Apply the sampling rule.

    Keeps:
      - every burst frame (phase=="burst", or video_frame >= burst_start_frame)
      - a uniform sample of `max_inflation` inflation frames

    Returns the kept entries in their original order.
    """
    def is_burst(f: dict) -> bool:
        if f.get("phase") == "burst":
            return True
        if burst_start_frame is not None:
            vf = f.get("video_frame")
            if vf is not None and vf >= burst_start_frame:
                return True
        return False

    burst = [f for f in frames if is_burst(f)]
    inflation = [f for f in frames if not is_burst(f)]

    if max_inflation <= 0 or len(inflation) <= max_inflation:
        kept_inflation = inflation
    else:
        # Uniform stride sample; always include first and last
        n = len(inflation)
        # Pick max_inflation indices evenly spaced over [0, n-1]
        idx = [round(i * (n - 1) / (max_inflation - 1)) for i in range(max_inflation)]
        # Dedupe while preserving order
        seen = set()
        idx_unique = [j for j in idx if not (j in seen or seen.add(j))]
        kept_inflation = [inflation[j] for j in idx_unique]

    # Merge back in original order using frame_id as the sort key (string sort
    # works because frame_ids are zero-padded fixed-width)
    kept = sorted(kept_inflation + burst, key=lambda f: f["frame_id"])
    return kept


def prune_balloon(balloon_dir: Path, max_inflation: int, dry_run: bool) -> dict:
    """Prune per-frame files in one balloon directory.

    Returns a stats dict.
    """
    fi_path = balloon_dir / "viewer" / "frame_index.json"
    if not fi_path.exists():
        return {"skipped": True, "reason": "no frame_index.json"}

    with open(fi_path) as f:
        fi = json.load(f)

    frames = fi.get("frames", [])
    burst_start = fi.get("burst_start_frame")
    kept = select_kept_frames(frames, burst_start, max_inflation)
    kept_ids = {f["frame_id"] for f in kept}

    frames_dir = balloon_dir / "viewer" / "frames"
    clouds_dir = balloon_dir / "viewer" / "clouds"

    # Find files to remove (those whose frame_id is no longer kept)
    files_to_remove: list[Path] = []
    bytes_to_free = 0
    for subdir in (frames_dir, clouds_dir):
        if not subdir.is_dir():
            continue
        for p in subdir.glob("*.json"):
            fid = p.stem  # "000123"
            if fid not in kept_ids:
                files_to_remove.append(p)
                try:
                    bytes_to_free += p.stat().st_size
                except OSError:
                    pass

    stats = {
        "balloon": balloon_dir.name,
        "frames_before": len(frames),
        "frames_after": len(kept),
        "burst_kept": sum(1 for f in kept if f.get("phase") == "burst"
                          or (burst_start is not None
                              and f.get("video_frame", -1) >= burst_start)),
        "files_to_remove": len(files_to_remove),
        "mb_to_free": bytes_to_free / (1024 * 1024),
        "dry_run": dry_run,
    }

    if dry_run:
        return stats

    # Apply: rewrite frame_index.json
    fi["frames"] = kept
    fi.setdefault("pruned", {})
    fi["pruned"] = {
        "max_inflation": max_inflation,
        "original_frame_count": len(frames),
    }
    with open(fi_path, "w") as f:
        json.dump(fi, f, separators=(",", ":"))

    # Apply: delete per-frame files
    for p in files_to_remove:
        try:
            p.unlink()
        except OSError as e:
            print(f"  ⚠ Could not remove {p}: {e}", file=sys.stderr)

    return stats


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Prune per-frame viewer data to fit GitHub Pages limits.",
    )
    parser.add_argument(
        "balloon_dirs", nargs="*", type=Path,
        help="One or more balloon directories. Omit to use --all.",
    )
    parser.add_argument(
        "--all", action="store_true",
        help="Process every directory under balloons/.",
    )
    parser.add_argument(
        "--max-inflation", type=int, default=250,
        help="Max inflation-phase frames to keep per balloon (default 250). "
             "Burst frames are always kept in addition.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Report what would change without modifying anything.",
    )
    args = parser.parse_args(argv)

    if args.all:
        balloons_root = REPO_ROOT / "balloons"
        targets = sorted(d for d in balloons_root.iterdir() if d.is_dir())
    elif args.balloon_dirs:
        targets = args.balloon_dirs
    else:
        parser.error("Provide balloon dirs or pass --all")

    total_files = 0
    total_mb = 0.0
    for d in targets:
        stats = prune_balloon(d, args.max_inflation, args.dry_run)
        if stats.get("skipped"):
            print(f"  – {d.name}: skipped ({stats['reason']})")
            continue
        marker = "[dry-run] " if args.dry_run else ""
        print(f"  {marker}{stats['balloon']}: "
              f"{stats['frames_before']} → {stats['frames_after']} frames "
              f"({stats['burst_kept']} burst kept), "
              f"-{stats['files_to_remove']} files / -{stats['mb_to_free']:.1f} MB")
        total_files += stats["files_to_remove"]
        total_mb += stats["mb_to_free"]

    print()
    verb = "would free" if args.dry_run else "freed"
    print(f"Total: {verb} {total_files} files / {total_mb:.1f} MB")


if __name__ == "__main__":
    main()
