/**
 * Plots — Plotly charts for DIC balloon analysis.
 * Strain history (global + per-point overlay), biaxiality, diameter-pressure,
 * DIC-based stress-strain with material reference lines.
 */
const Plots = (() => {
    const DARK = {
        paper_bgcolor: '#0c1220',
        plot_bgcolor: '#0c1220',
        font: { family: 'Inter, sans-serif', size: 11, color: '#94a3b8' },
        margin: { l: 50, r: 15, t: 10, b: 40 },
        xaxis: { gridcolor: '#1e2d45', zerolinecolor: '#1e2d45', linecolor: '#1e2d45' },
        yaxis: { gridcolor: '#1e2d45', zerolinecolor: '#1e2d45', linecolor: '#1e2d45' },
        hovermode: 'x unified',
        hoverlabel: { bgcolor: '#131d2e', bordercolor: '#38bdf8', font: { family: 'monospace', size: 10 } },
    };
    const CFG = { displayModeBar: false, responsive: true };

    let _cursorShapes = {};
    let _cachedFrameIndex = null;
    // Time→strain lookup for stress-strain cursor sync (sorted by time)
    let _stressStrainLookup = [];  // [{t, strain}] sorted by t


    // ═══════════════════════════════════════════════════════════
    // Strain History — merged: global P10/P50/P90 + optional point overlay
    // ═══════════════════════════════════════════════════════════

    /**
     * Render the unified strain history chart.
     * @param {object} frameIndex - frame_index.json data
     * @param {string|null} dotId - selected dot ID (null = global only)
     * @param {object|null} frameCache - frame data cache for per-point traces
     */
    function renderStrainHistory(frameIndex, dotId, frameCache) {
        _cachedFrameIndex = frameIndex;
        const container = document.getElementById('plot-strain-history');
        if (!container || !frameIndex || !frameIndex.frames) return;

        const xs = [], p10 = [], p50 = [], p90 = [];
        for (let i = 0; i < frameIndex.frames.length; i++) {
            const f = frameIndex.frames[i];
            xs.push(i);
            p10.push(f.areal_p10 != null ? f.areal_p10 * 100 : null);
            p50.push(f.areal_p50 != null ? f.areal_p50 * 100 : null);
            p90.push(f.areal_p90 != null ? f.areal_p90 * 100 : null);
        }

        // P10-P90 band
        const band_x = [...xs, ...xs.slice().reverse()];
        const band_y = [...p90, ...p10.slice().reverse()];

        _cursorShapes['plot-strain-history'] = [];

        const traces = [
            {
                x: band_x, y: band_y, fill: 'toself',
                fillcolor: 'rgba(56,189,248,0.10)', line: { width: 0 },
                name: 'P10–P90', hoverinfo: 'skip',
            },
            {
                x: xs, y: p50, name: 'Global Median',
                line: { color: '#38bdf8', width: 2 },
                hovertemplate: '%{y:.2f}%<extra>Median</extra>',
            },
            {
                x: xs, y: p90, name: 'P90',
                line: { color: 'rgba(248,113,113,0.4)', width: 1, dash: 'dot' },
                hovertemplate: '%{y:.2f}%<extra>P90</extra>',
            },
        ];

        // Update subtitle
        const subtitle = document.getElementById('strain-history-subtitle');
        const clearBtn = document.getElementById('btn-clear-selection');

        if (dotId && frameCache) {
            // Overlay selected point's traces
            const pt_xs = [], pt_e1 = [], pt_e2 = [], pt_areal = [];
            for (let i = 0; i < frameIndex.frames.length; i++) {
                const fid = frameIndex.frames[i].frame_id;
                const cached = frameCache[fid];
                if (!cached || !cached.dots || !cached.dots[dotId]) continue;
                const arr = cached.dots[dotId];
                pt_xs.push(i);
                pt_e1.push(arr[0] * 100);
                pt_e2.push(arr[1] * 100);
                pt_areal.push(arr[2] * 100);
            }

            if (pt_xs.length > 0) {
                traces.push({
                    x: pt_xs, y: pt_areal, name: `#${dotId} Areal`,
                    line: { color: '#34d399', width: 2.5 },
                    hovertemplate: '%{y:.3f}%<extra>#' + dotId + ' Areal</extra>',
                });
                traces.push({
                    x: pt_xs, y: pt_e1, name: `#${dotId} ε₁`,
                    line: { color: '#f87171', width: 1.5, dash: 'dot' },
                    hovertemplate: '%{y:.3f}%<extra>#' + dotId + ' ε₁</extra>',
                });
                traces.push({
                    x: pt_xs, y: pt_e2, name: `#${dotId} ε₂`,
                    line: { color: '#60a5fa', width: 1.5, dash: 'dot' },
                    hovertemplate: '%{y:.3f}%<extra>#' + dotId + ' ε₂</extra>',
                });
            }

            if (subtitle) subtitle.textContent = `Subset #${dotId} overlaid on global median`;
            if (clearBtn) clearBtn.classList.remove('hidden');
        } else {
            if (subtitle) subtitle.textContent = 'Global median · click a subset to overlay';
            if (clearBtn) clearBtn.classList.add('hidden');
        }

        Plotly.newPlot(container, traces, {
            ...DARK,
            height: 280,
            xaxis: { ...DARK.xaxis, title: { text: 'Frame', font: { size: 10 } } },
            yaxis: { ...DARK.yaxis, title: { text: 'Areal Strain (%)', font: { size: 10 } }, range: [null, 100] },
            legend: {
                x: 0.01, y: 0.99, bgcolor: 'rgba(12,18,32,0.8)',
                bordercolor: '#1e2d45', borderwidth: 1, font: { size: 9 },
            },
            margin: { l: 50, r: 15, t: 10, b: 40 },
        }, CFG);
    }

    // ═══════════════════════════════════════════════════════════
    // Biaxiality — median ε₁ vs median ε₂ per frame
    // ═══════════════════════════════════════════════════════════

    function renderBiaxiality(frameIndex, plateauRows) {
        const container = document.getElementById('plot-biaxiality');
        if (!container || !frameIndex) return;

        // Use ALL frames — no subsampling (typically ~1500 points, fine for Plotly)
        const e1s = [], e2s = [], colors = [];
        for (const f of frameIndex.frames) {
            if (f.e1_p50 != null && f.e2_p50 != null) {
                e1s.push(f.e1_p50 * 100);
                e2s.push(f.e2_p50 * 100);
                colors.push(f.pressure_psi || 0);
            }
        }

        if (e1s.length === 0) {
            container.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px">No biaxiality data.</p>';
            return;
        }

        const maxP = Math.max(...colors, 0.1);

        // Compute auto-scaled ranges with padding
        const e1Min = Math.min(0, ...e1s), e1Max = Math.max(...e1s, 1);
        const e2Min = Math.min(...e2s, 0), e2Max = Math.max(...e2s, 1);
        const e1Pad = Math.max((e1Max - e1Min) * 0.1, 2);
        const e2Pad = Math.max((e2Max - e2Min) * 0.15, 2);
        const xRange = [Math.floor(e1Min - e1Pad), Math.ceil(e1Max + e1Pad)];
        const yRange = [Math.floor(e2Min - e2Pad), Math.ceil(e2Max + e2Pad)];
        const refMax = Math.max(xRange[1], yRange[1]);

        _cursorShapes['plot-biaxiality'] = [];

        Plotly.newPlot(container, [
            // Equibiaxial reference line (ε₁ = ε₂)
            {
                x: [0, refMax], y: [0, refMax],
                mode: 'lines', line: { color: '#64748b', width: 1, dash: 'dash' },
                hoverinfo: 'skip', showlegend: true, name: 'Equibiaxial',
            },
            // Uniaxial reference (ε₂ = 0)
            {
                x: [xRange[0], xRange[1]], y: [0, 0],
                mode: 'lines', line: { color: '#475569', width: 1, dash: 'dot' },
                hoverinfo: 'skip', showlegend: true, name: 'Uniaxial',
            },
            // All frames as scatter points colored by pressure
            {
                x: e1s, y: e2s, mode: 'markers', name: 'Per-frame median',
                marker: {
                    size: 4, color: colors,
                    colorscale: [[0, '#3b82f6'], [0.5, '#a78bfa'], [1, '#ef4444']],
                    cmin: 0, cmax: maxP,
                    colorbar: {
                        title: { text: 'PSI', font: { size: 9 } },
                        thickness: 12, len: 0.5,
                        x: 1.02, y: 0.5,
                        tickfont: { size: 8 },
                    },
                    opacity: 0.7,
                },
                hovertemplate: 'ε₁: %{x:.2f}%<br>ε₂: %{y:.2f}%<br>P: %{marker.color:.3f} PSI<extra></extra>',
            },
        ], {
            ...DARK,
            hovermode: 'closest',
            xaxis: { ...DARK.xaxis, title: { text: 'ε₁ Major (%)', font: { size: 10 } }, range: xRange },
            yaxis: { ...DARK.yaxis, title: { text: 'ε₂ Minor (%)', font: { size: 10 } }, range: yRange },
            legend: {
                x: 0.01, y: 0.99, bgcolor: 'rgba(12,18,32,0.8)',
                bordercolor: '#1e2d45', borderwidth: 1, font: { size: 9 },
            },
            margin: { l: 50, r: 70, t: 20, b: 40 },
        }, CFG);
    }

    // ═══════════════════════════════════════════════════════════
    // Stress vs Time (inflator high-speed data)
    // σ_hoop = P × r / (2t), r = d/2
    // ═══════════════════════════════════════════════════════════

    function renderStressTime(inflatorRows, thicknessUm) {
        const container = document.getElementById('plot-stress-time');
        if (!container) return;

        const hasTh = thicknessUm && thicknessUm > 0;
        const t_m = hasTh ? thicknessUm * 1e-6 : null;

        if (!inflatorRows || inflatorRows.length === 0) {
            container.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px">No inflator data.</p>';
            return;
        }

        const xs = [], ys = [];
        for (const row of inflatorRows) {
            const t = parseFloat(row.elapsed_time);
            const d = parseFloat(row.diameter_inches);
            const p = parseFloat(row.pressure_psi);
            if (isNaN(t) || isNaN(d) || isNaN(p) || d <= 0) continue;
            const P_Pa = p * 6894.76;
            const r_m = (d * 0.0254) / 2;
            if (hasTh) {
                xs.push(t);
                ys.push((P_Pa * r_m) / (2 * t_m) / 1e6);
            } else {
                xs.push(t);
                ys.push((P_Pa * r_m) / 2);
            }
        }

        // Subsample
        const step = Math.max(1, Math.floor(xs.length / 2000));
        const sx = [], sy = [];
        for (let i = 0; i < xs.length; i += step) { sx.push(xs[i]); sy.push(ys[i]); }

        const yLabel = hasTh ? 'σ_hoop (MPa)' : 'Membrane Tension (N/m)';

        _cursorShapes['plot-stress-time'] = [];

        Plotly.newPlot(container, [{
            x: sx, y: sy, mode: 'lines',
            line: { color: '#f87171', width: 1.5 },
            hovertemplate: 't: %{x:.0f}s<br>' + (hasTh ? 'σ: %{y:.2f} MPa' : 'T: %{y:.2f} N/m') + '<extra></extra>',
        }], {
            ...DARK,
            xaxis: { ...DARK.xaxis, title: { text: 'Elapsed Time (s)', font: { size: 10 } } },
            yaxis: { ...DARK.yaxis, title: { text: yLabel, font: { size: 10 } } },
            showlegend: false,
        }, CFG);
    }

    // ═══════════════════════════════════════════════════════════
    // Strain vs Time (inflator high-speed data)
    // ε = (d - d₀) / d₀ engineering strain
    // ═══════════════════════════════════════════════════════════

    function renderStrainTime(inflatorRows) {
        const container = document.getElementById('plot-strain-time');
        if (!container) return;

        if (!inflatorRows || inflatorRows.length === 0) {
            container.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px">No inflator data.</p>';
            return;
        }

        // Find d0
        let d0 = null;
        for (const row of inflatorRows) {
            const d = parseFloat(row.diameter_inches);
            if (!isNaN(d) && d > 0) { d0 = d; break; }
        }
        if (!d0) return;

        const xs = [], ys = [];
        for (const row of inflatorRows) {
            const t = parseFloat(row.elapsed_time);
            const d = parseFloat(row.diameter_inches);
            if (isNaN(t) || isNaN(d) || d <= 0) continue;
            xs.push(t);
            ys.push(((d - d0) / d0) * 100);
        }

        // Subsample
        const step = Math.max(1, Math.floor(xs.length / 2000));
        const sx = [], sy = [];
        for (let i = 0; i < xs.length; i += step) { sx.push(xs[i]); sy.push(ys[i]); }

        _cursorShapes['plot-strain-time'] = [];

        Plotly.newPlot(container, [{
            x: sx, y: sy, mode: 'lines',
            line: { color: '#38bdf8', width: 1.5 },
            hovertemplate: 't: %{x:.0f}s<br>ε: %{y:.2f}%<extra></extra>',
        }], {
            ...DARK,
            xaxis: { ...DARK.xaxis, title: { text: 'Elapsed Time (s)', font: { size: 10 } } },
            yaxis: { ...DARK.yaxis, title: { text: 'Engineering Strain (%)', font: { size: 10 } } },
            showlegend: false,
        }, CFG);
    }

    // ═══════════════════════════════════════════════════════════
    // Stress–Strain (DIC-measured, all frames)
    //
    // σ_hoop = P × r(t) / (2t)
    // r(t) = r_ref × sqrt(1 + ε_areal)
    // All data points shown + windowed average overlay
    // ═══════════════════════════════════════════════════════════

    function renderStressStrain(plateauRows, thicknessUm, frameIndex, materialName, inflatorRows) {
        const container = document.getElementById('plot-stress-strain');
        if (!container) return;

        const hasTh = thicknessUm && thicknessUm > 0;
        const t_m = hasTh ? thicknessUm * 1e-6 : null;
        const yLabel = hasTh ? 'σ_hoop (MPa)' : 'Membrane Tension (N/m)';

        // ── Build stress-strain from inflator log (preferred) ──
        let allStrain = [], allStress = [], allTime = [];
        let d0_in = null;

        if (inflatorRows && inflatorRows.length > 0) {
            // Find first valid diameter as d0
            for (const row of inflatorRows) {
                const d = parseFloat(row.diameter_inches);
                if (!isNaN(d) && d > 0) { d0_in = d; break; }
            }
            if (d0_in) {
                const dMin = d0_in * 0.5; // reject diameters below 50% of d0 (sensor noise / deflated)
                for (const row of inflatorRows) {
                    const d = parseFloat(row.diameter_inches);
                    const p = parseFloat(row.pressure_psi);
                    const t = parseFloat(row.elapsed_time);
                    if (isNaN(d) || isNaN(p) || d < dMin) continue;

                    const eps = (d - d0_in) / d0_in;  // engineering strain
                    const P_Pa = p * 6894.76;
                    const r_m = (d * 0.0254) / 2;

                    let stress;
                    if (hasTh) {
                        stress = (P_Pa * r_m) / (2 * t_m) / 1e6;
                    } else {
                        stress = (P_Pa * r_m) / 2;
                    }
                    allStrain.push(eps * 100);
                    allStress.push(stress);
                    allTime.push(isNaN(t) ? 0 : t);
                }
            }
        }

        // Fallback: DIC per-frame data
        if (allStrain.length === 0 && frameIndex && frameIndex.frames) {
            let r_ref_m = null;
            if (plateauRows && plateauRows.length > 0) {
                const d0 = parseFloat(plateauRows[0].diameter_mean_in);
                if (!isNaN(d0) && d0 > 0) r_ref_m = (d0 * 0.0254) / 2;
            }
            if (r_ref_m) {
                for (const f of frameIndex.frames) {
                    if (f.areal_p50 == null || f.pressure_psi == null) continue;
                    const eps = f.areal_p50;
                    const P_Pa = f.pressure_psi * 6894.76;
                    const r_cur = r_ref_m * Math.sqrt(Math.max(0, 1 + eps));
                    let stress = hasTh ? (P_Pa * r_cur) / (2 * t_m) / 1e6 : (P_Pa * r_cur) / 2;
                    allStrain.push(eps * 100);
                    allStress.push(stress);
                    allTime.push(f.elapsed_s || 0);
                }
            }
        }

        if (allStrain.length === 0) {
            container.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px">No data for stress–strain.</p>';
            return;
        }

        // ── Build time→strain lookup for cursor sync ──
        // Use full-resolution data, subsampled to ~500 entries sorted by time
        {
            const lookupStep = Math.max(1, Math.floor(allTime.length / 500));
            const raw = [];
            for (let i = 0; i < allTime.length; i += lookupStep) {
                raw.push({ t: allTime[i], strain: allStrain[i] });
            }
            raw.sort((a, b) => a.t - b.t);
            _stressStrainLookup = raw;
        }

        // ── Subsample scatter for performance ──
        const step = Math.max(1, Math.floor(allStrain.length / 2000));
        const ss = [], sy = [], st = [];
        for (let i = 0; i < allStrain.length; i += step) {
            ss.push(allStrain[i]); sy.push(allStress[i]); st.push(allTime[i]);
        }

        // ── Windowed average + min/max envelope (sort by strain, sliding window) ──
        const indices = ss.map((_, i) => i).sort((a, b) => ss[a] - ss[b]);
        const winSize = Math.max(10, Math.floor(ss.length * 0.05));
        const avgX = [], avgY = [], minY = [], maxY = [];
        for (let i = 0; i < indices.length; i++) {
            const lo = Math.max(0, i - Math.floor(winSize / 2));
            const hi = Math.min(indices.length, i + Math.ceil(winSize / 2));
            let sx = 0, ssy = 0, n = 0, lo_y = Infinity, hi_y = -Infinity;
            for (let j = lo; j < hi; j++) {
                sx += ss[indices[j]]; ssy += sy[indices[j]]; n++;
                if (sy[indices[j]] < lo_y) lo_y = sy[indices[j]];
                if (sy[indices[j]] > hi_y) hi_y = sy[indices[j]];
            }
            avgX.push(sx / n); avgY.push(ssy / n);
            minY.push(lo_y); maxY.push(hi_y);
        }

        // Smooth min/max with exponential moving average
        const alpha = 0.05; // smoothing factor (lower = smoother)
        const sMinY = [minY[0]], sMaxY = [maxY[0]];
        for (let i = 1; i < minY.length; i++) {
            sMinY.push(alpha * minY[i] + (1 - alpha) * sMinY[i - 1]);
            sMaxY.push(alpha * maxY[i] + (1 - alpha) * sMaxY[i - 1]);
        }

        // Build filled band (smoothed max forward, smoothed min reversed)
        const bandX = [...avgX, ...avgX.slice().reverse()];
        const bandY = [...sMaxY, ...sMinY.slice().reverse()];

        const traces = [
            {
                x: bandX, y: bandY, fill: 'toself', name: 'Min–Max',
                fillcolor: 'rgba(52,211,153,0.12)', line: { width: 0 },
                hoverinfo: 'skip',
            },
            {
                x: ss, y: sy, mode: 'markers', name: 'All Samples',
                marker: { size: 3, color: st, opacity: 0.25,
                    colorscale: [[0, '#2166ac'], [0.5, '#f7f7f7'], [1, '#b2182b']],
                },
                hovertemplate: 'ε: %{x:.2f}%<br>' + (hasTh ? 'σ' : 'T') + ': %{y:.2f}' + (hasTh ? ' MPa' : ' N/m') + '<extra></extra>',
            },
            {
                x: avgX, y: avgY, mode: 'lines', name: 'Windowed Average',
                line: { color: '#34d399', width: 2.5 },
                hovertemplate: 'ε: %{x:.2f}%<br>' + (hasTh ? 'σ' : 'T') + ': %{y:.2f}' + (hasTh ? ' MPa' : ' N/m') + '<extra>Avg</extra>',
            },
            {
                x: avgX, y: sMaxY, mode: 'lines', name: 'Max (smoothed)',
                line: { color: 'rgba(248,113,113,0.6)', width: 1.5 },
                hovertemplate: 'ε: %{x:.2f}%<br>Max: %{y:.2f}' + (hasTh ? ' MPa' : ' N/m') + '<extra></extra>',
            },
            {
                x: avgX, y: sMinY, mode: 'lines', name: 'Min (smoothed)',
                line: { color: 'rgba(96,165,250,0.6)', width: 1.5 },
                hovertemplate: 'ε: %{x:.2f}%<br>Min: %{y:.2f}' + (hasTh ? ' MPa' : ' N/m') + '<extra></extra>',
            },
        ];

        // ── Fit inverse exponential: σ = A·(1 − e^(−B·ε)) ──
        // Saturating curve: stress rises steeply then plateaus toward A.
        // Fit via grid search over A, then log-linear regression for B:
        //   ln(A − σ) = ln(A) − B·ε
        const annotations = [];
        console.log(`Stress-strain: ${allStrain.length} raw pts, ${avgX.length} windowed avg pts, strain range [${Math.min(...avgX).toFixed(2)}, ${Math.max(...avgX).toFixed(2)}], stress range [${Math.min(...avgY).toFixed(2)}, ${Math.max(...avgY).toFixed(2)}]`);

        if (avgX.length > 20) {
            // Subsample the windowed average to ~200 evenly-spaced points for fitting
            const fitStep = Math.max(1, Math.floor(avgX.length / 200));
            const fitX = [], fitY = [];
            for (let i = 0; i < avgX.length; i += fitStep) {
                if (avgY[i] > 0 && isFinite(avgX[i]) && isFinite(avgY[i])) {
                    fitX.push(avgX[i]);
                    fitY.push(avgY[i]);
                }
            }
            console.log(`Stress-strain fit: ${fitX.length} points after filtering (need >10)`);

            if (fitX.length > 10) {
                const yMax = Math.max(...fitY);
                const yMin = Math.min(...fitY);
                const yMean = fitY.reduce((a, b) => a + b, 0) / fitY.length;
                let bestR2 = -Infinity, bestA = yMax, bestB = 0;

                // Grid search: try A from yMax*1.005 to yMax*5 (wide range)
                for (let aFactor = 1.005; aFactor <= 5.0; aFactor += 0.02) {
                    const tryA = yMax * aFactor;
                    // Compute ln(A - σ) for linear regression
                    let sX = 0, sLnR = 0, sXX = 0, sXLnR = 0, n = 0;
                    let valid = true;
                    for (let i = 0; i < fitX.length; i++) {
                        const residual = tryA - fitY[i];
                        if (residual <= 1e-10) { valid = false; break; }
                        const lnR = Math.log(residual);
                        sX += fitX[i]; sLnR += lnR;
                        sXX += fitX[i] * fitX[i]; sXLnR += fitX[i] * lnR;
                        n++;
                    }
                    if (!valid || n < 5) continue;

                    const denom = n * sXX - sX * sX;
                    if (Math.abs(denom) < 1e-15) continue;

                    // ln(A-σ) = ln(A) - B·ε  →  slope = -B
                    const slope = (n * sXLnR - sX * sLnR) / denom;
                    const tryB = -slope; // B should be positive

                    if (tryB <= 0 || !isFinite(tryB)) continue;

                    // Compute R² in original space
                    let ssTot = 0, ssRes = 0;
                    for (let i = 0; i < fitX.length; i++) {
                        const predicted = tryA * (1 - Math.exp(-tryB * fitX[i]));
                        ssTot += (fitY[i] - yMean) ** 2;
                        ssRes += (fitY[i] - predicted) ** 2;
                    }
                    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

                    if (r2 > bestR2) {
                        bestR2 = r2; bestA = tryA; bestB = tryB;
                    }
                }

                console.log(`Stress-strain exp fit: A=${bestA.toFixed(2)}, B=${bestB.toFixed(5)}, R²=${bestR2.toFixed(4)}, n=${fitX.length}`);

                if (bestB > 0 && bestR2 > -1) {
                    // Generate smooth curve from 0 to max strain
                    const xMin = 0, xMax = fitX[fitX.length - 1];
                    const nPts = 150;
                    const curveX = [], curveY = [];
                    for (let i = 0; i < nPts; i++) {
                        const x = xMin + (xMax - xMin) * i / (nPts - 1);
                        curveX.push(x);
                        curveY.push(bestA * (1 - Math.exp(-bestB * x)));
                    }

                    const unit = hasTh ? 'MPa' : 'N/m';
                    const bStr = bestB < 0.01 ? bestB.toExponential(2) : bestB.toFixed(4);
                    const label = `σ = ${bestA.toFixed(1)}·(1−e^(−${bStr}·ε))`;

                    traces.push({
                        x: curveX, y: curveY,
                        mode: 'lines', name: 'Saturating Exp Fit',
                        line: { color: '#fbbf24', width: 2, dash: 'dash' },
                        hovertemplate: `${label}<br>R²=${bestR2.toFixed(3)}<extra>Exp Fit</extra>`,
                    });

                    annotations.push({
                        text: `${label}  (R²=${bestR2.toFixed(2)})`,
                        x: curveX[Math.floor(nPts * 0.55)],
                        y: curveY[Math.floor(nPts * 0.55)],
                        xref: 'x', yref: 'y',
                        showarrow: true, arrowhead: 0, arrowcolor: '#fbbf24',
                        ax: 40, ay: -25,
                        font: { size: 10, color: '#fbbf24' },
                        bgcolor: 'rgba(12,18,32,0.9)', bordercolor: '#fbbf24', borderwidth: 1, borderpad: 4,
                    });
                }
            }
        }

        if (!hasTh) {
            annotations.push({
                text: 'Set material_thickness_um in manifest for σ (MPa)',
                showarrow: false, x: 0.5, y: 0.02, xref: 'paper', yref: 'paper',
                font: { size: 9, color: '#64748b' },
            });
        }

        _cursorShapes['plot-stress-strain'] = [];

        Plotly.newPlot(container, traces, {
            ...DARK,
            xaxis: { ...DARK.xaxis, title: { text: 'Engineering Strain (%)', font: { size: 10 } } },
            yaxis: { ...DARK.yaxis, title: { text: yLabel, font: { size: 10 } } },
            legend: {
                x: 0.01, y: 0.99, bgcolor: 'rgba(12,18,32,0.8)',
                bordercolor: '#1e2d45', borderwidth: 1, font: { size: 9 },
            },
            annotations,
        }, CFG);
    }

    // ═══════════════════════════════════════════════════════════
    // Circumference + Pressure vs Time (synced with video)
    //
    // Circumference computed from DIC strain per frame:
    //   C(t) = π × d_ref × sqrt(1 + ε_areal)  [inches]
    // ═══════════════════════════════════════════════════════════

    function renderCircPressure(frameIndex, plateauRows, inflatorRows) {
        const container = document.getElementById('plot-circ-pressure');
        if (!container) return;

        // ── Use inflator log if available (high-rate real measurements) ──
        const xs = [], circArr = [], pressArr = [];

        if (inflatorRows && inflatorRows.length > 0) {
            // Parse inflator log — skip EVENT rows (no numeric data)
            for (const row of inflatorRows) {
                const t = parseFloat(row.elapsed_time);
                const c = parseFloat(row.circumference_inches);
                const p = parseFloat(row.pressure_psi);
                if (isNaN(t) || isNaN(c)) continue;
                xs.push(t);
                circArr.push(c);
                pressArr.push(isNaN(p) ? null : p);
            }
            // Subsample for Plotly performance (keep ~2000 points)
            if (xs.length > 2000) {
                const step = Math.floor(xs.length / 2000);
                const sx = [], sc = [], sp = [];
                for (let i = 0; i < xs.length; i += step) {
                    sx.push(xs[i]); sc.push(circArr[i]); sp.push(pressArr[i]);
                }
                xs.length = 0; circArr.length = 0; pressArr.length = 0;
                xs.push(...sx); circArr.push(...sc); pressArr.push(...sp);
            }
        } else if (frameIndex && frameIndex.frames) {
            // Fallback: use DIC-derived circumference from frame_index
            let d_ref_in = null;
            if (plateauRows && plateauRows.length > 0) {
                const d0 = parseFloat(plateauRows[0].diameter_mean_in);
                if (!isNaN(d0) && d0 > 0) d_ref_in = d0;
            }
            if (!d_ref_in) {
                container.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px">No inflator log or plateau diameter data.</p>';
                return;
            }
            for (const f of frameIndex.frames) {
                if (f.elapsed_s == null) continue;
                xs.push(f.elapsed_s);
                const eps = f.areal_p50 || 0;
                circArr.push(Math.PI * d_ref_in * Math.sqrt(Math.max(0, 1 + eps)));
                pressArr.push(f.pressure_psi || null);
            }
        }

        if (xs.length === 0) {
            container.innerHTML = '<p style="color:#64748b;text-align:center;padding:40px">No data for circumference chart.</p>';
            return;
        }

        _cursorShapes['plot-circ-pressure'] = [];

        Plotly.newPlot(container, [
            {
                x: xs, y: circArr, name: 'Circumference',
                line: { color: '#38bdf8', width: 2 },
                yaxis: 'y',
                hovertemplate: 'C: %{y:.1f} in<extra>Circumference</extra>',
            },
            {
                x: xs, y: pressArr, name: 'Pressure',
                line: { color: '#f87171', width: 1.5 },
                yaxis: 'y2',
                hovertemplate: 'P: %{y:.3f} PSI<extra>Pressure</extra>',
            },
        ], {
            ...DARK,
            height: 240,
            xaxis: { ...DARK.xaxis, title: { text: 'Elapsed Time (s)', font: { size: 10 } } },
            yaxis: { ...DARK.yaxis, title: { text: 'Circumference (in)', font: { size: 10 } }, side: 'left', range: [75, null] },
            yaxis2: {
                title: { text: 'Pressure (PSI)', font: { size: 10, color: '#f87171' } },
                overlaying: 'y', side: 'right',
                gridcolor: 'rgba(0,0,0,0)', zerolinecolor: '#1e2d45', linecolor: '#1e2d45',
                tickfont: { color: '#f87171' },
            },
            legend: {
                x: 0.01, y: 0.99, bgcolor: 'rgba(12,18,32,0.8)',
                bordercolor: '#1e2d45', borderwidth: 1, font: { size: 9 },
            },
            margin: { l: 55, r: 55, t: 10, b: 40 },
        }, CFG);
    }

    // ═══════════════════════════════════════════════════════════
    // Cursor synchronization
    // ═══════════════════════════════════════════════════════════

    function updateCursor(frameIdx) {
        _setCursor('plot-strain-history', frameIdx);
        // Sync all time-based and value-based charts
        if (_cachedFrameIndex && _cachedFrameIndex.frames && _cachedFrameIndex.frames[frameIdx]) {
            const f = _cachedFrameIndex.frames[frameIdx];
            const elapsed = f.elapsed_s;
            if (elapsed != null) {
                _setCursor('plot-circ-pressure', elapsed);
                _setCursor('plot-stress-time', elapsed);
                _setCursor('plot-strain-time', elapsed);

                // Stress-strain: look up the inflator engineering strain at this
                // elapsed time so the cursor matches the plot's x-axis.
                // (DIC areal strain ≠ diameter-based engineering strain)
                const ssStrain = _lookupStrainAtTime(elapsed);
                if (ssStrain != null) {
                    _setCursor('plot-stress-strain', ssStrain);
                }
            }
            // Biaxiality: cursor at current ε₁ major strain
            if (f.e1_p50 != null) {
                _setCursor('plot-biaxiality', f.e1_p50 * 100);
            }
        }
    }

    /** Binary search _stressStrainLookup for the engineering strain at a given time. */
    function _lookupStrainAtTime(t) {
        const L = _stressStrainLookup;
        if (!L || L.length === 0) return null;
        if (t <= L[0].t) return L[0].strain;
        if (t >= L[L.length - 1].t) return L[L.length - 1].strain;
        // Binary search for closest entry
        let lo = 0, hi = L.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (L[mid].t <= t) lo = mid; else hi = mid;
        }
        // Linear interpolation between lo and hi
        const dt = L[hi].t - L[lo].t;
        if (dt < 1e-9) return L[lo].strain;
        const frac = (t - L[lo].t) / dt;
        return L[lo].strain + frac * (L[hi].strain - L[lo].strain);
    }

    function _setCursor(plotId, xVal) {
        const container = document.getElementById(plotId);
        if (!container || !container._fullLayout) return;
        const base = _cursorShapes[plotId] || [];
        const cursor = {
            type: 'line', xref: 'x', yref: 'paper',
            x0: xVal, x1: xVal, y0: 0, y1: 1,
            line: { color: '#fbbf24', width: 1.5, dash: 'dot' },
        };
        try { Plotly.relayout(container, { shapes: [...base, cursor] }); } catch {}
    }

    // ═══════════════════════════════════════════════════════════
    // Plateau table
    // ═══════════════════════════════════════════════════════════

    function renderPlateauTable(plateauRows) {
        const container = document.getElementById('plateau-table-wrap');
        if (!container || !plateauRows || plateauRows.length === 0) {
            if (container) container.innerHTML = '<p class="muted">No plateau data.</p>';
            return;
        }

        const headers = Object.keys(plateauRows[0]);
        let html = '<table class="data-table"><thead><tr>';
        for (const h of headers) {
            html += `<th>${h.replace(/_/g, ' ')}</th>`;
        }
        html += '</tr></thead><tbody>';
        for (const row of plateauRows) {
            html += '<tr>';
            for (const h of headers) {
                const val = row[h];
                const cls = !isNaN(val) && val !== '' ? ' class="numeric"' : '';
                html += `<td${cls}>${val || '—'}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table>';
        container.innerHTML = html;
    }

    return {
        renderStrainHistory, renderBiaxiality,
        renderStressStrain, renderStressTime, renderStrainTime,
        renderCircPressure, renderPlateauTable, updateCursor,
    };
})();

window.Plots = Plots;
