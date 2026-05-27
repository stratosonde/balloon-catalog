/**
 * Catalog — loads catalog.json, renders header dropdown.
 * Simplified for DIC-focused balloon catalog.
 */
const Catalog = (() => {
    let _catalog = null;
    let _onSelect = null;

    async function init(onSelectCallback) {
        _onSelect = onSelectCallback;
        try {
            const resp = await fetch('catalog.json');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            _catalog = await resp.json();
        } catch (e) {
            console.warn('Could not load catalog.json:', e);
            _catalog = { count: 0, balloons: [] };
        }
        _renderDropdown();
        _renderWelcomeStats();
        _renderComparisonTable();

        // Auto-select if only one balloon
        if (_catalog.balloons.length === 1) {
            selectBalloon(_catalog.balloons[0].slug);
        }
    }

    function getAll() { return _catalog ? _catalog.balloons : []; }
    function getBySlug(slug) { return getAll().find(b => b.slug === slug); }

    function _renderDropdown() {
        const select = document.getElementById('balloon-select');
        if (!select) return;
        let html = '<option value="">— Select a test —</option>';
        for (const b of getAll()) {
            const meta = [b.test?.date, b.balloon?.size_nominal].filter(Boolean).join(' · ');
            const label = b.title + (meta ? ` (${meta})` : '');
            html += `<option value="${_esc(b.slug)}">${_esc(label)}</option>`;
        }
        select.innerHTML = html;
        select.onchange = () => {
            if (select.value) selectBalloon(select.value);
        };
    }

    function selectBalloon(slug) {
        const balloon = getBySlug(slug);
        const select = document.getElementById('balloon-select');
        if (select) select.value = slug;
        if (balloon && _onSelect) _onSelect(balloon);
    }

    function _renderWelcomeStats() {
        const all = getAll();
        const el = document.getElementById('welcome-stats');
        const headerEl = document.getElementById('header-stats');
        if (el) {
            el.innerHTML = `
                <div class="stat-box"><div class="stat-value">${all.length}</div><div class="stat-label">Tests</div></div>
            `;
        }
        if (headerEl) {
            headerEl.textContent = `${all.length} test${all.length !== 1 ? 's' : ''}`;
        }
    }

    function _renderComparisonTable() {
        const el = document.getElementById('comparison-table');
        if (!el) return;
        const all = getAll();
        if (all.length === 0) return;

        // Define columns: [label, unit, accessor(balloon) → value, tooltip?]
        const fmtDur = s => {
            if (s == null) return null;
            const m = Math.floor(s / 60), sec = Math.round(s % 60);
            return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m ${sec}s`;
        };
        const truncWords = (text, n) => {
            if (!text) return null;
            const words = String(text).trim().split(/\s+/);
            if (words.length <= n) return words.join(' ');
            return words.slice(0, n).join(' ') + '…';
        };
        const fmtAlt = v => v == null ? null : `${v.toFixed(1)}`;
        const fmtPayload = v => {
            if (v == null) return null;
            if (v < 0) return `<0`;
            return `${Math.round(v)}`;
        };

        const constants = _catalog?.constants || {};
        const refP   = constants.ref_pressure_psi   ?? 0.2;
        const stdM   = constants.std_payload_g      ?? 20;
        const altF   = constants.payload_alt_fraction ?? 0.9;
        const altPct = Math.round(altF * 100);
        const gas    = constants.gas                ?? 'H2';
        const atmos  = constants.atmosphere         ?? 'ISA-1976';
        const liftAssump = `Lift assumes ${gas} fill at ambient temperature, ${atmos} atmosphere, density correction (1 − M_${gas}/M_air) ≈ 0.93.`;

        const cols = [
            ['Brand',     '',     b => b.balloon?.brand],
            ['Color',     '',     b => b.balloon?.color],
            ['Size',      '',     b => b.balloon?.size_nominal],
            ['Weight',    'g',    b => b.balloon?.weight_g,
                'Dry mass of the balloon shell (no payload, no gas).'],
            ['Thick.',    'µm',   b => b.balloon?.material_thickness_um,
                'Wall membrane thickness, used for stress calculation.'],
            ['Cost',      '$',    b => b.balloon?.cost_usd],
            ['P_max',     'PSI',  b => b.results?.max_pressure_psi,
                'Maximum differential pressure reached during the test (burst pressure if the balloon burst).'],
            ['Ø_max',     'in',   b => b.results?.max_diameter_in,
                'Maximum equatorial diameter reached during inflation.'],
            ['Plateaus',  '',     b => b.results?.plateaus_detected,
                'Number of distinct constant-pressure holding periods detected.'],
            ['Duration',  '',     b => fmtDur(b.results?.total_duration_s)],
            ['Temp',      '°C',   b => b.test?.temperature_c],
            ['RH',        '%',    b => b.test?.humidity_pct],
            // ─── Performance metrics @ reference pressure ───────────────────
            [`Ø@${refP}psi`,  'in',   b => b.derived?.diameter_ref_in,
                `Equatorial diameter when internal Δpressure first stabilises at ${refP} psi (median over a ±0.02 psi band, ignoring first 30 s).`],
            [`C@${refP}psi`,  'in',   b => b.derived?.diameter_ref_in != null
                ? +(b.derived.diameter_ref_in * Math.PI).toFixed(1)
                : null,
                `Equatorial circumference at ${refP} psi (π · diameter).`],
            [`V@${refP}psi`,  'L',    b => b.derived?.volume_ref_L,
                `Inflated volume at ${refP} psi, computed as an oblate ellipsoid V = (π/6)·D²·H.`],
            ['FL/M',      '',     b => b.derived?.free_lift_ratio,
                `Free-lift to balloon-mass ratio: (gross lift − balloon mass) / balloon mass at sea level. Larger = more lifting capacity relative to shell weight.`],
            ['h_max',     'km',   b => fmtAlt(b.derived?.max_alt_km),
                `Maximum float altitude with 0 g payload (where ambient density gives lift = balloon mass). ${liftAssump}`],
            [`h@${stdM}g`,    'km',   b => fmtAlt(b.derived?.alt_at_std_payload_km),
                `Float altitude with a ${stdM} g payload. ${liftAssump}`],
            [`Payload@${altPct}%·h_max`, 'g', b => fmtPayload(b.derived?.payload_at_90pct_hmax_g),
                `Useful payload (g) that this balloon could lift to ${altPct} % of its maximum float altitude. Scale-free service-ceiling metric — no fixed altitude assumption. ${liftAssump}`],
            ['Description', '',   b => b.short_description || truncWords(b.notes, 10),
                'One-line summary of the test. Click the row for full details.'],
        ];

        // Filter out columns where every balloon has null
        const activeCols = cols.filter(([,, acc]) => all.some(b => {
            const v = acc(b); return v != null && v !== '';
        }));

        // Build table: balloons as rows, parameters as columns
        let html = '<table class="comp-table">';

        // Header row
        html += '<thead><tr><th class="comp-corner"></th>';
        for (const col of activeCols) {
            const label = col[0], unit = col[1], tip = col[3];
            const tipAttr = tip ? ` title="${_esc(tip)}"` : '';
            const tipClass = tip ? ' has-tip' : '';
            html += `<th class="comp-col-header${tipClass}"${tipAttr}>${_esc(label)}${unit ? `<br><span class="comp-unit">${_esc(unit)}</span>` : ''}</th>`;
        }
        html += '</tr></thead><tbody>';

        // One row per balloon
        for (const b of all) {
            const rawThumb = b.media?.images?.[0];
            const thumbFile = rawThumb ? (typeof rawThumb === 'string' ? rawThumb : rawThumb.file) : null;
            const thumbHtml = thumbFile
                ? `<img src="balloons/${_esc(b.slug)}/images/${_esc(thumbFile)}" alt="" class="comp-thumb">`
                : '';
            html += `<tr class="comp-row" data-slug="${_esc(b.slug)}">`;
            const idxLabel = b.index != null ? `<span class="comp-index">#${b.index}</span> ` : '';
            html += `<td class="comp-balloon-cell">${idxLabel}${thumbHtml}<span class="comp-title">${_esc(b.title)}</span></td>`;
            for (const [,, accessor] of activeCols) {
                const v = accessor(b);
                const display = v != null && v !== '' ? String(v) : '—';
                html += `<td class="comp-value">${_esc(display)}</td>`;
            }
            html += '</tr>';
        }

        html += '</tbody></table>';
        el.innerHTML = html;

        // Make rows clickable
        el.querySelectorAll('.comp-row').forEach(tr => {
            tr.addEventListener('click', () => {
                const slug = tr.dataset.slug;
                if (slug) selectBalloon(slug);
            });
        });
    }

    function _esc(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    return { init, getAll, getBySlug, selectBalloon };
})();

window.Catalog = Catalog;
