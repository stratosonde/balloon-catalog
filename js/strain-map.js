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

        // Auto color range: P05 / P95
        const sorted = [...values].sort((a, b) => a - b);
        const p05 = sorted[Math.floor(sorted.length * 0.05)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const maxAbs = Math.max(Math.abs(p05), Math.abs(p95), 0.001);

        // Update colorbar labels
        _updateColorbar(maxAbs);

        // ── Draw smooth strain field ─────────────────────────
        // Render triangles to an offscreen canvas, then blur for smooth look
        const offCanvas = document.createElement('canvas');
        offCanvas.width = w;
        offCanvas.height = h;
        const offCtx = offCanvas.getContext('2d');

        for (const tri of _mesh.triangles) {
            const id0 = String(_mesh.dot_ids[tri[0]]);
            const id1 = String(_mesh.dot_ids[tri[1]]);
            const id2 = String(_mesh.dot_ids[tri[2]]);

            const d0 = dotPositions[id0];
            const d1 = dotPositions[id1];
            const d2 = dotPositions[id2];

            if (!d0 || !d1 || !d2) continue;

            // Draw 3 overlapping radial gradients for vertex interpolation
            const cx = (d0.sx + d1.sx + d2.sx) / 3;
            const cy = (d0.sy + d1.sy + d2.sy) / 3;

            // Clip to triangle
            offCtx.save();
            offCtx.beginPath();
            offCtx.moveTo(d0.sx, d0.sy);
            offCtx.lineTo(d1.sx, d1.sy);
            offCtx.lineTo(d2.sx, d2.sy);
            offCtx.closePath();
            offCtx.clip();

            // Draw each vertex as radial gradient to simulate interpolation
            for (const d of [d0, d1, d2]) {
                const t = _normalize(d.val, maxAbs);
                const c = _sampleColormap(t);
                const edgeLen = Math.max(
                    Math.hypot(d1.sx - d0.sx, d1.sy - d0.sy),
                    Math.hypot(d2.sx - d1.sx, d2.sy - d1.sy),
                    Math.hypot(d0.sx - d2.sx, d0.sy - d2.sy)
                );
                const radius = edgeLen * 0.9;
                const grad = offCtx.createRadialGradient(d.sx, d.sy, 0, d.sx, d.sy, radius);
                grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0.5)`);
                grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0.0)`);
                offCtx.fillStyle = grad;
                offCtx.fillRect(d.sx - radius, d.sy - radius, radius * 2, radius * 2);
            }

            // Background fill for gaps (face-averaged)
            const avgVal = (d0.val + d1.val + d2.val) / 3;
            const ft = _normalize(avgVal, maxAbs);
            const fc = _sampleColormap(ft);
            offCtx.globalCompositeOperation = 'destination-over';
            offCtx.fillStyle = `rgb(${fc.r},${fc.g},${fc.b})`;
            offCtx.beginPath();
            offCtx.moveTo(d0.sx, d0.sy);
            offCtx.lineTo(d1.sx, d1.sy);
            offCtx.lineTo(d2.sx, d2.sy);
            offCtx.closePath();
            offCtx.fill();
            offCtx.globalCompositeOperation = 'source-over';

            offCtx.restore();
        }

        // Apply soft blur to smooth out triangle edges
        _ctx.globalAlpha = _opacity;
        _ctx.filter = 'blur(3px)';
        _ctx.drawImage(offCanvas, 0, 0);
        _ctx.filter = 'none';
        // Draw again without blur at reduced opacity for sharpness
        _ctx.globalAlpha = _opacity * 0.5;
        _ctx.drawImage(offCanvas, 0, 0);

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
        setMetric, setOpacity, setShowGrid,
        setOnSelect, setOnHover, selectDot, getSelectedDotId,
        setSliceLines,
    };
})();

window.StrainMap = StrainMap;
