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

    function _esc(str) {
        if (!str) return '';
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    return { init, getAll, getBySlug, selectBalloon };
})();

window.Catalog = Catalog;
