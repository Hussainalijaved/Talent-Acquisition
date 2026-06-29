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

  /** Sample one video frame; returns brightness, variance, and person heuristics. */
  function sampleStreamFrame(stream) {
    return sampleStreamMetrics(stream);
  }

  function isSkinTone(r, g, b) {
    return r > 55 && g > 35 && b > 15 && r > g && r > b && (r - g) > 8 && Math.abs(r - b) > 12;
  }

  function sampleStreamMetrics(stream) {
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
          const cx0 = Math.floor(w * 0.18);
          const cx1 = Math.floor(w * 0.82);
          const cy0 = Math.floor(h * 0.12);
          const cy1 = Math.floor(h * 0.88);
          let sum = 0;
          let sumSq = 0;
          let total = 0;
          let centerSum = 0;
          let centerSumSq = 0;
          let centerN = 0;
          let skinPx = 0;
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              const i = (y * w + x) * 4;
              const r = img.data[i];
              const g = img.data[i + 1];
              const b = img.data[i + 2];
              const lum = 0.299 * r + 0.587 * g + 0.114 * b;
              sum += lum;
              sumSq += lum * lum;
              total += 1;
              if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
                centerSum += lum;
                centerSumSq += lum * lum;
                centerN += 1;
                if (isSkinTone(r, g, b)) skinPx += 1;
              }
            }
          }
          const brightness = sum / total;
          const variance = Math.max(0, sumSq / total - brightness * brightness);
          const centerMean = centerSum / centerN;
          const centerVariance = Math.max(0, centerSumSq / centerN - centerMean * centerMean);
          const skinRatio = centerN > 0 ? skinPx / centerN : 0;
          clearTimeout(timer);
          finish({
            brightness,
            variance,
            centerVariance,
            skinRatio,
            width: w,
            height: h,
            video,
          });
        } catch (_) {
          clearTimeout(timer);
          finish(null);
        }
      };
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => finish(null));
    });
  }

  async function detectFaceInStream(stream) {
    if (typeof global.FaceDetector === 'undefined') return null;
    const metrics = await sampleStreamMetrics(stream);
    const video = metrics?.video;
    if (!video) return null;
    try {
      const detector = new global.FaceDetector({ fastMode: true, maxDetectedFaces: 2 });
      const faces = await detector.detect(video);
      return Array.isArray(faces) && faces.length > 0;
    } catch (_) {
      return null;
    } finally {
      try { video.srcObject = null; } catch (_) { /* ignore */ }
    }
  }

  const BLANK_BRIGHTNESS = 18;
  const BLANK_VARIANCE = 6;
  const WEBCAM_MIN_CENTER_VARIANCE = 8;
  const WEBCAM_MIN_SKIN_RATIO = 0.035;
  const SCREEN_MIN_BRIGHTNESS = 12;
  const SCREEN_MIN_VARIANCE = 4;

  function personVisibleHeuristic(metrics, faceDetected) {
    if (!metrics) return false;
    if (faceDetected === true) return true;
    if (metrics.brightness < BLANK_BRIGHTNESS) return false;
    if (metrics.centerVariance < WEBCAM_MIN_CENTER_VARIANCE && metrics.skinRatio < WEBCAM_MIN_SKIN_RATIO) {
      return false;
    }
    return metrics.skinRatio >= WEBCAM_MIN_SKIN_RATIO || metrics.centerVariance >= WEBCAM_MIN_CENTER_VARIANCE * 2;
  }

  function frameLooksBlank(metrics, kind) {
    if (!metrics) return true;
    const minBright = kind === 'screen' ? SCREEN_MIN_BRIGHTNESS : BLANK_BRIGHTNESS;
    const minVar = kind === 'screen' ? SCREEN_MIN_VARIANCE : BLANK_VARIANCE;
    return metrics.brightness < minBright || metrics.variance < minVar;
  }

  async function validateWebcamReady(stream, opts) {
    if (!stream || !isStreamLive(stream)) {
      return {
        ok: false,
        code: 'NOT_LIVE',
        message: 'Your webcam must be on before starting. Enable the camera and try again.',
      };
    }
    const warmupMs = Number(opts?.warmupMs) > 0 ? Number(opts.warmupMs) : 1200;
    const sampleCount = Number(opts?.samples) > 0 ? Number(opts.samples) : 2;
    await sleep(warmupMs);
    let faceDetected = null;
    try {
      faceDetected = await detectFaceInStream(stream);
    } catch (_) {
      faceDetected = null;
    }
    if (faceDetected === true) {
      return { ok: true, code: 'OK', faceDetected: true };
    }
    const samples = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const metrics = await sampleStreamMetrics(stream);
      if (metrics?.video) {
        try { metrics.video.srcObject = null; } catch (_) { /* ignore */ }
        delete metrics.video;
      }
      samples.push(metrics);
      if (i + 1 < sampleCount) await sleep(400);
    }
    const usable = samples.filter((m) => m && !frameLooksBlank(m, 'webcam'));
    const personOk = samples.some((m) => personVisibleHeuristic(m, faceDetected));
    if (usable.length >= Math.ceil(sampleCount / 2) && personOk) {
      return { ok: true, code: 'OK', faceDetected: false, metrics: usable[0] };
    }
    const last = samples[samples.length - 1];
    if (!last || frameLooksBlank(last, 'webcam')) {
      return {
        ok: false,
        code: 'BLANK',
        message:
          'Your webcam shows a black or blank picture. Turn the camera on, remove any lens cover, and make sure you are in a lit area.',
      };
    }
    return {
      ok: false,
      code: 'NO_FACE',
      message:
        'We cannot see you on camera yet. Sit in front of the webcam so your face is clearly visible, then try again.',
    };
  }

  async function validateScreenReady(stream, opts) {
    if (!stream || !isStreamLive(stream)) {
      return {
        ok: false,
        code: 'NOT_LIVE',
        message: 'Screen sharing must stay active. Share your entire monitor again.',
      };
    }
    const warmupMs = Number(opts?.warmupMs) > 0 ? Number(opts.warmupMs) : 900;
    const sampleCount = Number(opts?.samples) > 0 ? Number(opts.samples) : 2;
    await sleep(warmupMs);
    const samples = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const metrics = await sampleStreamMetrics(stream);
      if (metrics?.video) {
        try { metrics.video.srcObject = null; } catch (_) { /* ignore */ }
        delete metrics.video;
      }
      samples.push(metrics);
      if (i + 1 < sampleCount) await sleep(350);
    }
    const usable = samples.filter((m) => m && !frameLooksBlank(m, 'screen'));
    if (usable.length >= Math.ceil(sampleCount / 2)) {
      return { ok: true, code: 'OK', metrics: usable[0] };
    }
    return {
      ok: false,
      code: 'BLANK',
      message:
        'Your shared screen looks blank or black. Share your entire primary monitor (not a blank desktop) and try again.',
    };
  }

  /**
   * Poll a live webcam for blank/black frames (stream still active but no picture).
   * Fires onBlank after consecutive dark/missing frames — distinct from track ended.
   */
  function watchWebcamBlank(stream, onBlank, opts) {
    if (!stream || typeof onBlank !== 'function') return () => {};
    const intervalMs = Number(opts?.intervalMs) > 0 ? Number(opts.intervalMs) : 10000;
    const threshold = Number.isFinite(opts?.threshold) ? opts.threshold : BLANK_BRIGHTNESS;
    const strikesNeeded = Number(opts?.strikesNeeded) > 0 ? Number(opts.strikesNeeded) : 2;
    let blankStrikes = 0;
    let stopped = false;

    const check = async () => {
      if (stopped || !isStreamLive(stream)) return;
      const frame = await sampleStreamMetrics(stream);
      if (frame?.video) {
        try { frame.video.srcObject = null; } catch (_) { /* ignore */ }
      }
      if (!frame || frame.brightness < threshold || frame.variance < BLANK_VARIANCE) {
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
    setTimeout(check, Number(opts?.firstCheckMs) > 0 ? Number(opts.firstCheckMs) : 2500);
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
    sampleStreamMetrics,
    validateWebcamReady,
    validateScreenReady,
    detectFaceInStream,
    watchWebcamBlank,
  };
})(window);
