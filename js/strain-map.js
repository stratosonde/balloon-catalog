/**
 * StrainMap — Canvas 2D filled-triangle DIC strain field renderer.
 *
 * Renders a Delaunay mesh colored by strain (e1, e2, areal, shear)
 * directly in image space, overlaid on the camera photo.
 *
 * Data format per frame:  { dots: { "42": [e1, e2, areal, u, v], ... } }
 * Mesh:                   { dot_ids: [...], triangles: [[i,j,k], ...], uv: [[u,v], ...] }
 */
const StrainMap = (() => {
    let _canvas, _ctx;
    let _container;
    let _mesh = null;        // { dot_ids, triangles, uv, vertices }
    let _dotIdToIdx = {};    // string dotId → index into dot_ids
    let _imageSize = [1280, 800];
    let _currentDots = null; // current frame dot data
    let _metric = 'areal';  // 'areal' | 'e1' | 'e2' | 'shear'
    let _opacity = 0.4;
    let _showGrid = false;
    let _selectedDotId = null;
    let _onSelect = null;    // callback(dotId)
    let _onHover = null;     // callback(dotId, x, y) or callback(null)
    let _sliceLines = null;  // {hLineV: pixelV, vLineU: pixelU} or null
    let _colorRange = 0.10;  // fixed ±10% color scale (adjustable via slider)

    // RdBu diverging colormap (blue = compression, red = tension)
    const CMAP = [
        { t: 0.0, r: 33, g: 102, b: 172 },
        { t: 0.25, r: 103, g: 169, b: 207 },
        { t: 0.5, r: 247, g: 247, b: 247 },
        { t: 0.75, r: 227, g: 130, b: 102 },
        { t: 1.0, r: 178, g: 24, b: 43 },
    ];

    function init(canvasId, containerId) {
        _canvas = document.getElementById(canvasId);
        _container = document.getElementById(containerId);
        if (!_canvas || !_container) return;
        _ctx = _canvas.getContext('2d');

        // Resize observer
        new ResizeObserver(_resize).observe(_container);
        _resize();

        // Mouse events
        _canvas.addEventListener('mousemove', _onMouseMove);
        _canvas.addEventListener('click', _onClick);
        _canvas.addEventListener('mouseleave', () => {
            if (_onHover) _onHover(null);
        });
    }

    function loadMesh(meshData, imageSize) {
        _mesh = meshData;
        _imageSize = imageSize || [1280, 800];
        _dotIdToIdx = {};
        for (let i = 0; i < _mesh.dot_ids.length; i++) {
            _dotIdToIdx[String(_mesh.dot_ids[i])] = i;
        }
    }

    function setMetric(m) { _metric = m; }
    function setOpacity(o) { _opacity = o; }
    function setShowGrid(g) { _showGrid = g; }
    function setColorRange(r) { _colorRange = r; }
    function setOnSelect(fn) { _onSelect = fn; }
    function setOnHover(fn) { _onHover = fn; }
    function getSelectedDotId() { return _selectedDotId; }

    /**
     * Render strain field for one frame.
     * @param {Object} frameDots - { "42": [e1, e2, areal, u, v], ... }
     */
    function renderFrame(frameDots) {
        _currentDots = frameDots;
        if (!_ctx || !_mesh || !frameDots) return;
        _draw();
    }

    function _resize() {
        if (!_canvas || !_container) return;
        const w = _container.clientWidth;
        const h = _container.clientHeight;
        const dpr = Math.min(window.devicePixelRatio, 2);
        _canvas.width = w * dpr;
        _canvas.height = h * dpr;
        _canvas.style.width = w + 'px';
        _canvas.style.height = h + 'px';
        _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (_currentDots) _draw();
    }

    // Number of color buckets for batched rendering (more = finer color steps)
    const _NUM_BUCKETS = 64;

    function _draw() {
        const w = _container.clientWidth;
        const h = _container.clientHeight;
        _ctx.clearRect(0, 0, w, h);

        if (!_mesh || !_currentDots) return;

        // Compute image-to-screen mapping (object-fit: contain)
        const imgW = _imageSize[0], imgH = _imageSize[1];
        const containerAR = w / h;
        const imageAR = imgW / imgH;
        let renderW, renderH, offsetX, offsetY;
        if (imageAR > containerAR) {
            renderW = w; renderH = w / imageAR;
            offsetX = 0; offsetY = (h - renderH) / 2;
        } else {
            renderH = h; renderW = h * imageAR;
            offsetX = (w - renderW) / 2; offsetY = 0;
        }
        const scaleX = renderW / imgW;
        const scaleY = renderH / imgH;

        // Extract strain values for color range computation
        const values = [];
        const dotPositions = {}; // dotId → {u, v, val, e1, e2, areal}
        for (const [dotId, arr] of Object.entries(_currentDots)) {
            const val = _extractMetric(arr);
            if (val != null && isFinite(val)) {
                values.push(val);
                dotPositions[dotId] = {
                    u: arr[3], v: arr[4],
                    val, e1: arr[0], e2: arr[1], areal: arr[2],
                    sx: offsetX + arr[3] * scaleX,
                    sy: offsetY + arr[4] * scaleY,
                };
            }
        }

        if (values.length < 3) return;

        // Fixed color range (adjustable via setColorRange / UI slider)
        const maxAbs = Math.max(_colorRange, 0.001);

        // Update colorbar labels
        _updateColorbar(maxAbs);

        // ── Batched flat-triangle rendering ───────────────────
        // Group triangles by quantized color bucket, draw each bucket
        // in a single beginPath/fill call, then blur for smooth look.
        // ~64 draw calls instead of ~28,000 save/clip/gradient/restore.

        const offCanvas = document.createElement('canvas');
        offCanvas.width = w;
        offCanvas.height = h;
        const offCtx = offCanvas.getContext('2d');

        // Pre-compute bucket colors
        const bucketColors = new Array(_NUM_BUCKETS);
        for (let b = 0; b < _NUM_BUCKETS; b++) {
            const t = (b + 0.5) / _NUM_BUCKETS;
            bucketColors[b] = _sampleColormap(t);
        }

        // Assign each triangle to a color bucket
        const buckets = new Array(_NUM_BUCKETS);
        for (let b = 0; b < _NUM_BUCKETS; b++) buckets[b] = [];

        for (const tri of _mesh.triangles) {
            const id0 = String(_mesh.dot_ids[tri[0]]);
            const id1 = String(_mesh.dot_ids[tri[1]]);
            const id2 = String(_mesh.dot_ids[tri[2]]);

            const d0 = dotPositions[id0];
            const d1 = dotPositions[id1];
            const d2 = dotPositions[id2];
            if (!d0 || !d1 || !d2) continue;

            // Face-average strain → color bucket
            const avgVal = (d0.val + d1.val + d2.val) / 3;
            const t = _normalize(avgVal, maxAbs);
            const bucket = Math.max(0, Math.min(_NUM_BUCKETS - 1,
                Math.floor(t * _NUM_BUCKETS)));
            buckets[bucket].push(d0, d1, d2);
        }

        // Draw each bucket as a single batched path
        for (let b = 0; b < _NUM_BUCKETS; b++) {
            const tris = buckets[b];
            if (tris.length === 0) continue;

            const c = bucketColors[b];
            offCtx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
            offCtx.beginPath();
            for (let i = 0; i < tris.length; i += 3) {
                offCtx.moveTo(tris[i].sx, tris[i].sy);
                offCtx.lineTo(tris[i + 1].sx, tris[i + 1].sy);
                offCtx.lineTo(tris[i + 2].sx, tris[i + 2].sy);
                offCtx.closePath();
            }
            offCtx.fill();
        }

        // Composite with mild blur for smooth color transitions
        _ctx.globalAlpha = _opacity;
        _ctx.filter = 'blur(3px)';
        _ctx.drawImage(offCanvas, 0, 0);
        _ctx.filter = 'none';

        // ── Draw grid edges (optional) ───────────────────────
        if (_showGrid) {
            _ctx.globalAlpha = 0.15;
            _ctx.strokeStyle = '#38bdf8';
            _ctx.lineWidth = 0.5;
            for (const tri of _mesh.triangles) {
                const id0 = String(_mesh.dot_ids[tri[0]]);
                const id1 = String(_mesh.dot_ids[tri[1]]);
                const id2 = String(_mesh.dot_ids[tri[2]]);
                const d0 = dotPositions[id0];
                const d1 = dotPositions[id1];
                const d2 = dotPositions[id2];
                if (!d0 || !d1 || !d2) continue;
                _ctx.beginPath();
                _ctx.moveTo(d0.sx, d0.sy);
                _ctx.lineTo(d1.sx, d1.sy);
                _ctx.lineTo(d2.sx, d2.sy);
                _ctx.closePath();
                _ctx.stroke();
            }
        }

        // ── Draw selected dot highlight ──────────────────────
        _ctx.globalAlpha = 1.0;
        if (_selectedDotId && dotPositions[_selectedDotId]) {
            const sel = dotPositions[_selectedDotId];
            _ctx.beginPath();
            _ctx.arc(sel.sx, sel.sy, 6, 0, Math.PI * 2);
            _ctx.strokeStyle = '#fbbf24';
            _ctx.lineWidth = 2.5;
            _ctx.stroke();
            // Label
            _ctx.font = '11px JetBrains Mono, monospace';
            _ctx.fillStyle = '#fbbf24';
            _ctx.textAlign = 'left';
            _ctx.fillText(`#${_selectedDotId}`, sel.sx + 10, sel.sy - 4);
        }

        // ── Draw slice indicator lines + thickness bands ─────
        if (_sliceLines) {
            // Horizontal band + line (Y slice → circumference panel)
            if (_sliceLines.hLineV != null) {
                const sy = offsetY + _sliceLines.hLineV * scaleY;
                const thick = (_sliceLines.hThickV || 0) * scaleY;

                // Shaded thickness band
                if (thick > 0) {
                    _ctx.globalAlpha = 0.15;
                    _ctx.fillStyle = '#22d3ee';
                    _ctx.fillRect(offsetX, sy - thick, renderW, thick * 2);
                    // Band edges
                    _ctx.globalAlpha = 0.4;
                    _ctx.strokeStyle = '#22d3ee';
                    _ctx.lineWidth = 0.5;
                    _ctx.setLineDash([]);
                    _ctx.beginPath();
                    _ctx.moveTo(offsetX, sy - thick); _ctx.lineTo(offsetX + renderW, sy - thick);
                    _ctx.moveTo(offsetX, sy + thick); _ctx.lineTo(offsetX + renderW, sy + thick);
                    _ctx.stroke();
                }

                // Center dashed line
                _ctx.globalAlpha = 0.8;
                _ctx.strokeStyle = '#22d3ee';
                _ctx.lineWidth = 1;
                _ctx.setLineDash([6, 4]);
                _ctx.beginPath();
                _ctx.moveTo(offsetX, sy);
                _ctx.lineTo(offsetX + renderW, sy);
                _ctx.stroke();

                // Label
                _ctx.setLineDash([]);
                _ctx.font = '9px JetBrains Mono, monospace';
                _ctx.fillStyle = '#22d3ee';
                _ctx.globalAlpha = 0.9;
                _ctx.textAlign = 'left';
                _ctx.fillText('Y slice', offsetX + 4, sy - (thick > 4 ? thick + 2 : 4));
            }

            // Vertical band + line (X slice → vertical panel)
            if (_sliceLines.vLineU != null) {
                const sx = offsetX + _sliceLines.vLineU * scaleX;
                const thick = (_sliceLines.vThickU || 0) * scaleX;

                // Shaded thickness band
                if (thick > 0) {
                    _ctx.globalAlpha = 0.15;
                    _ctx.fillStyle = '#a78bfa';
                    _ctx.fillRect(sx - thick, offsetY, thick * 2, renderH);
                    // Band edges
                    _ctx.globalAlpha = 0.4;
                    _ctx.strokeStyle = '#a78bfa';
                    _ctx.lineWidth = 0.5;
                    _ctx.setLineDash([]);
                    _ctx.beginPath();
                    _ctx.moveTo(sx - thick, offsetY); _ctx.lineTo(sx - thick, offsetY + renderH);
                    _ctx.moveTo(sx + thick, offsetY); _ctx.lineTo(sx + thick, offsetY + renderH);
                    _ctx.stroke();
                }

                // Center dashed line
                _ctx.globalAlpha = 0.8;
                _ctx.strokeStyle = '#a78bfa';
                _ctx.lineWidth = 1;
                _ctx.setLineDash([6, 4]);
                _ctx.beginPath();
                _ctx.moveTo(sx, offsetY);
                _ctx.lineTo(sx, offsetY + renderH);
                _ctx.stroke();

                // Label
                _ctx.setLineDash([]);
                _ctx.font = '9px JetBrains Mono, monospace';
                _ctx.fillStyle = '#a78bfa';
                _ctx.globalAlpha = 0.9;
                _ctx.textAlign = 'left';
                _ctx.fillText('X slice', sx + (thick > 4 ? thick + 2 : 4), offsetY + 12);
            }

            _ctx.globalAlpha = 1.0;
            _ctx.setLineDash([]);
        }

        // Store for hit testing
        _canvas._dotPositions = dotPositions;
        _canvas._mapping = { offsetX, offsetY, scaleX, scaleY };
    }

    function _extractMetric(arr) {
        // arr = [e1, e2, areal, u, v]
        switch (_metric) {
            case 'e1': return arr[0];
            case 'e2': return arr[1];
            case 'areal': return arr[2];
            case 'shear': return (arr[0] - arr[1]) / 2;
            default: return arr[2];
        }
    }

    function _normalize(val, maxAbs) {
        // Map value to [0, 1] for colormap (0.5 = zero strain)
        const clamped = Math.max(-maxAbs, Math.min(maxAbs, val));
        return (clamped / maxAbs + 1) * 0.5;
    }

    function _sampleColormap(t) {
        t = Math.max(0, Math.min(1, t));
        for (let i = 0; i < CMAP.length - 1; i++) {
            if (t >= CMAP[i].t && t <= CMAP[i + 1].t) {
                const f = (t - CMAP[i].t) / (CMAP[i + 1].t - CMAP[i].t);
                return {
                    r: Math.round(CMAP[i].r + f * (CMAP[i + 1].r - CMAP[i].r)),
                    g: Math.round(CMAP[i].g + f * (CMAP[i + 1].g - CMAP[i].g)),
                    b: Math.round(CMAP[i].b + f * (CMAP[i + 1].b - CMAP[i].b)),
                };
            }
        }
        return CMAP[CMAP.length - 1];
    }

    function _updateColorbar(maxAbs) {
        const cbCanvas = document.getElementById('colorbar-canvas');
        if (!cbCanvas) return;
        const ctx = cbCanvas.getContext('2d');
        const w = cbCanvas.width, h = cbCanvas.height;
        ctx.clearRect(0, 0, w, h);

        for (let y = 0; y < h; y++) {
            const t = 1 - y / h; // top = high, bottom = low
            const c = _sampleColormap(t);
            ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
            ctx.fillRect(0, y, w, 1);
        }

        const pct = (maxAbs * 100).toFixed(1);
        const highEl = document.getElementById('cb-high');
        const midEl = document.getElementById('cb-mid');
        const lowEl = document.getElementById('cb-low');
        if (highEl) highEl.textContent = `+${pct}%`;
        if (midEl) midEl.textContent = '0%';
        if (lowEl) lowEl.textContent = `-${pct}%`;
    }

    // ── Hit testing ──────────────────────────────────────────

    function _findDotAt(mx, my) {
        const dp = _canvas?._dotPositions;
        if (!dp) return null;

        let closest = null, closestDist = 15; // 15px click radius
        for (const [dotId, d] of Object.entries(dp)) {
            const dx = d.sx - mx, dy = d.sy - my;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < closestDist) {
                closestDist = dist;
                closest = { dotId, ...d };
            }
        }
        return closest;
    }

    function _onMouseMove(e) {
        const rect = _canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hit = _findDotAt(mx, my);
        if (_onHover) _onHover(hit, e.clientX, e.clientY);
    }

    function _onClick(e) {
        const rect = _canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hit = _findDotAt(mx, my);

        if (hit) {
            _selectedDotId = hit.dotId;
        } else {
            _selectedDotId = null;
        }
        if (_currentDots) _draw();
        if (_onSelect) _onSelect(_selectedDotId);
    }

    function selectDot(dotId) {
        _selectedDotId = dotId;
        if (_currentDots) _draw();
    }

    /**
     * Set slice indicator lines on the strain heatmap.
     * @param {Object|null} lines — {hLineV: pixelV, vLineU: pixelU} in image pixel coords, or null to clear
     */
    function setSliceLines(lines) {
        _sliceLines = lines;
        if (_currentDots) _draw();
    }

    return {
        init, loadMesh, renderFrame,
        setMetric, setOpacity, setShowGrid, setColorRange,
        setOnSelect, setOnHover, selectDot, getSelectedDotId,
        setSliceLines,
    };
})();

window.StrainMap = StrainMap;
