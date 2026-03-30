/**
 * App — main orchestration for Balloon Strain Lab.
 * Loads per-frame JSON on demand, seeks video for camera background.
 */

let _currentBalloon = null;
let _frameIndex = null;
let _meshData = null;
let _frameCache = {};
let _prefetchQueue = [];
let _prefetching = false;
let _plateauRows = [];
let _inflatorRows = [];
let _thicknessUm = null;

// Video background state
let _videoEl = null;
let _bgCanvas = null;
let _bgCtx = null;
let _videoFps = 30;
let _videoFrameMap = {};
let _videoReady = false;

document.addEventListener('DOMContentLoaded', async () => {
    StrainMap.init('field-canvas', 'field-container');
    Timeline.setupControls();
    _setupFieldControls();
    _setupDetailsToggle();
    await Catalog.init(onBalloonSelected);
});

// ═══════════════════════════════════════════════════════════════
// Balloon selected
// ═══════════════════════════════════════════════════════════════

async function onBalloonSelected(balloon) {
    _currentBalloon = balloon;
    _frameCache = {};
    _prefetchQueue = [];
    _plateauRows = [];
    _videoReady = false;

    const slug = balloon.slug;
    const basePath = `balloons/${slug}`;

    document.getElementById('welcome-panel').classList.add('hidden');
    document.getElementById('detail-panel').classList.remove('hidden');

    document.getElementById('detail-title').textContent = balloon.title;
    const meta = [balloon.balloon?.brand, balloon.balloon?.material,
        balloon.test?.date].filter(Boolean).join(' · ');
    document.getElementById('detail-meta').textContent = meta;

    const [frameIndex, meshData, plateauRows, inflatorRows] = await Promise.all([
        _fetchJson(`${basePath}/viewer/frame_index.json`),
        _fetchJson(`${basePath}/viewer/mesh.json`),
        _fetchCSV(`${basePath}/data/plateau_summary.csv`),
        _fetchCSV(`${basePath}/data/inflator_log.csv`),
    ]);

    _frameIndex = frameIndex;
    _meshData = meshData;
    _plateauRows = plateauRows || [];
    _inflatorRows = _filterPumpOff(inflatorRows || []);
    _thicknessUm = balloon.balloon?.material_thickness_um || null;

    if (!frameIndex || !meshData) {
        console.error('Failed to load viewer data');
        return;
    }

    StrainMap.loadMesh(meshData, frameIndex.image_size);
    StrainMap.setOnHover(_onFieldHover);
    StrainMap.setOnSelect(_onFieldSelect);

    Timeline.load(frameIndex);
    Timeline.onChange(async (idx, frameEntry) => {
        await _loadAndRenderFrame(frameEntry);
        Plots.updateCursor(idx);
        _updateInfoCards(frameEntry);
    });

    Plots.renderStrainHistory(frameIndex, null, null);
    Plots.renderCircPressure(frameIndex, plateauRows, _inflatorRows);
    Plots.renderBiaxiality(frameIndex, plateauRows);
    Plots.renderStressTime(_inflatorRows, balloon.balloon?.material_thickness_um || null);
    Plots.renderStrainTime(_inflatorRows);
    Plots.renderStressStrain(plateauRows, balloon.balloon?.material_thickness_um || null, frameIndex, balloon.balloon?.material || null, _inflatorRows);
    Plots.renderPlateauTable(plateauRows);

    // Wire up clear-selection button
    document.getElementById('btn-clear-selection')?.addEventListener('click', () => {
        StrainMap.selectDot(null);
        Plots.renderStrainHistory(frameIndex, null, null);
    });

    _fillSpecs(balloon);
    _fillResults(balloon, frameIndex);
    _fillMethods(balloon);
    _fillDownloads(balloon);
    _fillGallery(balloon);

    // Setup video background (frames_allI.mp4 — all-intra keyframes)
    await _setupVideo(slug);

    if (frameIndex.frames.length > 0) {
        await _loadAndRenderFrame(frameIndex.frames[0]);
        _updateInfoCards(frameIndex.frames[0]);
    }

    _startPrefetch(0, 20);
}

// ═══════════════════════════════════════════════════════════════
// Frame loading
// ═══════════════════════════════════════════════════════════════

async function _loadAndRenderFrame(frameEntry) {
    if (!frameEntry) return;
    const fid = frameEntry.frame_id;
    const slug = _currentBalloon.slug;

    // Always update video background (independent of strain data)
    _drawVideoFrame(fid);

    let frameData = _frameCache[fid];
    if (!frameData) {
        frameData = await _fetchJson(`balloons/${slug}/viewer/frames/${fid}.json`);
        if (frameData) _frameCache[fid] = frameData;
    }
    if (!frameData || !frameData.dots) return;

    StrainMap.renderFrame(frameData.dots);

    const idx = Timeline.getIndex();
    _startPrefetch(idx + 1, 10);
}

// ═══════════════════════════════════════════════════════════════
// Video background — all-intra MP4 seeking
// ═══════════════════════════════════════════════════════════════

async function _setupVideo(slug) {
    _videoEl = document.getElementById('field-video');
    _bgCanvas = document.getElementById('field-bg-canvas');
    if (!_videoEl || !_bgCanvas) return;
    _bgCtx = _bgCanvas.getContext('2d');

    // Load video frame index
    const vidIndex = await _fetchJson(`balloons/${slug}/video/frame_index.json`);
    if (!vidIndex) return;

    _videoFps = vidIndex.video_fps || 30;
    _videoFrameMap = {};
    for (const entry of (vidIndex.frames || [])) {
        _videoFrameMap[entry.frame_id] = entry.video_frame;
    }

    // Load the all-intra re-encoded video
    _videoEl.src = `balloons/${slug}/video/frames.mp4`;
    _videoEl.preload = 'auto';

    await new Promise(resolve => {
        if (_videoEl.readyState >= 1) { resolve(); return; }
        _videoEl.addEventListener('loadedmetadata', resolve, { once: true });
        _videoEl.addEventListener('error', resolve, { once: true });
    });

    if (_videoEl.videoWidth > 0) {
        _videoReady = true;
        _resizeBgCanvas();
        new ResizeObserver(_resizeBgCanvas).observe(document.getElementById('field-container'));
        console.log(`Video: ${_videoEl.videoWidth}×${_videoEl.videoHeight}, ${vidIndex.total_frames} frames, all-intra`);
    }
}

function _resizeBgCanvas() {
    if (!_bgCanvas) return;
    const c = document.getElementById('field-container');
    if (!c) return;
    _bgCanvas.width = c.clientWidth;
    _bgCanvas.height = c.clientHeight;
    // Repaint after resize (setting canvas.width clears the canvas)
    _paintBg();
}

/** Seek video to a frame and paint to background canvas. */
function _drawVideoFrame(frameId) {
    if (!_videoReady || !_videoEl || !_bgCtx) return;

    const vf = _videoFrameMap[frameId];
    if (vf == null) return;

    const seekTime = vf / _videoFps;
    const showPhoto = document.getElementById('chk-photo')?.checked ?? true;
    _bgCanvas.classList.toggle('hidden-photo', !showPhoto);

    // If already at this time (or very close), just repaint
    if (Math.abs(_videoEl.currentTime - seekTime) < 0.001 && _videoEl.readyState >= 2) {
        _paintBg();
        return;
    }

    // Remove any stale listener before adding a new one
    if (_videoEl._seekHandler) {
        _videoEl.removeEventListener('seeked', _videoEl._seekHandler);
    }
    _videoEl._seekHandler = () => {
        _videoEl.removeEventListener('seeked', _videoEl._seekHandler);
        _videoEl._seekHandler = null;
        _paintBg();
    };
    _videoEl.addEventListener('seeked', _videoEl._seekHandler);
    _videoEl.currentTime = seekTime;
}

function _paintBg() {
    if (!_bgCtx || !_videoEl || !_bgCanvas) return;
    const cw = _bgCanvas.width, ch = _bgCanvas.height;
    const vw = _videoEl.videoWidth, vh = _videoEl.videoHeight;
    if (!vw || !vh) return;

    // Object-fit: contain
    const ar = vw / vh, car = cw / ch;
    let dw, dh, dx, dy;
    if (ar > car) { dw = cw; dh = cw / ar; dx = 0; dy = (ch - dh) / 2; }
    else { dh = ch; dw = ch * ar; dx = (cw - dw) / 2; dy = 0; }

    _bgCtx.clearRect(0, 0, cw, ch);
    try { _bgCtx.drawImage(_videoEl, dx, dy, dw, dh); } catch {}
}

// ═══════════════════════════════════════════════════════════════
// Prefetch
// ═══════════════════════════════════════════════════════════════

function _startPrefetch(startIdx, count) {
    if (!_frameIndex || !_currentBalloon) return;
    const slug = _currentBalloon.slug;
    _prefetchQueue = [];
    for (let i = startIdx; i < Math.min(startIdx + count, _frameIndex.frames.length); i++) {
        const fid = _frameIndex.frames[i].frame_id;
        if (!_frameCache[fid]) _prefetchQueue.push(fid);
    }
    if (!_prefetching) _doPrefetch(slug);
}

async function _doPrefetch(slug) {
    _prefetching = true;
    while (_prefetchQueue.length > 0) {
        const fid = _prefetchQueue.shift();
        if (_frameCache[fid]) continue;
        try {
            const d = await _fetchJson(`balloons/${slug}/viewer/frames/${fid}.json`);
            if (d) _frameCache[fid] = d;
        } catch {}
    }
    _prefetching = false;
}

// ═══════════════════════════════════════════════════════════════
// Field controls
// ═══════════════════════════════════════════════════════════════

function _setupFieldControls() {
    const rerender = () => {
        const fe = Timeline.getCurrentFrame();
        if (fe && _frameCache[fe.frame_id]) StrainMap.renderFrame(_frameCache[fe.frame_id].dots);
    };

    document.getElementById('sel-metric')?.addEventListener('change', e => {
        StrainMap.setMetric(e.target.value); rerender();
    });
    document.getElementById('rng-opacity')?.addEventListener('input', e => {
        StrainMap.setOpacity(parseInt(e.target.value, 10) / 100); rerender();
    });
    document.getElementById('chk-grid')?.addEventListener('change', e => {
        StrainMap.setShowGrid(e.target.checked); rerender();
    });
    document.getElementById('chk-photo')?.addEventListener('change', e => {
        if (_bgCanvas) _bgCanvas.classList.toggle('hidden-photo', !e.target.checked);
    });
}

// ═══════════════════════════════════════════════════════════════
// Hover + click
// ═══════════════════════════════════════════════════════════════

function _onFieldHover(hit) {
    const tip = document.getElementById('hover-tip');
    if (!tip) return;
    if (!hit) { tip.classList.add('hidden'); return; }

    tip.classList.remove('hidden');
    tip.innerHTML = [
        `#${hit.dotId}`,
        `ε₁: ${(hit.e1 * 100).toFixed(3)}%`,
        `ε₂: ${(hit.e2 * 100).toFixed(3)}%`,
        `Areal: ${(hit.areal * 100).toFixed(3)}%`,
    ].join('<br>');
    tip.style.left = (hit.sx + 15) + 'px';
    tip.style.top = (hit.sy - 10) + 'px';
}

async function _onFieldSelect(dotId) {
    if (!dotId) {
        // Deselected — show global median
        Plots.renderStrainHistory(_frameIndex, null, null);
        return;
    }

    // Fetch full per-dot timeseries (all frames) from viewer/dots/{dotId}.json
    const slug = _currentBalloon?.slug;
    if (slug) {
        const dotData = await _fetchJson(`balloons/${slug}/viewer/dots/${dotId}.json`);
        if (dotData) {
            // Build a fake frameCache that renderStrainHistory can iterate
            const dotCache = {};
            for (const [fid, arr] of Object.entries(dotData)) {
                dotCache[fid] = { dots: { [dotId]: arr } };
            }
            Plots.renderStrainHistory(_frameIndex, dotId, dotCache);
            return;
        }
    }

    // Fallback: use whatever is in the prefetch cache
    Plots.renderStrainHistory(_frameIndex, dotId, _frameCache);
}

// ═══════════════════════════════════════════════════════════════
// Details collapse
// ═══════════════════════════════════════════════════════════════

function _setupDetailsToggle() {
    const btn = document.getElementById('btn-details-toggle');
    const body = document.getElementById('details-body');
    if (btn && body) {
        btn.addEventListener('click', () => {
            const hidden = body.classList.toggle('hidden');
            btn.textContent = hidden ? '▼ Test Details & Data' : '▲ Test Details & Data';
        });
    }
}

// ═══════════════════════════════════════════════════════════════
// Tables
// ═══════════════════════════════════════════════════════════════

function _fillSpecs(b) {
    _fillKV('specs-table', [
        ['Brand', b.balloon?.brand], ['Material', b.balloon?.material],
        ['Thickness', b.balloon?.material_thickness_um ? `${b.balloon.material_thickness_um} µm` : null],
        ['Size', b.balloon?.size_nominal], ['Color', b.balloon?.color],
        ['Date', b.test?.date], ['Protocol', b.test?.protocol],
    ]);
}

function _fillResults(b, fi) {
    _fillKV('results-table', [
        ['Max Pressure', b.results?.max_pressure_psi ? `${b.results.max_pressure_psi} PSI` : null],
        ['Max Diameter', b.results?.max_diameter_in ? `${b.results.max_diameter_in} in` : null],
        ['Plateaus', b.results?.plateaus_detected],
        ['Duration', b.results?.total_duration_s ? _fmtDuration(b.results.total_duration_s) : null],
        ['Frames', fi?.total_frames], ['DIC Subsets', fi?.total_dots],
    ]);
}

function _fillMethods(b) {
    const el = document.getElementById('methods-text');
    if (el) el.textContent = b.methods || '—';
}

function _fillDownloads(b) {
    const el = document.getElementById('download-links');
    if (!el) return;
    const s = b.slug;
    el.innerHTML = [
        `<a href="balloons/${s}/data/plateau_summary.csv" download>⬇ Plateau Summary</a>`,
        `<a href="balloons/${s}/viewer/mesh.json" download>⬇ Mesh</a>`,
        `<a href="balloons/${s}/viewer/frame_index.json" download>⬇ Frame Index</a>`,
    ].join('');
}

function _fillGallery(b) {
    const el = document.getElementById('photo-gallery');
    if (!el) return;
    const images = b.media?.images || [];
    if (images.length === 0) {
        el.classList.add('hidden');
        return;
    }
    const slug = b.slug;
    el.classList.remove('hidden');
    el.innerHTML = images.map(img => {
        const src = `balloons/${slug}/${img.file}`;
        const cap = img.caption || '';
        return `<figure>
            <img src="${_esc(src)}" alt="${_esc(cap)}" loading="lazy"
                 onclick="window.open(this.src,'_blank')">
            <figcaption>${_esc(cap)}</figcaption>
        </figure>`;
    }).join('');
}

function _fillKV(id, rows) {
    const t = document.getElementById(id);
    if (!t) return;
    t.innerHTML = rows
        .filter(([, v]) => v != null && v !== '')
        .map(([l, v]) => `<tr><td>${_esc(l)}</td><td>${_esc(String(v))}</td></tr>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// Info cards — live readouts updated per frame
// ═══════════════════════════════════════════════════════════════

function _updateInfoCards(frameEntry) {
    if (!frameEntry) return;
    const f = frameEntry;

    // Pressure
    const elP = document.getElementById('card-pressure');
    if (elP) elP.textContent = f.pressure_psi != null ? f.pressure_psi.toFixed(3) : '—';

    // Areal strain (DIC median)
    const elA = document.getElementById('card-areal');
    if (elA) elA.textContent = f.areal_p50 != null ? (f.areal_p50 * 100).toFixed(2) : '—';

    // ε₁ Major
    const elE1 = document.getElementById('card-e1');
    if (elE1) elE1.textContent = f.e1_p50 != null ? (f.e1_p50 * 100).toFixed(2) : '—';

    // ε₂ Minor
    const elE2 = document.getElementById('card-e2');
    if (elE2) elE2.textContent = f.e2_p50 != null ? (f.e2_p50 * 100).toFixed(2) : '—';

    // DIC subsets
    const elN = document.getElementById('card-dots');
    if (elN) elN.textContent = f.n != null ? f.n : '—';

    // Elapsed time
    const elT = document.getElementById('card-elapsed');
    if (elT) {
        if (f.elapsed_s != null) {
            const s = f.elapsed_s;
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = Math.floor(s % 60);
            elT.textContent = h > 0 ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
        } else {
            elT.textContent = '—';
        }
    }

    // Diameter & Stress — look up from inflator data at this elapsed time
    const elD = document.getElementById('card-diameter');
    const elS = document.getElementById('card-stress');
    const elSU = document.getElementById('card-stress-unit');

    if (f.elapsed_s != null && _inflatorRows && _inflatorRows.length > 0) {
        // Binary search inflator rows for closest time
        const target = f.elapsed_s;
        let best = _inflatorRows[0];
        let bestDist = Infinity;
        // Simple scan (inflator rows are time-ordered)
        for (let i = 0; i < _inflatorRows.length; i++) {
            const t = parseFloat(_inflatorRows[i].elapsed_time);
            if (isNaN(t)) continue;
            const dist = Math.abs(t - target);
            if (dist < bestDist) { bestDist = dist; best = _inflatorRows[i]; }
            if (t > target + 1) break; // past our target, stop searching
        }

        const d = parseFloat(best.diameter_inches);
        if (elD) elD.textContent = !isNaN(d) && d > 0 ? d.toFixed(1) : '—';

        // Compute hoop stress
        const p = parseFloat(best.pressure_psi);
        if (!isNaN(d) && d > 0 && !isNaN(p)) {
            const P_Pa = p * 6894.76;
            const r_m = (d * 0.0254) / 2;
            if (_thicknessUm && _thicknessUm > 0) {
                const t_m = _thicknessUm * 1e-6;
                const sigma = (P_Pa * r_m) / (2 * t_m) / 1e6;
                if (elS) elS.textContent = sigma.toFixed(2);
                if (elSU) elSU.textContent = 'MPa';
            } else {
                const tension = (P_Pa * r_m) / 2;
                if (elS) elS.textContent = tension.toFixed(1);
                if (elSU) elSU.textContent = 'N/m';
            }
        } else {
            if (elS) elS.textContent = '—';
        }
    } else {
        if (elD) elD.textContent = '—';
        if (elS) elS.textContent = '—';
    }
}

// ═══════════════════════════════════════════════════════════════
// Inflator log preprocessing — filter out pump-on + settle period
// ═══════════════════════════════════════════════════════════════

/**
 * Filter inflator log rows: keep only pump=OFF rows, and skip the first
 * 5 samples after each ON→OFF transition (pressure settling time).
 */
function _filterPumpOff(rows) {
    if (!rows || rows.length === 0) return rows;
    const SETTLE_SAMPLES = 6;
    const filtered = [];
    let wasOn = false;
    let skipCount = 0;

    for (const row of rows) {
        const state = (row.pump_state || '').toUpperCase().trim();

        // Skip EVENT rows (no pump_state) — pass them through for circumference chart
        if (!state) continue;

        if (state === 'ON') {
            wasOn = true;
            continue; // skip pump-on rows entirely
        }

        // state === 'OFF'
        if (wasOn) {
            // Pump just turned off — start settle countdown
            wasOn = false;
            skipCount = SETTLE_SAMPLES;
        }

        if (skipCount > 0) {
            skipCount--;
            continue; // skip settle samples
        }

        filtered.push(row);
    }

    console.log(`Inflator filter: ${rows.length} → ${filtered.length} rows (pump-off + settled)`);
    return filtered;
}

// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════

async function _fetchJson(url) {
    try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
}

async function _fetchCSV(url) {
    try {
        const r = await fetch(url); if (!r.ok) return null;
        const lines = (await r.text()).trim().split('\n');
        if (lines.length < 2) return [];
        const h = lines[0].split(',').map(s => s.trim());
        return lines.slice(1).map(l => {
            const v = l.split(',').map(s => s.trim());
            const o = {}; h.forEach((k, i) => o[k] = v[i] || ''); return o;
        });
    } catch { return null; }
}

function _fmtDuration(s) {
    if (s == null) return null;
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    return m > 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m ${sec}s`;
}

function _esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
