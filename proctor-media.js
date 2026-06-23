/**
 * CONVO — pre-assessment proctoring (screen detection, screen share, webcam).
 * Browser APIs only; loaded before index.html React app.
 */
(function (global) {
  'use strict';

  function isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async function detectScreens() {
    if (typeof window.getScreenDetails === 'function') {
      const details = await window.getScreenDetails();
      const screens = Array.isArray(details.screens) ? details.screens : [];
      return {
        count: Math.max(1, screens.length),
        screens: screens.map((s, i) => ({
          label: String(s.label || `Display ${i + 1}`).trim(),
          width: s.width || null,
          height: s.height || null,
        })),
        method: 'screen-details',
      };
    }

    const extended = !!(window.screen && window.screen.isExtended);
    const count = extended ? 2 : 1;
    return {
      count,
      screens: Array.from({ length: count }, (_, i) => ({
        label: `Display ${i + 1}`,
        width: null,
        height: null,
      })),
      method: extended ? 'extended-heuristic' : 'single-display',
      note: extended
        ? 'Multiple displays detected. You will share each monitor one at a time in the next step.'
        : '',
    };
  }

  async function requestScreenShare() {
    const constraints = {
      video: {
        cursor: 'always',
        displaySurface: 'monitor',
      },
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      systemAudio: 'exclude',
    };
    try {
      return await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        const e = new Error('Screen sharing permission was not granted.');
        e.code = 'PERMISSION_DENIED';
        throw e;
      }
      throw err;
    }
  }

  async function requestWebcam() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
        },
        audio: false,
      });
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        const e = new Error('Webcam permission was not granted.');
        e.code = 'PERMISSION_DENIED';
        throw e;
      }
      throw err;
    }
  }

  function attachStream(videoEl, stream) {
    if (!videoEl || !stream) return () => {};
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.autoplay = true;
    const p = videoEl.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return () => {
      if (videoEl.srcObject === stream) videoEl.srcObject = null;
    };
  }

  function stopStream(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    stream.getTracks().forEach((t) => {
      try { t.stop(); } catch (_) { /* ignore */ }
    });
  }

  function stopAll(streams) {
    if (!streams) return;
    stopStream(streams.webcam);
    (streams.screens || []).forEach(stopStream);
  }

  function isStreamLive(stream) {
    if (!stream) return false;
    const tracks = stream.getVideoTracks();
    return tracks.length > 0 && tracks.some((t) => t.readyState === 'live');
  }

  function trackLabel(stream, fallback) {
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    if (!track) return fallback || 'Stream';
    const settings = track.getSettings ? track.getSettings() : {};
    if (settings.displaySurface === 'monitor') return 'Monitor';
    if (settings.displaySurface === 'window') return 'Window';
    if (settings.displaySurface === 'browser') return 'Tab';
    return track.label || fallback || 'Stream';
  }

  function watchStreamEnd(stream, onEnd) {
    if (!stream || typeof onEnd !== 'function') return () => {};
    const handlers = [];
    stream.getTracks().forEach((track) => {
      const fn = () => onEnd({ stream, track });
      track.addEventListener('ended', fn);
      handlers.push({ track, fn });
    });
    return () => {
      handlers.forEach(({ track, fn }) => track.removeEventListener('ended', fn));
    };
  }

  global.TA_PROCTOR = {
    isSupported,
    detectScreens,
    requestScreenShare,
    requestWebcam,
    attachStream,
    stopStream,
    stopAll,
    isStreamLive,
    trackLabel,
    watchStreamEnd,
  };
})(window);
