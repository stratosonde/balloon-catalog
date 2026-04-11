/**
 * Profiles — interactive cross-sectional slices through the balloon's
 * stereo point cloud.
 *
 * Two Plotly panels:
 *   1) Circumference profile — depth Z vs horizontal position X
 *      (thin horizontal slab at adjustable Y position)
 *   2) Vertical profile — depth Z vs vertical position Y
 *      (thin vertical slab at adjustable X position)
 *
 * Trail ghost frames are rendered by slicing pre-computed 2D depth grids
 * (from profiles.json) at the current slider position — fully synchronous,
 * no network fetches.  The current frame shows raw cloud scatter points.
 *
 * Falls back to legacy centroid-fixed h/v profile lines if no grid data.
 *
 * Lines are colored by elapsed time / frame index.
 */

const Profiles = (() => {
    // ── State ────────────────────────────────────────────────
    let _container = null;
    let _profilesData = null;  // profiles.json (full object)
    let _tracksData = null;
    let _meshData = null;
    let _cloudData = null;     // current frame cloud: {x:[], y:[], z:[], n:int}
    let _currentFrameId = null;

    // Trail (ghost frames)
    let _trailEnabled = true;
    let _trailCount = 9999;
    let _trailStep = 1;
    let _trailBuffer = [];
    let _trailSkipCounter = 0;

    // Grid data (parsed from profiles.json — new format)
    let _gridMeta = null;      // {nx, ny, x_range, y_range} or null
    let _gridFrames = null;    // {frameId: Float32Array|null, ...} or null
    let _hasGrid = false;

    // Slice parameters (in world coordinates, metres)
    let _sliceX = 0;
    let _sliceY = 0;
    let _thickness = 0.08;

    // Cloud extent (updated when cloud data arrives)
    let _cloudBounds = null;
    let _firstZCenter = null;  // Z center of first frame — used for stable Z centering

    // Global axis bounds — stable across all frames
    let _globalBounds = null;

    // World→pixel mapping for slice overlay on strain map
    let _worldToPixel = null;

    // Image bounds — world-coordinate extent of the full rectified stereo image
    // (computed from pixel→world inverse mapping + image pixel dimensions)
    let _imageBounds = null;

    // Balloon slug (for potential future use; not needed for grid approach)
    let _balloonSlug = null;

    // ── Public API ───────────────────────────────────────────

    function init(containerId) {
        _container = document.getElementById(containerId);
    }

    function setSlug(slug) {
        _balloonSlug = slug;
    }

    /**
     * Load profile data (grid format or legacy h/v lines).
     */
    function loadProfiles(profilesJson, tracksJson, meshJson) {
        _profilesData = profilesJson;
        _tracksData = tracksJson || null;
        _meshData = meshJson || null;
        _trailBuffer = [];
        _trailSkipCounter = 0;
        _currentFrameId = null;
        _cloudBounds = null;
        _firstZCenter = null;
        _imageBounds = null;
        _gridMeta = null;
        _gridFrames = null;
        _hasGrid = false;

        if (!profilesJson) return;

        // ── Detect grid format (new) vs legacy h/v format ────
        if (profilesJson.grid && profilesJson.grid.nx) {
            _gridMeta = profilesJson.grid;
            _gridFrames = {};
            // Pre-parse z arrays for fast access
            const frames = profilesJson.frames || {};
            for (const fid of (profilesJson.frame_ids || [])) {
                const fd = frames[fid];
                if (fd && fd.z) {
                    _gridFrames[fid] = fd.z; // keep as JS array (null = no data)
                }
            }
            _hasGrid = true;

            // Global bounds from grid ranges
            const g = _gridMeta;
            _globalBounds = {
                xMin: g.x_range[0], xMax: g.x_range[1],
                yMin: g.y_range[0], yMax: g.y_range[1],
                zMin: Infinity, zMax: -Infinity,
            };
            // Scan all grids for z range
            for (const fid in _gridFrames) {
                const z = _gridFrames[fid];
                for (let i = 0; i < z.length; i++) {
                    if (z[i] !== null) {
                        if (z[i] < _globalBounds.zMin) _globalBounds.zMin = z[i];
                        if (z[i] > _globalBounds.zMax) _globalBounds.zMax = z[i];
                    }
                }
            }
            if (!isFinite(_globalBounds.zMin)) _globalBounds = null;

            console.log(`Profiles: grid ${g.nx}×${g.ny}, ${Object.keys(_gridFrames).length} frames`);
        } else {
            // Legacy h/v format — compute bounds from profile data
            _globalBounds = null;
            if (profilesJson.frames && profilesJson.frame_ids) {
                let xMin = Infinity, xMax = -Infinity;
                let yMin = Infinity, yMax = -Infinity;
                let zMin = Infinity, zMax = -Infinity;
                for (const fid of profilesJson.frame_ids) {
                    const fp = profilesJson.frames[fid];
                    if (!fp) continue;
                    if (fp.h) {
                        for (const v of fp.h.pos)   { if (v < xMin) xMin = v; if (v > xMax) xMax = v; }
                        for (const v of fp.h.depth) { if (v < zMin) zMin = v; if (v > zMax) zMax = v; }
                    }
                    if (fp.v) {
                        for (const v of fp.v.pos)   { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
                        for (const v of fp.v.depth) { if (v < zMin) zMin = v; if (v > zMax) zMax = v; }
                    }
                }
                if (isFinite(xMin)) {
                    _globalBounds = { xMin, xMax, yMin, yMax, zMin, zMax };
                }
            }
        }

        // Build world→pixel mapping from mesh, using _globalBounds for
        // consistent coordinate reference with the profile axis ranges.
        _worldToPixel = null;
        if (meshJson && meshJson.vertices && meshJson.uv && meshJson.vertices.length > 10) {
            // Compute regression: world (X,Y) → image pixel (u,v)
            // using mesh vertex + uv correspondences.
            let meshXMin = Infinity, meshXMax = -Infinity;
            let meshYMin = Infinity, meshYMax = -Infinity;
            let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
            for (let i = 0; i < meshJson.vertices.length; i++) {
                const [X, Y] = meshJson.vertices[i];
                const [u, v] = meshJson.uv[i];
                if (X < meshXMin) meshXMin = X; if (X > meshXMax) meshXMax = X;
                if (Y < meshYMin) meshYMin = Y; if (Y > meshYMax) meshYMax = Y;
                if (u < uMin) uMin = u; if (u > uMax) uMax = u;
                if (v < vMin) vMin = v; if (v > vMax) vMax = v;
            }
            if (meshXMax > meshXMin && meshYMax > meshYMin) {
                // Store mesh bounds — this matches what the strain map shows
                _meshBounds = { xMin: meshXMin, xMax: meshXMax, yMin: meshYMin, yMax: meshYMax };
                console.log('Mesh bounds:', 'x:', meshXMin.toFixed(3), '→', meshXMax.toFixed(3),
                    'y:', meshYMin.toFixed(3), '→', meshYMax.toFixed(3));

                // Compute pixel-per-metre scale from mesh data
                const scaleU = (uMax - uMin) / (meshXMax - meshXMin);
                const scaleV = (vMax - vMin) / (meshYMax - meshYMin);
                // Anchor: mesh center world → mesh center pixel
                const meshCx = (meshXMin + meshXMax) / 2;
                const meshCy = (meshYMin + meshYMax) / 2;
                const meshCu = (uMin + uMax) / 2;
                const meshCv = (vMin + vMax) / 2;
                _worldToPixel = {
                    uFromX: (x) => meshCu + (x - meshCx) * scaleU,
                    vFromY: (y) => meshCv + (y - meshCy) * scaleV,
                    // Inverse: pixel → world
                    xFromU: (u) => meshCx + (u - meshCu) / scaleU,
                    yFromV: (v) => meshCy + (v - meshCv) / scaleV,
                };
            }
        }
    }

    function loadTracks(tracksJson, meshJson) {
        _tracksData = tracksJson;
        _meshData = meshJson;
    }

    function setCloud(cloudData) {
        _cloudData = cloudData;
        if (cloudData && cloudData.n > 0) {
            _updateCloudBounds(cloudData);
        }
    }

    function renderFrame(frameId, frameDotsData) {
        if (!_container) return;
        if (_trailEnabled && _currentFrameId && _currentFrameId !== frameId) {
            _trailSkipCounter++;
            if (_trailSkipCounter >= _trailStep) {
                _trailSkipCounter = 0;
                _trailBuffer.push(_currentFrameId);
                while (_trailBuffer.length > _trailCount) _trailBuffer.shift();
            }
        }
        _currentFrameId = frameId;
        _render();
    }

    // ── Cloud bounds + slider sync ───────────────────────────

    function _updateCloudBounds(cloud) {
        const x = cloud.x, y = cloud.y, z = cloud.z;
        let xMin = Infinity, xMax = -Infinity;
        let yMin = Infinity, yMax = -Infinity;
        let zMin = Infinity, zMax = -Infinity;
        for (let i = 0; i < cloud.n; i++) {
            if (x[i] < xMin) xMin = x[i]; if (x[i] > xMax) xMax = x[i];
            if (y[i] < yMin) yMin = y[i]; if (y[i] > yMax) yMax = y[i];
            if (z[i] < zMin) zMin = z[i]; if (z[i] > zMax) zMax = z[i];
        }
        const isFirst = !_cloudBounds;
        _cloudBounds = { xMin, xMax, yMin, yMax, zMin, zMax };
        if (isFirst) {
            _firstZCenter = (zMin + zMax) / 2;
            console.log('First frame Z center:', _firstZCenter.toFixed(3), 'range:', zMin.toFixed(3), '→', zMax.toFixed(3));
            _sliceX = (xMin + xMax) / 2;
            _sliceY = (yMin + yMax) / 2;
            _thickness = Math.max(yMax - yMin, xMax - xMin) * 0.04;
            _syncSlidersFromState();
        }
    }

    function _syncSlidersFromState() {
        if (!_cloudBounds) return;
        const b = _cloudBounds;
        const xSlider = document.getElementById('profile-x');
        if (xSlider) {
            const pct = (((_sliceX - b.xMin) / (b.xMax - b.xMin)) * 100) || 50;
            xSlider.value = Math.round(Math.max(0, Math.min(100, pct)));
            const lbl = document.getElementById('profile-x-val');
            if (lbl) lbl.textContent = _sliceX.toFixed(3) + ' m';
        }
        const ySlider = document.getElementById('profile-y');
        if (ySlider) {
            const pct = (((_sliceY - b.yMin) / (b.yMax - b.yMin)) * 100) || 50;
            ySlider.value = Math.round(Math.max(0, Math.min(100, pct)));
            const lbl = document.getElementById('profile-y-val');
            if (lbl) lbl.textContent = _sliceY.toFixed(3) + ' m';
        }
        const thSlider = document.getElementById('profile-thickness');
        if (thSlider) {
            const extent = Math.max(b.yMax - b.yMin, b.xMax - b.xMin);
            const pct = (_thickness / (extent * 0.20)) * 200;
            thSlider.value = Math.round(Math.max(5, Math.min(200, pct)));
            const lbl = document.getElementById('profile-thickness-val');
            if (lbl) lbl.textContent = (_thickness * 1000).toFixed(0) + ' mm';
        }
    }

    // ── Grid slicing ─────────────────────────────────────────

    /**
     * Slice a depth grid at Y = sliceY ± thickness → circumference profile.
     * Returns {pos: [x0, x1, ...], depth: [z0, z1, ...]} or null.
     */
    function _sliceGridAtY(frameId, sliceY, thickness) {
        if (!_gridMeta || !_gridFrames || !_gridFrames[frameId]) return null;
        const g = _gridMeta;
        const z = _gridFrames[frameId];
        const cellH = (g.y_range[1] - g.y_range[0]) / g.ny;
        const cellW = (g.x_range[1] - g.x_range[0]) / g.nx;
        const yiLo = Math.max(0, Math.floor((sliceY - thickness - g.y_range[0]) / cellH));
        const yiHi = Math.min(g.ny - 1, Math.ceil((sliceY + thickness - g.y_range[0]) / cellH));

        const pos = [], depth = [];
        for (let xi = 0; xi < g.nx; xi++) {
            let zMin = Infinity;
            for (let yi = yiLo; yi <= yiHi; yi++) {
                const val = z[yi * g.nx + xi];
                if (val !== null && val < zMin) zMin = val;
            }
            if (isFinite(zMin)) {
                pos.push(g.x_range[0] + (xi + 0.5) * cellW);
                depth.push(zMin);
            }
        }
        return pos.length >= 2 ? { pos, depth } : null;
    }

    /**
     * Slice a depth grid at X = sliceX ± thickness → vertical profile.
     * Returns {pos: [y0, y1, ...], depth: [z0, z1, ...]} or null.
     */
    function _sliceGridAtX(frameId, sliceX, thickness) {
        if (!_gridMeta || !_gridFrames || !_gridFrames[frameId]) return null;
        const g = _gridMeta;
        const z = _gridFrames[frameId];
        const cellW = (g.x_range[1] - g.x_range[0]) / g.nx;
        const cellH = (g.y_range[1] - g.y_range[0]) / g.ny;
        const xiLo = Math.max(0, Math.floor((sliceX - thickness - g.x_range[0]) / cellW));
        const xiHi = Math.min(g.nx - 1, Math.ceil((sliceX + thickness - g.x_range[0]) / cellW));

        const pos = [], depth = [];
        for (let yi = 0; yi < g.ny; yi++) {
            let zMin = Infinity;
            for (let xi = xiLo; xi <= xiHi; xi++) {
                const val = z[yi * g.nx + xi];
                if (val !== null && val < zMin) zMin = val;
            }
            if (isFinite(zMin)) {
                pos.push(g.y_range[0] + (yi + 0.5) * cellH);
                depth.push(zMin);
            }
        }
        return pos.length >= 2 ? { pos, depth } : null;
    }

    // ── Rendering ────────────────────────────────────────────

    function _render() {
        if (!_container) return;
        const plotDiv = _container.querySelector('.profile-plot');
        if (!plotDiv) return;

        if (!_cloudData && !_profilesData) {
            _renderEmpty('No point cloud or profile data available');
            return;
        }

        const data = [];
        const bgColor = 'rgba(0,0,0,0)';
        const gridColor = 'rgba(30,41,59,0.6)';
        const fontColor = '#94a3b8';
        const axCommon = {
            gridcolor: gridColor, zerolinecolor: gridColor,
            tickfont: { size: 9, color: fontColor },
            titlefont: { size: 11, color: fontColor },
        };

        const frameIds = _profilesData ? (_profilesData.frame_ids || []) : [];
        const frames = _profilesData ? (_profilesData.frames || {}) : {};
        const nTotal = frameIds.length;

        // ── Trail ghost frames ───────────────────────────────
        if (_trailEnabled && _trailBuffer.length > 0) {
            const nTrail = _trailBuffer.length;

            if (_hasGrid) {
                // ── Grid-based trail (new format) — combined into 2 traces
                const allHx = [], allHz = [], allHc = [];
                const allVy = [], allVz = [], allVc = [];

                for (let ti = 0; ti < nTrail; ti++) {
                    const trailFid = _trailBuffer[ti];
                    const age = nTrail - ti;
                    const opacity = 0.10 + 0.40 * (1 - age / (nTrail + 1));
                    const closestFid = _findClosestProfileFrame(trailFid);
                    const profIdx = closestFid ? frameIds.indexOf(closestFid) : -1;
                    const frac = (nTotal > 1 && profIdx >= 0) ? profIdx / (nTotal - 1) : 0;
                    const rgba = `rgba(${_timeColor(frac)},${opacity.toFixed(2)})`;

                    const hSlice = _sliceGridAtY(closestFid || trailFid, _sliceY, _thickness);
                    if (hSlice) {
                        for (let j = 0; j < hSlice.pos.length; j++) {
                            allHx.push(hSlice.pos[j]); allHz.push(hSlice.depth[j]); allHc.push(rgba);
                        }
                    }
                    const vSlice = _sliceGridAtX(closestFid || trailFid, _sliceX, _thickness);
                    if (vSlice) {
                        for (let j = 0; j < vSlice.pos.length; j++) {
                            allVz.push(vSlice.depth[j]); allVy.push(vSlice.pos[j]); allVc.push(rgba);
                        }
                    }
                }

                if (allHx.length > 0) {
                    data.push({
                        x: allHx, y: allHz,
                        type: 'scattergl', mode: 'markers',
                        marker: { color: allHc, size: 2 },
                        hoverinfo: 'skip', showlegend: false,
                        xaxis: 'x', yaxis: 'y',
                    });
                }
                if (allVy.length > 0) {
                    data.push({
                        x: allVz, y: allVy,
                        type: 'scattergl', mode: 'markers',
                        marker: { color: allVc, size: 2 },
                        hoverinfo: 'skip', showlegend: false,
                        xaxis: 'x2', yaxis: 'y2',
                    });
                }
            } else {
                // ── Legacy h/v profile line trail ─────────────
                for (let ti = 0; ti < nTrail; ti++) {
                    const trailFid = _trailBuffer[ti];
                    const age = nTrail - ti;
                    const opacity = 0.10 + 0.40 * (1 - age / (nTrail + 1));
                    const closestFid = _findClosestProfileFrame(trailFid);
                    if (!closestFid || !frames[closestFid]) continue;
                    const profIdx = frameIds.indexOf(closestFid);
                    const frac = (nTotal > 1 && profIdx >= 0) ? profIdx / (nTotal - 1) : 0;
                    const rgba = `rgba(${_timeColor(frac)},${opacity.toFixed(2)})`;
                    const trailProf = frames[closestFid];

                    if (trailProf.h) {
                        data.push({
                            x: trailProf.h.pos, y: trailProf.h.depth,
                            mode: 'lines', line: { color: rgba, width: 1.5 },
                            hoverinfo: 'skip', showlegend: false, xaxis: 'x', yaxis: 'y',
                        });
                    }
                    if (trailProf.v) {
                        data.push({
                            x: trailProf.v.depth, y: trailProf.v.pos,
                            mode: 'lines', line: { color: rgba, width: 1.5 },
                            hoverinfo: 'skip', showlegend: false, xaxis: 'x2', yaxis: 'y2',
                        });
                    }
                }
            }
        }

        // ── Current frame: raw cloud scatter points ──────────
        let currentColor = 'rgb(59,130,246)';
        if (_currentFrameId && nTotal > 0) {
            const closestFid = _findClosestProfileFrame(_currentFrameId);
            if (closestFid) {
                const idx = frameIds.indexOf(closestFid);
                const frac = nTotal > 1 ? idx / (nTotal - 1) : 0;
                currentColor = `rgb(${_timeColor(frac)})`;
            }
        }

        if (_cloudData && _cloudData.n > 0) {
            const cx = _cloudData.x, cy = _cloudData.y, cz = _cloudData.z;
            const t = _thickness;
            const hx = [], hz = [];
            for (let i = 0; i < _cloudData.n; i++) {
                if (Math.abs(cy[i] - _sliceY) <= t) { hx.push(cx[i]); hz.push(cz[i]); }
            }
            if (hx.length > 0) {
                data.push({
                    x: hx, y: hz, mode: 'markers',
                    marker: { color: currentColor, size: 1.5, opacity: 0.7 },
                    name: `Cloud ${_currentFrameId}`,
                    hovertemplate: 'X: %{x:.4f} m<br>Z: %{y:.4f} m<extra></extra>',
                    showlegend: false, xaxis: 'x', yaxis: 'y',
                });
            }

            const vy = [], vz = [];
            for (let i = 0; i < _cloudData.n; i++) {
                if (Math.abs(cx[i] - _sliceX) <= t) { vy.push(cy[i]); vz.push(cz[i]); }
            }
            if (vy.length > 0) {
                data.push({
                    x: vz, y: vy, mode: 'markers',
                    marker: { color: currentColor, size: 1.5, opacity: 0.7 },
                    name: `Cloud V ${_currentFrameId}`,
                    hovertemplate: 'Z: %{x:.4f} m<br>Y: %{y:.4f} m<extra></extra>',
                    showlegend: false, xaxis: 'x2', yaxis: 'y2',
                });
            }
        } else if (_profilesData && _currentFrameId) {
            // Fallback for current frame too
            if (_hasGrid) {
                const closestFid = _findClosestProfileFrame(_currentFrameId);
                const hSlice = _sliceGridAtY(closestFid || _currentFrameId, _sliceY, _thickness);
                if (hSlice) {
                    data.push({
                        x: hSlice.pos, y: hSlice.depth, mode: 'lines',
                        line: { color: currentColor, width: 2.5 },
                        showlegend: false, xaxis: 'x', yaxis: 'y',
                    });
                }
                const vSlice = _sliceGridAtX(closestFid || _currentFrameId, _sliceX, _thickness);
                if (vSlice) {
                    data.push({
                        x: vSlice.depth, y: vSlice.pos, mode: 'lines',
                        line: { color: currentColor, width: 2.5 },
                        showlegend: false, xaxis: 'x2', yaxis: 'y2',
                    });
                }
            } else {
                const currentFid = _findClosestProfileFrame(_currentFrameId);
                const currentProf = currentFid ? frames[currentFid] : null;
                if (currentProf) {
                    if (currentProf.h) {
                        data.push({ x: currentProf.h.pos, y: currentProf.h.depth, mode: 'lines',
                            line: { color: currentColor, width: 2.5 }, showlegend: false, xaxis: 'x', yaxis: 'y' });
                    }
                    if (currentProf.v) {
                        data.push({ x: currentProf.v.depth, y: currentProf.v.pos, mode: 'lines',
                            line: { color: currentColor, width: 2.5 }, showlegend: false, xaxis: 'x2', yaxis: 'y2' });
                    }
                }
            }
        }

        // ── Compute image bounds (once) from video dimensions ─
        // Convert the full rectified image pixel extent → world coordinates
        // so the profile plots match exactly what the strain map image shows.
        if (!_imageBounds && _worldToPixel && _worldToPixel.xFromU) {
            const vid = document.getElementById('field-video');
            const imgW = (vid && vid.videoWidth > 0) ? vid.videoWidth : 1280;
            const imgH = (vid && vid.videoHeight > 0) ? vid.videoHeight : 800;
            _imageBounds = {
                xMin: _worldToPixel.xFromU(0),
                xMax: _worldToPixel.xFromU(imgW),
                yMin: _worldToPixel.yFromV(0),
                yMax: _worldToPixel.yFromV(imgH),
            };
            // Ensure min < max
            if (_imageBounds.xMin > _imageBounds.xMax) { const t = _imageBounds.xMin; _imageBounds.xMin = _imageBounds.xMax; _imageBounds.xMax = t; }
            if (_imageBounds.yMin > _imageBounds.yMax) { const t = _imageBounds.yMin; _imageBounds.yMin = _imageBounds.yMax; _imageBounds.yMax = t; }
            console.log('Image bounds (world):', 'x:', _imageBounds.xMin.toFixed(3), '→', _imageBounds.xMax.toFixed(3),
                'y:', _imageBounds.yMin.toFixed(3), '→', _imageBounds.yMax.toFixed(3),
                `(from ${imgW}×${imgH} px)`);
        }

        // ── Axis ranges ──────────────────────────────────────
        // X/Y: use imageBounds (world extent of the displayed rectified image)
        //      This is the exact same field of view as the camera image above.
        // Z:   use globalBounds (stable across all frames) so axes don't jump.
        const xyb = _imageBounds || _globalBounds || _cloudBounds || { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
        const zb = _globalBounds || _cloudBounds || { zMin: 2, zMax: 5 };
        const xSpan = xyb.xMax - xyb.xMin || 1;
        const ySpan = xyb.yMax - xyb.yMin || 1;
        const zCenter = _firstZCenter || (zb.zMin + zb.zMax) / 2;
        const xRange = [xyb.xMin, xyb.xMax];
        const yRange = [xyb.yMax, xyb.yMin]; // inverted (Y increases downward in image)
        // Z range matches X span (circumference panel) so cross-section
        // has correct proportions. Centered on global Z midpoint.
        const zRange = [zCenter + xSpan / 2, zCenter - xSpan / 2]; // far→near

        // ── Point counts ─────────────────────────────────────
        let hPts = 0, vPts = 0;
        if (_cloudData && _cloudData.n > 0) {
            for (let i = 0; i < _cloudData.n; i++) {
                if (Math.abs(_cloudData.y[i] - _sliceY) <= _thickness) hPts++;
                if (Math.abs(_cloudData.x[i] - _sliceX) <= _thickness) vPts++;
            }
        }

        // ── Slice indicator shapes: dashed center lines ──────
        const sliceShapes = [
            // Vertical dashed line on circumference panel at X = _sliceX
            {
                type: 'line', xref: 'x', yref: 'y',
                x0: _sliceX, x1: _sliceX, y0: zRange[0], y1: zRange[1],
                line: { color: 'rgba(167,139,250,0.7)', width: 1.5, dash: 'dash' },
            },
            // Horizontal dashed line on vertical panel at Y = _sliceY
            {
                type: 'line', xref: 'x2', yref: 'y2',
                x0: zRange[0], x1: zRange[1], y0: _sliceY, y1: _sliceY,
                line: { color: 'rgba(34,211,238,0.7)', width: 1.5, dash: 'dash' },
            },
        ];

        // ── Layout ───────────────────────────────────────────
        const layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(8,13,24,0.5)',
            margin: { l: 50, r: 15, t: 35, b: 45 },
            font: { family: "'Inter', sans-serif", color: fontColor, size: 10 },
            showlegend: false,
            xaxis:  { ...axCommon, domain: [0, 0.46], anchor: 'y', title: 'X — horizontal (m)', range: xRange, fixedrange: true },
            yaxis:  { ...axCommon, domain: [0, 1], anchor: 'x', title: 'Z — depth (m)', range: zRange, fixedrange: true },
            xaxis2: { ...axCommon, domain: [0.54, 1], anchor: 'y2', title: 'Z — depth (m)', range: zRange, fixedrange: true },
            yaxis2: { ...axCommon, domain: [0, 1], anchor: 'x2', title: 'Y — vertical (m)', range: yRange, fixedrange: true },
            shapes: sliceShapes,
            annotations: [
                { text: `<b>Circumference</b> slab at Y=${_sliceY.toFixed(3)}m · ${hPts} pts`,
                  x: 0.23, y: 1.04, xref: 'paper', yref: 'paper', showarrow: false, font: { size: 10, color: '#cbd5e1' } },
                { text: `<b>Vertical</b> slab at X=${_sliceX.toFixed(3)}m · ${vPts} pts`,
                  x: 0.77, y: 1.04, xref: 'paper', yref: 'paper', showarrow: false, font: { size: 10, color: '#cbd5e1' } },
                ...(_trailEnabled && _trailBuffer.length > 0 ? [{
                    text: `trail: ${_trailBuffer.length} ghost${_trailBuffer.length !== 1 ? 's' : ''} · step ${_trailStep}`,
                    x: 0.02, y: -0.06, xref: 'paper', yref: 'paper', showarrow: false, font: { size: 9, color: '#64b5f6' },
                }] : []),
                { text: `frame ${_currentFrameId || '—'} · thickness ±${(_thickness * 1000).toFixed(0)}mm`,
                  x: 0.98, y: -0.06, xref: 'paper', yref: 'paper', showarrow: false, font: { size: 9, color: '#64748b' } },
            ],
        };

        Plotly.react(plotDiv, data, layout, { responsive: true, displayModeBar: false, staticPlot: false });
        _updateSliceLines();
    }

    function _updateSliceLines() {
        if (!_worldToPixel || typeof StrainMap === 'undefined') return;
        try {
            const hCenter = _worldToPixel.vFromY(_sliceY);
            const vCenter = _worldToPixel.uFromX(_sliceX);
            // Convert world thickness to pixel thickness
            const hThick = Math.abs(_worldToPixel.vFromY(_sliceY + _thickness) - hCenter);
            const vThick = Math.abs(_worldToPixel.uFromX(_sliceX + _thickness) - vCenter);
            StrainMap.setSliceLines({
                hLineV: hCenter, vLineU: vCenter,
                hThickV: hThick, vThickU: vThick,
            });
        } catch(e) {}
    }

    function _renderEmpty(msg) {
        const plotDiv = _container.querySelector('.profile-plot');
        if (!plotDiv) return;
        Plotly.react(plotDiv, [], {
            paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(8,13,24,0.5)',
            margin: { l: 10, r: 10, t: 30, b: 10 },
            annotations: [{ text: msg, x: 0.5, y: 0.5, xref: 'paper', yref: 'paper',
                showarrow: false, font: { size: 13, color: '#64748b' } }],
        }, { responsive: true, displayModeBar: false });
    }

    // ── Helpers ───────────────────────────────────────────────

    function _findClosestProfileFrame(frameId) {
        if (!_profilesData || !frameId) return null;
        const fids = _profilesData.frame_ids;
        if (!fids || fids.length === 0) return null;
        if (_hasGrid ? _gridFrames[frameId] : _profilesData.frames[frameId]) return frameId;
        let lo = 0, hi = fids.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (fids[mid] < frameId) lo = mid + 1; else hi = mid; }
        if (lo === 0) return fids[0];
        if (lo >= fids.length) return fids[fids.length - 1];
        const d0 = Math.abs(parseInt(fids[lo - 1]) - parseInt(frameId));
        const d1 = Math.abs(parseInt(fids[lo]) - parseInt(frameId));
        return d0 <= d1 ? fids[lo - 1] : fids[lo];
    }

    function _timeColor(t) {
        t = Math.max(0, Math.min(1, t));
        let r, g, b;
        if (t < 0.25) { const s = t / 0.25; r = 59; g = Math.round(130 + 100 * s); b = Math.round(246 - 100 * s); }
        else if (t < 0.5) { const s = (t - 0.25) / 0.25; r = Math.round(59 + 100 * s); g = 230; b = Math.round(146 - 146 * s); }
        else if (t < 0.75) { const s = (t - 0.5) / 0.25; r = Math.round(159 + 96 * s); g = Math.round(230 - 30 * s); b = 0; }
        else { const s = (t - 0.75) / 0.25; r = 255; g = Math.round(200 - 132 * s); b = Math.round(68 * (1 - s)); }
        return `${r},${g},${b}`;
    }

    // ── Controls ─────────────────────────────────────────────

    function setupControls() {
        const chkTrail = document.getElementById('chk-trail');
        if (chkTrail) {
            chkTrail.checked = _trailEnabled;
            chkTrail.addEventListener('change', e => {
                _trailEnabled = e.target.checked;
                if (!_trailEnabled) _trailBuffer = [];
                _render();
            });
        }

        const trailCountSlider = document.getElementById('profile-trail-count');
        const TRAIL_SLIDER_MAX = 200;
        if (trailCountSlider) {
            trailCountSlider.value = TRAIL_SLIDER_MAX;
            trailCountSlider.addEventListener('input', e => {
                const v = parseInt(e.target.value, 10);
                _trailCount = (v >= TRAIL_SLIDER_MAX) ? 9999 : v;
                const lbl = document.getElementById('profile-trail-count-val');
                if (lbl) lbl.textContent = (v >= TRAIL_SLIDER_MAX) ? 'All' : v;
                while (_trailBuffer.length > _trailCount) _trailBuffer.shift();
                _render();
            });
        }

        const trailStepSlider = document.getElementById('profile-trail-step');
        if (trailStepSlider) {
            trailStepSlider.value = _trailStep;
            trailStepSlider.addEventListener('input', e => {
                _trailStep = parseInt(e.target.value, 10);
                const lbl = document.getElementById('profile-trail-step-val');
                if (lbl) lbl.textContent = _trailStep;
            });
        }

        const xSlider = document.getElementById('profile-x');
        if (xSlider) {
            xSlider.disabled = false;
            xSlider.addEventListener('input', e => {
                if (!_cloudBounds) return;
                const pct = parseInt(e.target.value, 10) / 100;
                _sliceX = _cloudBounds.xMin + pct * (_cloudBounds.xMax - _cloudBounds.xMin);
                const lbl = document.getElementById('profile-x-val');
                if (lbl) lbl.textContent = _sliceX.toFixed(3) + ' m';
                _render();
            });
        }

        const ySlider = document.getElementById('profile-y');
        if (ySlider) {
            ySlider.disabled = false;
            ySlider.addEventListener('input', e => {
                if (!_cloudBounds) return;
                const pct = parseInt(e.target.value, 10) / 100;
                _sliceY = _cloudBounds.yMin + pct * (_cloudBounds.yMax - _cloudBounds.yMin);
                const lbl = document.getElementById('profile-y-val');
                if (lbl) lbl.textContent = _sliceY.toFixed(3) + ' m';
                _render();
            });
        }

        const zSlider = document.getElementById('profile-z');
        if (zSlider) zSlider.disabled = true;

        const thSlider = document.getElementById('profile-thickness');
        if (thSlider) {
            thSlider.disabled = false;
            thSlider.addEventListener('input', e => {
                if (!_cloudBounds) return;
                const extent = Math.max(_cloudBounds.yMax - _cloudBounds.yMin, _cloudBounds.xMax - _cloudBounds.xMin);
                const v = parseInt(e.target.value, 10);
                _thickness = Math.max(0.001, (v / 200) * extent * 0.20);
                const lbl = document.getElementById('profile-thickness-val');
                if (lbl) lbl.textContent = (_thickness * 1000).toFixed(0) + ' mm';
                _render();
            });
        }
    }

    function updateAllLabels() {
        const cLbl = document.getElementById('profile-trail-count-val');
        if (cLbl) cLbl.textContent = (_trailCount >= 200) ? 'All' : _trailCount;
        const sLbl = document.getElementById('profile-trail-step-val');
        if (sLbl) sLbl.textContent = _trailStep;
    }

    return { init, setSlug, loadProfiles, loadTracks, renderFrame, setCloud, setupControls, updateAllLabels };
})();
