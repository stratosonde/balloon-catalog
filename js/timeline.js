/**
 * Timeline — simplified scrubber and playback controls.
 * Manages frame index, play/pause, keyboard nav.
 */
const Timeline = (() => {
    let _frameIndex = null;   // { image_size, total_frames, total_dots, frames: [...] }
    let _currentIdx = 0;
    let _playing = false;
    let _playInterval = null;
    let _onChange = null;      // callback(idx, frameEntry)
    let _fps = 8;             // playback speed

    function load(frameIndex) {
        _frameIndex = frameIndex;
        _currentIdx = 0;
        _stop();

        const slider = document.getElementById('timeline-slider');
        if (slider && _frameIndex) {
            slider.max = _frameIndex.frames.length - 1;
            slider.value = 0;
        }

        _updateReadout();
    }

    function setupControls() {
        const slider = document.getElementById('timeline-slider');
        const btnPlay = document.getElementById('btn-play');
        const btnPrev = document.getElementById('btn-prev');
        const btnNext = document.getElementById('btn-next');

        if (slider) {
            slider.addEventListener('input', () => {
                setFrame(parseInt(slider.value, 10));
            });
        }
        if (btnPlay) btnPlay.addEventListener('click', togglePlay);
        if (btnPrev) btnPrev.addEventListener('click', prev);
        if (btnNext) btnNext.addEventListener('click', next);

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
            if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
            if (e.key === ' ') { e.preventDefault(); togglePlay(); }
        });
    }

    function setFrame(idx) {
        if (!_frameIndex) return;
        _currentIdx = Math.max(0, Math.min(idx, _frameIndex.frames.length - 1));
        const slider = document.getElementById('timeline-slider');
        if (slider) slider.value = _currentIdx;
        _updateReadout();
        if (_onChange) _onChange(_currentIdx, getCurrentFrame());
    }

    function prev() { setFrame(_currentIdx - 1); }
    function next() { setFrame(_currentIdx + 1); }

    function togglePlay() {
        if (_playing) _stop(); else _play();
    }

    function _play() {
        _playing = true;
        const btn = document.getElementById('btn-play');
        if (btn) btn.textContent = '⏸';
        // Use requestAnimationFrame + async loop instead of setInterval
        // This ensures each frame finishes loading before advancing
        _playLoop();
    }

    async function _playLoop() {
        if (!_playing || !_frameIndex) return;
        const start = performance.now();

        if (_currentIdx < _frameIndex.frames.length - 1) {
            _currentIdx++;
            const slider = document.getElementById('timeline-slider');
            if (slider) slider.value = _currentIdx;
            _updateReadout();
            if (_onChange) await _onChange(_currentIdx, getCurrentFrame());

            // Wait for the target frame interval, minus time spent loading
            const elapsed = performance.now() - start;
            const wait = Math.max(0, (1000 / _fps) - elapsed);
            if (_playing) {
                _playInterval = setTimeout(() => _playLoop(), wait);
            }
        } else {
            _stop();
        }
    }

    function _stop() {
        _playing = false;
        const btn = document.getElementById('btn-play');
        if (btn) btn.textContent = '▶';
        if (_playInterval) { clearTimeout(_playInterval); _playInterval = null; }
    }

    function onChange(fn) { _onChange = fn; }

    function getCurrentFrame() {
        if (!_frameIndex) return null;
        return _frameIndex.frames[_currentIdx] || null;
    }

    function getIndex() { return _currentIdx; }
    function getFrameCount() { return _frameIndex ? _frameIndex.frames.length : 0; }
    function getFrameIndex() { return _frameIndex; }

    function _updateReadout() {
        const frame = getCurrentFrame();
        const total = _frameIndex ? _frameIndex.frames.length : 0;

        const roFrame = document.getElementById('ro-frame');
        const roPressure = document.getElementById('ro-pressure');
        const roStrain = document.getElementById('ro-strain');
        const roTime = document.getElementById('ro-time');

        if (roFrame) roFrame.textContent = `${_currentIdx + 1} / ${total}`;

        if (frame) {
            if (roPressure) {
                roPressure.textContent = frame.pressure_psi != null
                    ? `${frame.pressure_psi.toFixed(3)} PSI` : '— PSI';
            }
            if (roStrain) {
                roStrain.textContent = frame.areal_p50 != null
                    ? `ε: ${(frame.areal_p50 * 100).toFixed(2)}%` : 'ε: —';
            }
            if (roTime && frame.elapsed_s != null) {
                const m = Math.floor(frame.elapsed_s / 60);
                const s = Math.floor(frame.elapsed_s % 60);
                roTime.textContent = `${m}:${s.toString().padStart(2, '0')}`;
            }
        }
    }

    return {
        load, setupControls, setFrame, prev, next, togglePlay,
        onChange, getCurrentFrame, getIndex, getFrameCount, getFrameIndex,
    };
})();

window.Timeline = Timeline;
