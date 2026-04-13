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
            const meta = [b.test?.date, b.balloon?.material].filter(Boolean).join(' · ');
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

        // Define rows: [label, unit, accessor(balloon) → value]
        const fmtDur = s => {
            if (s == null) return null;
            const m = Math.floor(s / 60), sec = Math.round(s % 60);
            return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m ${sec}s`;
        };
        const rows = [
            ['Max Pressure',  'PSI',  b => b.results?.max_pressure_psi],
            ['Max Diameter',  'in',   b => b.results?.max_diameter_in],
            ['Thickness',     'µm',   b => b.balloon?.material_thickness_um],
            ['Plateaus',      '',     b => b.results?.plateaus_detected],
            ['Duration',      '',     b => fmtDur(b.results?.total_duration_s)],
            ['Pressure Steps','',     b => b.test?.pressures_psi?.length],
            ['Temperature',   '°C',   b => b.test?.temperature_c],
            ['Humidity',      '%',    b => b.test?.humidity_pct],
            ['Atm. Pressure', 'hPa',  b => b.results?.station_pressure_hpa],
        ];

        // Build table HTML
        let html = '<table class="comp-table">';

        // Header row: empty corner + one column per balloon
        html += '<thead><tr><th></th>';
        for (const b of all) {
            const thumb = b.media?.images?.[0];
            const thumbHtml = thumb
                ? `<img src="balloons/${_esc(b.slug)}/${_esc(thumb.file)}" alt="" class="comp-thumb">`
                : '';
            html += `<th class="comp-balloon" data-slug="${_esc(b.slug)}">${thumbHtml}<span class="comp-title">${_esc(b.title)}</span></th>`;
        }
        html += '</tr></thead><tbody>';

        // Data rows
        for (const [label, unit, accessor] of rows) {
            // Skip row if all values are null/empty
            const vals = all.map(accessor);
            if (vals.every(v => v == null || v === '')) continue;

            html += `<tr><td class="comp-label">${_esc(label)}${unit ? ` <span class="comp-unit">(${_esc(unit)})</span>` : ''}</td>`;
            for (const v of vals) {
                const display = v != null && v !== '' ? String(v) : '—';
                html += `<td class="comp-value">${_esc(display)}</td>`;
            }
            html += '</tr>';
        }

        html += '</tbody></table>';
        el.innerHTML = html;

        // Make column headers clickable
        el.querySelectorAll('.comp-balloon').forEach(th => {
            th.addEventListener('click', () => {
                const slug = th.dataset.slug;
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
