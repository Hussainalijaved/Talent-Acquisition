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
        ? 'Multiple displays detected. Disconnect extra monitors and detect again.'
        : '',
    };
  }

  function isSingleDisplay(result) {
    return !!(result && Number(result.count) <= 1);
  }

  function multiDisplayBlockMessage(result) {
    const n = Math.max(2, Number(result?.count) || 2);
    return `We detected ${n} displays. This assessment runs on one monitor only — disconnect all extra screens (HDMI, docking station, extended desktop), then detect again.`;
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Map browser getUserMedia errors to actionable candidate messages. */
  function formatWebcamError(err) {
    const name = String(err?.name || '');
    const raw = String(err?.message || '').trim();

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      const e = new Error('Webcam permission was not granted.');
      e.code = 'PERMISSION_DENIED';
      e.name = name;
      return e;
    }

    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      const e = new Error('No camera was found. Connect a webcam (or enable your built-in camera in device settings) and try again.');
      e.code = 'NOT_FOUND';
      e.name = name;
      return e;
    }

    if (name === 'NotReadableError' || /could not start video source/i.test(raw)) {
      const e = new Error(
        'Could not start your camera even though permission is allowed. ' +
        'Another app may be using it (Zoom, Teams, WhatsApp, OBS), or the camera driver failed. ' +
        'Close other apps that use the camera, refresh this page, and click Share Webcam again. ' +
        'If it still fails, restart your browser or try Chrome/Edge on a desktop/laptop.'
      );
      e.code = 'NOT_READABLE';
      e.name = name || 'NotReadableError';
      return e;
    }

    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      const e = new Error('Your camera does not support the required settings. Try a different webcam or browser.');
      e.code = 'OVERCONSTRAINED';
      e.name = name;
      return e;
    }

    if (name === 'AbortError') {
      const e = new Error('Camera access was interrupted. Click Share Webcam to try again.');
      e.code = 'ABORTED';
      e.name = name;
      return e;
    }

    const e = new Error(raw || 'Could not access webcam.');
    e.code = 'UNKNOWN';
    e.name = name;
    return e;
  }

  async function tryGetUserMedia(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  /**
   * Open the webcam with progressive constraint fallbacks.
   * "Could not start video source" (NotReadableError) is usually environmental —
   * camera busy in another app, driver glitch, or OS privacy — not missing permission.
   */
  async function requestWebcam() {
    const attempts = [
      {
        video: {
          facingMode: 'user',
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
        },
        audio: false,
      },
      { video: { facingMode: 'user' }, audio: false },
      { video: true, audio: false },
    ];

    let lastErr = null;

    for (let i = 0; i < attempts.length; i += 1) {
      try {
        return await tryGetUserMedia(attempts[i]);
      } catch (err) {
        lastErr = err;
        if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
          throw formatWebcamError(err);
        }
        if (err && err.name === 'NotReadableError') {
          // Brief pause — sometimes the driver releases after screen-share step.
          await sleep(350);
        }
      }
    }

    // Last resort: pick the first available videoinput explicitly.
    try {
      if (navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter((d) => d.kind === 'videoinput');
        for (const cam of cams) {
          try {
            return await tryGetUserMedia({
              video: cam.deviceId ? { deviceId: { exact: cam.deviceId } } : true,
              audio: false,
            });
          } catch (err) {
            lastErr = err;
            if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
              throw formatWebcamError(err);
            }
          }
        }
      }
    } catch (err) {
      if (err && err.code === 'PERMISSION_DENIED') throw err;
      lastErr = err || lastErr;
    }

    throw formatWebcamError(lastErr || new Error('Could not access webcam.'));
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

  /** Sample one video frame from a live stream; returns brightness 0–255 or null. */
  function sampleStreamFrame(stream) {
    return new Promise((resolve) => {
      if (!stream || !isStreamLive(stream)) {
        resolve(null);
        return;
      }
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.srcObject = stream;
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        try { video.srcObject = null; } catch (_) { /* ignore */ }
        resolve(val);
      };
      const timer = setTimeout(() => finish(null), 8000);
      video.onloadeddata = () => {
        try {
          const vw = video.videoWidth || 640;
          const vh = video.videoHeight || 360;
          if (vw < 8 || vh < 8) {
            clearTimeout(timer);
            finish(null);
            return;
          }
          const w = Math.min(320, vw);
          const h = Math.max(1, Math.round(vh * (w / vw)));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, w, h);
          const img = ctx.getImageData(0, 0, w, h);
          let sum = 0;
          for (let i = 0; i < img.data.length; i += 4) {
            sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
          }
          clearTimeout(timer);
          finish({ brightness: sum / (img.data.length / 4), width: w, height: h });
        } catch (_) {
          clearTimeout(timer);
          finish(null);
        }
      };
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => finish(null));
    });
  }

  /**
   * Poll a live webcam for blank/black frames (stream still active but no picture).
   * Fires onBlank after consecutive dark/missing frames — distinct from track ended.
   */
  function watchWebcamBlank(stream, onBlank, opts) {
    if (!stream || typeof onBlank !== 'function') return () => {};
    const intervalMs = Number(opts?.intervalMs) > 0 ? Number(opts.intervalMs) : 10000;
    const threshold = Number.isFinite(opts?.threshold) ? opts.threshold : 18;
    const strikesNeeded = Number(opts?.strikesNeeded) > 0 ? Number(opts.strikesNeeded) : 2;
    let blankStrikes = 0;
    let stopped = false;

    const check = async () => {
      if (stopped || !isStreamLive(stream)) return;
      const frame = await sampleStreamFrame(stream);
      if (!frame || frame.brightness < threshold) {
        blankStrikes += 1;
        if (blankStrikes >= strikesNeeded) {
          onBlank({ brightness: frame?.brightness ?? 0, stream });
          blankStrikes = 0;
        }
      } else {
        blankStrikes = 0;
      }
    };

    const id = setInterval(check, intervalMs);
    setTimeout(check, 6000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }

  global.TA_PROCTOR = {
    isSupported,
    detectScreens,
    isSingleDisplay,
    multiDisplayBlockMessage,
    requestScreenShare,
    requestWebcam,
    formatWebcamError,
    attachStream,
    stopStream,
    stopAll,
    isStreamLive,
    trackLabel,
    watchStreamEnd,
    sampleStreamFrame,
    watchWebcamBlank,
  };
})(window);
