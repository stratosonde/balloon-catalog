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

        // Define columns: [label, unit, accessor(balloon) → value]
        const fmtDur = s => {
            if (s == null) return null;
            const m = Math.floor(s / 60), sec = Math.round(s % 60);
            return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m ${sec}s`;
        };
        const cols = [
            ['Brand',     '',     b => b.balloon?.brand],
            ['Color',     '',     b => b.balloon?.color],
            ['Size',      '',     b => b.balloon?.size_nominal],
            ['Weight',    'g',    b => b.balloon?.weight_g],
            ['Thick.',    'µm',   b => b.balloon?.material_thickness_um],
            ['Cost',      '$',    b => b.balloon?.cost_usd],
            ['P_max',     'PSI',  b => b.results?.max_pressure_psi],
            ['Ø_max',     'in',   b => b.results?.max_diameter_in],
            ['Plateaus',  '',     b => b.results?.plateaus_detected],
            ['Duration',  '',     b => fmtDur(b.results?.total_duration_s)],
            ['Temp',      '°C',   b => b.test?.temperature_c],
            ['RH',        '%',    b => b.test?.humidity_pct],
        ];

        // Filter out columns where every balloon has null
        const activeCols = cols.filter(([,, acc]) => all.some(b => {
            const v = acc(b); return v != null && v !== '';
        }));

        // Build table: balloons as rows, parameters as columns
        let html = '<table class="comp-table">';

        // Header row
        html += '<thead><tr><th class="comp-corner"></th>';
        for (const [label, unit] of activeCols) {
            html += `<th class="comp-col-header">${_esc(label)}${unit ? `<br><span class="comp-unit">${_esc(unit)}</span>` : ''}</th>`;
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
            html += `<td class="comp-balloon-cell">${thumbHtml}<span class="comp-title">${_esc(b.title)}</span></td>`;
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
