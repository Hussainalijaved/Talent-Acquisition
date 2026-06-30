/**
 * CONVO — proctor activity (events + screen describe + snapshots on flagged events).
 */
(function (global) {
  'use strict';

  const DESCRIBE_INTERVAL_MS = 90000;
  const BLANK_CHECK_MS = 45000;
  const SUSPICIOUS_CATEGORIES = new Set([
    'snipping_tool',
    'screenshot',
    'devtools',
    'tab_switch',
    'window_blur',
    'screen_blank',
    'screen_share_stopped',
    'webcam_lost',
    'webcam_no_signal',
    'camera_not_restored',
    'blocked_shortcut',
    'print_attempt',
    'fullscreen_exit',
  ]);

  const CATEGORY_SUMMARY = {
    test_started: 'Assessment test started.',
    question_opened: 'Candidate opened an assessment question.',
    tab_switch: 'Candidate left the assessment tab or hid the browser window.',
    window_blur: 'Assessment window lost focus — another app or window may be active.',
    devtools: 'Developer tools shortcut or inspect attempt detected.',
    fullscreen_exit: 'Candidate exited fullscreen mode.',
    blocked_shortcut: 'Blocked keyboard shortcut used (F12, view source, etc.).',
    screenshot: 'Print Screen or screenshot key attempt blocked.',
    snipping_tool: 'Snipping Tool or Win+Shift+S screen capture attempt blocked.',
    screenshot_tool: 'Screenshot or screen capture tool attempt detected.',
    ai_tool: 'AI assistant or generative AI tool detected on shared screen.',
    communication_app: 'Messaging, email, or communication application detected on shared screen.',
    print_attempt: 'Print or save-page attempt blocked.',
    webcam_lost: 'Webcam was turned off or blocked.',
    webcam_no_signal: 'Webcam shows a blank or black screen — no picture detected.',
    webcam_restored: 'Webcam was re-enabled within the grace period.',
    camera_not_restored: 'Webcam was not restored — assessment terminated.',
    screen_share_stopped: 'Screen sharing was stopped.',
    screen_blank: 'Shared screen appears blank, minimized, or showing desktop only.',
    screen_content: 'Periodic shared-screen activity check.',
    webcam_content: 'Webcam monitoring snapshot captured.',
    identity_check: 'Identity verification — comparing profile photo with webcam.',
    session_start: 'Proctored assessment monitoring started.',
    activity: 'Proctoring activity noted.',
  };

  function portalBaseUrl(explicit) {
    const raw = String(explicit || '').trim();
    if (raw) return raw.replace(/\/+$/, '');
    if (global.location && global.location.origin) return global.location.origin.replace(/\/+$/, '');
    return 'https://talent-acquisition-six.vercel.app';
  }

  function isSuspicious(category) {
    return SUSPICIOUS_CATEGORIES.has(String(category || '').trim());
  }

  function summaryFor(category, extra) {
    const base = CATEGORY_SUMMARY[category] || CATEGORY_SUMMARY.activity;
    const tail = extra ? ` ${String(extra).trim()}` : '';
    return (base + tail).trim();
  }

  class ProctorActivityMonitor {
    constructor() {
      this.running = false;
      this.sessionId = '';
      this.portalBase = '';
      this.getPhase = () => null;
      this.getStreams = () => null;
      this.describeTimer = null;
      this.blankTimer = null;
      this.pendingDescribe = false;
      this.lastBlankLogAt = 0;
      this.lastDescribeAt = 0;
    }

    async post(payload) {
      if (!this.sessionId) return null;
      const base = portalBaseUrl(this.portalBase);
      try {
        const res = await fetch(`${base}/api/proctor-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: this.sessionId, ...payload }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) console.warn('[proctor-activity] API:', json.error || res.status);
        return json;
      } catch (err) {
        console.warn('[proctor-activity] network:', err.message);
        return null;
      }
    }

    logEvent(category, summary, opts) {
      if (!this.running || !this.sessionId) return;
      const cat = String(category || 'activity').trim();
      const text = String(summary || summaryFor(cat)).trim();
      if (!text) return;
      void this.post({
        action: 'event',
        phase: typeof opts?.phase === 'number' ? opts.phase : this.getPhase?.(),
        category: cat,
        summary: text,
        suspicious: opts?.suspicious != null ? !!opts.suspicious : isSuspicious(cat),
        meta: opts?.meta || undefined,
      });
    }

    logViolation(reason, extra) {
      void this.logViolationAsync(reason, extra);
    }

    async captureViolationSnapshots() {
      const streams = this.getStreams?.();
      if (!streams) return null;
      const out = { screen: null, webcam: null, thumb: null, webcamThumb: null };
      const screens = streams.screens || [];
      if (screens[0]) {
        const frame = await this.captureFrameFromStream(screens[0]);
        if (frame?.base64) {
          out.screen = frame.base64;
          out.thumb = frame.thumbBase64 || null;
        }
      }
      if (streams.webcam) {
        const frame = await this.captureFrameFromStream(streams.webcam);
        if (frame?.base64) {
          out.webcam = frame.base64;
          out.webcamThumb = frame.thumbBase64 || null;
        }
      }
      return out;
    }

    async captureWebcamSnapshot() {
      const streams = this.getStreams?.();
      if (!streams?.webcam) return null;
      const frame = await this.captureFrameFromStream(streams.webcam);
      if (!frame?.base64 || frame.base64.length < 500) return null;
      return frame;
    }

    async logViolationAsync(reason, extra) {
      if (!this.running || !this.sessionId) return;
      const cat = String(reason || 'activity').trim();
      const text = summaryFor(cat, extra);
      const snaps = await this.captureViolationSnapshots();
      void this.post({
        action: 'event',
        phase: this.getPhase?.(),
        category: cat,
        summary: text,
        suspicious: true,
        frame_base64: snaps?.screen || undefined,
        webcam_base64: snaps?.webcam || undefined,
        thumb_base64: snaps?.thumb || undefined,
        webcam_thumb_base64: snaps?.webcamThumb || undefined,
      });
      if (reason === 'snipping_tool' || reason === 'screenshot') {
        void this.describeNow({ suspicious: true });
      } else if (reason === 'tab_switch' || reason === 'window_blur') {
        void this.describeNow({ suspicious: true });
      }
    }

    logQuestionOpened(questionNumber, label) {
      const n = Number(questionNumber);
      if (!Number.isFinite(n) || n < 1) return;
      const text = label || `Opened question ${n}.`;
      this.logEvent('question_opened', text, {
        suspicious: false,
        meta: { question_number: n },
      });
    }

    logTestStarted() {
      this.logEvent('test_started', 'Assessment test started.', { suspicious: false });
    }

    captureFrameFromStream(stream) {
      return new Promise((resolve) => {
        if (!stream || !global.TA_PROCTOR?.isStreamLive?.(stream)) {
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
            const w = Math.min(640, vw);
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
            const brightness = sum / (img.data.length / 4);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.52);
            const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            let thumbBase64 = '';
            try {
              const tw = Math.min(240, w);
              const th = Math.max(1, Math.round(h * (tw / w)));
              const tc = document.createElement('canvas');
              tc.width = tw;
              tc.height = th;
              tc.getContext('2d').drawImage(canvas, 0, 0, tw, th);
              thumbBase64 = tc.toDataURL('image/jpeg', 0.38).replace(/^data:image\/\w+;base64,/, '');
            } catch (_) { /* ignore */ }
            clearTimeout(timer);
            finish({ base64, thumbBase64, brightness, width: w, height: h });
          } catch (_) {
            clearTimeout(timer);
            finish(null);
          }
        };
        const p = video.play();
        if (p && typeof p.catch === 'function') p.catch(() => finish(null));
      });
    }

    async describeScreens(opts) {
      if (!this.running || this.pendingDescribe) return;
      const streams = this.getStreams?.();
      const screens = streams?.screens || [];
      const webcamFrame = await this.captureWebcamSnapshot();
      if (!screens.length && !webcamFrame) return;

      this.pendingDescribe = true;
      try {
        for (let i = 0; i < screens.length; i += 1) {
          const frame = await this.captureFrameFromStream(screens[i]);
          if (!frame?.base64) continue;

          if (frame.brightness < 18) {
            const now = Date.now();
            if (now - this.lastBlankLogAt > 30000) {
              this.lastBlankLogAt = now;
              void this.post({
                action: 'event',
                phase: typeof opts?.phase === 'number' ? opts.phase : this.getPhase?.(),
                category: 'screen_blank',
                summary: `Screen ${i + 1} appears blank or minimized (dark frame).`,
                suspicious: true,
                frame_base64: frame.base64,
                thumb_base64: frame.thumbBase64 || undefined,
                webcam_base64: webcamFrame?.base64 || undefined,
                webcam_thumb_base64: webcamFrame?.thumbBase64 || undefined,
                meta: { screen_index: i },
              });
            }
            continue;
          }

          await this.post({
            action: 'describe',
            phase: typeof opts?.phase === 'number' ? opts.phase : this.getPhase?.(),
            screen_index: i,
            frame_base64: frame.base64,
            thumb_base64: frame.thumbBase64 || undefined,
            webcam_base64: webcamFrame?.base64 || undefined,
            webcam_thumb_base64: webcamFrame?.thumbBase64 || undefined,
            suspicious: !!opts?.suspicious,
          });
          this.lastDescribeAt = Date.now();
        }

        // Periodic / flagged checks: store webcam even when screen describe is skipped.
        if (webcamFrame && !screens.length) {
          await this.post({
            action: 'event',
            phase: typeof opts?.phase === 'number' ? opts.phase : this.getPhase?.(),
            category: 'webcam_content',
            summary: 'Webcam monitoring snapshot captured.',
            suspicious: !!opts?.suspicious,
            webcam_base64: webcamFrame.base64,
            webcam_thumb_base64: webcamFrame.thumbBase64 || undefined,
          });
        }
      } finally {
        this.pendingDescribe = false;
      }
    }

    async describeNow(opts) {
      await this.describeScreens({ ...opts, suspicious: opts?.suspicious });
    }

    tickBlankCheck() {
      if (!this.running) return;
      const streams = this.getStreams?.();
      (streams?.screens || []).forEach(async (stream, i) => {
        const frame = await this.captureFrameFromStream(stream);
        if (!frame || frame.brightness >= 18) return;
        const now = Date.now();
        if (now - this.lastBlankLogAt < 30000) return;
        this.lastBlankLogAt = now;
        const webcamFrame = await this.captureWebcamSnapshot();
        void this.post({
          action: 'event',
          phase: this.getPhase?.(),
          category: 'screen_blank',
          summary: `Screen ${i + 1} appears blank or minimized.`,
          suspicious: true,
          frame_base64: frame.base64,
          thumb_base64: frame.thumbBase64 || undefined,
          webcam_base64: webcamFrame?.base64 || undefined,
          webcam_thumb_base64: webcamFrame?.thumbBase64 || undefined,
          meta: { screen_index: i },
        });
      });
    }

    async runIdentityCheck(checkPoint) {
      const sid = this.sessionId;
      if (!sid) return;
      const frame = await this.captureWebcamSnapshot();
      if (!frame?.base64) return;
      try {
        await this.post({
          action: 'identity_check',
          check_point: checkPoint || 'start',
          phase: this.getPhase?.(),
          webcam_base64: frame.base64,
          webcam_thumb_base64: frame.thumbBase64 || undefined,
        });
      } catch (err) {
        console.warn('[proctor-activity] identity check failed:', err.message);
      }
    }

    start(options) {
      this.stop({ skipFinalize: true });
      this.sessionId = String(options?.sessionId || '').trim();
      this.portalBase = options?.portalBase || '';
      this.getPhase = typeof options?.getPhase === 'function' ? options.getPhase : () => null;
      this.getStreams = typeof options?.getStreams === 'function' ? options.getStreams : () => null;
      if (!this.sessionId) return;

      this.running = true;
      this.logTestStarted();

      this.describeTimer = setInterval(() => {
        void this.describeScreens({ suspicious: false });
      }, DESCRIBE_INTERVAL_MS);

      this.blankTimer = setInterval(() => this.tickBlankCheck(), BLANK_CHECK_MS);

      setTimeout(() => void this.describeScreens({ suspicious: false }), 12000);
      setTimeout(() => void this.runIdentityCheck('start'), 10000);
    }

    stop(opts) {
      this.running = false;
      if (this.describeTimer) {
        clearInterval(this.describeTimer);
        this.describeTimer = null;
      }
      if (this.blankTimer) {
        clearInterval(this.blankTimer);
        this.blankTimer = null;
      }
      const sid = this.sessionId;
      if (!opts?.skipFinalize && sid) {
        void fetch(`${portalBaseUrl(this.portalBase)}/api/proctor-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'finalize', session_id: sid }),
        }).catch(() => {});
      }
      if (opts?.skipFinalize) return;
      this.sessionId = '';
    }
  }

  const monitor = new ProctorActivityMonitor();

  global.TA_PROCTOR_ACTIVITY = {
    start: (opts) => monitor.start(opts),
    stop: (opts) => monitor.stop(opts),
    logEvent: (category, summary, opts) => monitor.logEvent(category, summary, opts),
    logViolation: (reason, extra) => monitor.logViolation(reason, extra),
    logQuestionOpened: (n, label) => monitor.logQuestionOpened(n, label),
    logTestStarted: () => monitor.logTestStarted(),
    describeNow: (opts) => monitor.describeNow(opts),
    runIdentityCheck: (checkPoint) => monitor.runIdentityCheck(checkPoint),
    summaryFor,
    isSuspicious,
  };
})(typeof window !== 'undefined' ? window : globalThis);
