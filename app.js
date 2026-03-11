// ── app.js ────────────────────────────────────────────────────────────────
// Eye-track calibration PWA  –  v2 (9-point numpad, white screen, black ball)
// All times in ms from trial start (performance.now() offset)
// Ball positions in normalised screen coords [0,1] and pixels
// ──────────────────────────────────────────────────────────────────────────

'use strict';

// ── Service worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  mode:          null,   // 'numpad9' | 'fig8' | 'box' | 'arena'
  cameraStream:  null,
  mediaRecorder: null,
  videoChunks:   [],
  videoBlob:     null,
  ballLog:       [],     // [{t_ms, x_px, y_px, x_norm, y_norm, phase}]
  t0:            null,   // performance.now() at trial start
  animId:        null,
  timerInterval: null,
};

// ── Utility ────────────────────────────────────────────────────────────────
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Path generators ────────────────────────────────────────────────────────

/**
 * numpad9: 9-point grid (corners + mid-edges + centre)
 * Visit order is RANDOMISED every trial.
 * 2500 ms dwell per point + 500 ms smooth transition = ~27 s total.
 */
function makeNumpad9Path(W, H) {
  const PAD      = 0.10;
  const DWELL_MS = 2500;
  const MOVE_MS  = 500;
  const HOLD_MS  = DWELL_MS + MOVE_MS;

  const allPoints = [
    { x: PAD,       y: PAD,       label: 'NW' },
    { x: 0.5,       y: PAD,       label: 'N'  },
    { x: 1 - PAD,   y: PAD,       label: 'NE' },
    { x: PAD,       y: 0.5,       label: 'W'  },
    { x: 0.5,       y: 0.5,       label: 'C'  },
    { x: 1 - PAD,   y: 0.5,       label: 'E'  },
    { x: PAD,       y: 1 - PAD,   label: 'SW' },
    { x: 0.5,       y: 1 - PAD,   label: 'S'  },
    { x: 1 - PAD,   y: 1 - PAD,   label: 'SE' },
  ];

  const sequence = shuffle([...allPoints]);
  const TOTAL_MS = sequence.length * HOLD_MS;

  return function(t_ms) {
    const tmod = Math.min(t_ms, TOTAL_MS - 1);
    const seg  = Math.min(Math.floor(tmod / HOLD_MS), sequence.length - 1);
    const into = tmod % HOLD_MS;
    const cur  = sequence[seg];
    const nxt  = sequence[(seg + 1) % sequence.length];

    let x, y;
    if (into < DWELL_MS) {
      x = cur.x; y = cur.y;
    } else {
      const alpha = easeInOut((into - DWELL_MS) / MOVE_MS);
      x = cur.x + (nxt.x - cur.x) * alpha;
      y = cur.y + (nxt.y - cur.y) * alpha;
    }

    return {
      x_norm: x, y_norm: y,
      phase: cur.label,
      done: tmod >= TOTAL_MS - 50,
      total_ms: TOTAL_MS,
      point_index: seg,
      point_total: sequence.length,
      dwell_pct: Math.min(into / DWELL_MS, 1),
    };
  };
}

/**
 * fig8: lemniscate of Bernoulli
 */
function makeFig8Path(W, H) {
  const PERIOD_MS = 6000;
  const LOOPS     = 4;
  const TOTAL_MS  = PERIOD_MS * LOOPS;
  const scaleX    = 0.38;
  const scaleY    = 0.32;

  return function(t_ms) {
    const tmod  = Math.min(t_ms, TOTAL_MS - 1);
    const theta = (tmod / PERIOD_MS) * 2 * Math.PI;
    const denom = 1 + Math.sin(theta) * Math.sin(theta);
    return {
      x_norm: 0.5 + scaleX * Math.cos(theta) / denom,
      y_norm: 0.5 + scaleY * Math.sin(theta) * Math.cos(theta) / denom,
      phase: `loop-${Math.floor(tmod / PERIOD_MS) + 1}`,
      done: tmod >= TOTAL_MS - 50,
      total_ms: TOTAL_MS,
      dwell_pct: 1,
    };
  };
}

/**
 * box: rectangle saccade test
 */
function makeBoxPath(W, H) {
  const PAD      = 0.12;
  const SIDE_MS  = 1800;
  const PAUSE_MS = 400;
  const SEG_MS   = SIDE_MS + PAUSE_MS;
  const LOOPS    = 3;

  const corners = [
    { x: PAD,       y: PAD       },
    { x: 1 - PAD,   y: PAD       },
    { x: 1 - PAD,   y: 1 - PAD   },
    { x: PAD,       y: 1 - PAD   },
  ];
  const TOTAL_MS = corners.length * SEG_MS * LOOPS;

  return function(t_ms) {
    const tmod = Math.min(t_ms, TOTAL_MS - 1);
    const seg  = Math.floor(tmod / SEG_MS) % corners.length;
    const into = tmod % SEG_MS;
    const cur  = corners[seg];
    const nxt  = corners[(seg + 1) % corners.length];

    let x, y;
    if (into < PAUSE_MS) {
      x = cur.x; y = cur.y;
    } else {
      const alpha = (into - PAUSE_MS) / SIDE_MS;
      x = cur.x + (nxt.x - cur.x) * alpha;
      y = cur.y + (nxt.y - cur.y) * alpha;
    }
    return {
      x_norm: x, y_norm: y,
      phase: `corner-${seg}`,
      done: tmod >= TOTAL_MS - 50,
      total_ms: TOTAL_MS,
      dwell_pct: 1,
    };
  };
}

/**
 * arena: circle matching MOT arena radius
 */
function makeArenaPath(W, H) {
  const RADIUS_NORM = 0.42;
  const PERIOD_MS   = 5000;
  const LOOPS       = 4;
  const TOTAL_MS    = PERIOD_MS * LOOPS;

  return function(t_ms) {
    const tmod  = Math.min(t_ms, TOTAL_MS - 1);
    const theta = (tmod / PERIOD_MS) * 2 * Math.PI - Math.PI / 2;
    return {
      x_norm: 0.5 + RADIUS_NORM * Math.cos(theta),
      y_norm: 0.5 + RADIUS_NORM * Math.sin(theta),
      phase: `loop-${Math.floor(tmod / PERIOD_MS) + 1}`,
      done: tmod >= TOTAL_MS - 50,
      total_ms: TOTAL_MS,
      dwell_pct: 1,
    };
  };
}

function getPathFn(mode, W, H) {
  switch (mode) {
    case 'numpad9': return makeNumpad9Path(W, H);
    case 'fig8':    return makeFig8Path(W, H);
    case 'box':     return makeBoxPath(W, H);
    case 'arena':   return makeArenaPath(W, H);
    default:        return makeNumpad9Path(W, H);
  }
}

// ── Screens ────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function goHome() {
  stopRecordingSync();
  cancelAnimationFrame(state.animId);
  clearInterval(state.timerInterval);
  showScreen('home');
}

// ── Camera ─────────────────────────────────────────────────────────────────
async function requestCamera() {
  const btn = document.getElementById('permBtn');
  const err = document.getElementById('permError');
  btn.textContent = 'Requesting…';
  err.classList.remove('show');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width:  { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    state.cameraStream = stream;
    document.getElementById('previewVideo').srcObject = stream;
    startTrial();
  } catch (e) {
    err.classList.add('show');
    btn.textContent = 'Allow Camera';
  }
}

// ── Trial flow ─────────────────────────────────────────────────────────────
function startFlow(mode) {
  state.mode = mode;
  if (state.cameraStream) {
    startTrial();
  } else {
    showScreen('permission');
  }
}

function startTrial() {
  showScreen('trial');
  state.ballLog     = [];
  state.videoChunks = [];
  state.videoBlob   = null;

  const canvas = document.getElementById('trialCanvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  runCountdown(3, () => {
    startRecording();
    runAnimation();
  });
}

function runCountdown(n, cb) {
  const el  = document.getElementById('countdown');
  const num = document.getElementById('countdownNum');
  el.classList.remove('hidden');

  function tick(i) {
    if (i === 0) { el.classList.add('hidden'); cb(); return; }
    num.textContent = i;
    num.style.animation = 'none';
    num.offsetHeight;  // reflow to restart CSS animation
    num.style.animation = '';
    setTimeout(() => tick(i - 1), 1000);
  }
  tick(n);
}

// ── Recording ──────────────────────────────────────────────────────────────
function startRecording() {
  if (!state.cameraStream) return;

  const mimeTypes = [
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const mime = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || '';

  try {
    state.mediaRecorder = new MediaRecorder(
      state.cameraStream,
      mime ? { mimeType: mime } : {}
    );
    state.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) state.videoChunks.push(e.data);
    };
    state.mediaRecorder.start(100);
  } catch(e) {
    console.warn('MediaRecorder failed:', e);
  }
}

function stopRecordingSync() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }
}

function stopRecording() {
  return new Promise(resolve => {
    if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
      resolve(); return;
    }
    state.mediaRecorder.onstop = () => {
      if (state.videoChunks.length > 0) {
        const mime = state.mediaRecorder.mimeType || 'video/webm';
        state.videoBlob = new Blob(state.videoChunks, { type: mime });
      }
      resolve();
    };
    state.mediaRecorder.stop();
  });
}

// ── Animation loop ─────────────────────────────────────────────────────────
function runAnimation() {
  const canvas = document.getElementById('trialCanvas');
  const ctx    = canvas.getContext('2d');
  const W      = canvas.width;
  const H      = canvas.height;
  const pathFn = getPathFn(state.mode, W, H);
  const BALL_R = Math.min(W, H) * 0.020;

  // 9-point guide positions (same padding as makeNumpad9Path)
  const PAD = 0.10;
  const GUIDE_PTS = [
    { x: PAD,       y: PAD     }, { x: 0.5,     y: PAD     }, { x: 1-PAD, y: PAD     },
    { x: PAD,       y: 0.5     }, { x: 0.5,     y: 0.5     }, { x: 1-PAD, y: 0.5     },
    { x: PAD,       y: 1-PAD   }, { x: 0.5,     y: 1-PAD   }, { x: 1-PAD, y: 1-PAD   },
  ];

  state.t0 = performance.now();

  function frame() {
    const t_ms = performance.now() - state.t0;
    const pos  = pathFn(t_ms);

    const x_px = pos.x_norm * W;
    const y_px = pos.y_norm * H;

    // ── Log ──────────────────────────────────────────────────────────────
    state.ballLog.push({
      t_ms:   Math.round(t_ms),
      x_px:   Math.round(x_px * 10) / 10,
      y_px:   Math.round(y_px * 10) / 10,
      x_norm: Math.round(pos.x_norm * 10000) / 10000,
      y_norm: Math.round(pos.y_norm * 10000) / 10000,
      phase:  pos.phase,
    });

    // ── Draw ──────────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, W, H);

    // White background — provides soft fill light for face
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Guide crosshairs (numpad9 only) — very faint, never confused with target
    if (state.mode === 'numpad9') {
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      const sz = BALL_R * 0.8;
      GUIDE_PTS.forEach(p => {
        const gx = p.x * W, gy = p.y * H;
        ctx.beginPath();
        ctx.moveTo(gx - sz, gy); ctx.lineTo(gx + sz, gy);
        ctx.moveTo(gx, gy - sz); ctx.lineTo(gx, gy + sz);
        ctx.stroke();
      });
    }

    // Arena guide circle
    if (state.mode === 'arena') {
      const r = Math.min(W, H) * 0.42;
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 8]);
      ctx.beginPath();
      ctx.arc(W/2, H/2, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Dwell ring — shrinks as dwell_pct → 1, disappears when done dwelling
    if (pos.dwell_pct < 0.98) {
      const ringR = BALL_R * (2.6 - 1.6 * pos.dwell_pct);
      ctx.strokeStyle = `rgba(0,0,0,${0.15 * (1 - pos.dwell_pct)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x_px, y_px, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Black ball — maximum contrast on white
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(x_px, y_px, BALL_R, 0, Math.PI * 2);
    ctx.fill();

    // Progress bar — 2px at very bottom, barely visible
    const pct = Math.min(t_ms / pos.total_ms, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(0, H - 2, W, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, H - 2, W * pct, 2);

    if (pos.done) {
      stopTrial();
      return;
    }

    state.animId = requestAnimationFrame(frame);
  }

  state.animId = requestAnimationFrame(frame);
}

// ── Stop trial ─────────────────────────────────────────────────────────────
async function stopTrial() {
  cancelAnimationFrame(state.animId);
  clearInterval(state.timerInterval);

  await stopRecording();

  const dur_s = state.ballLog.length > 0
    ? (state.ballLog[state.ballLog.length - 1].t_ms / 1000).toFixed(1)
    : '0';

  const modeLabels = {
    numpad9: '9-Point Cal.',
    fig8:    'Figure-8',
    box:     'Box Path',
    arena:   'Arena Circle',
  };

  document.getElementById('resType').textContent    = modeLabels[state.mode] || state.mode;
  document.getElementById('resDur').textContent     = dur_s + 's';
  document.getElementById('resSamples').textContent = state.ballLog.length.toLocaleString();

  if (state.videoBlob) {
    const mb = (state.videoBlob.size / 1048576).toFixed(1);
    document.getElementById('resVideo').textContent        = mb + ' MB';
    document.getElementById('resVideo').className          = 'value green';
    document.getElementById('exportVideoSize').textContent = mb + ' MB · tap to save';
  } else {
    document.getElementById('resVideo').textContent        = 'Not available';
    document.getElementById('resVideo').className          = 'value amber';
    document.getElementById('exportVideoSize').textContent = 'Recording unavailable';
  }

  document.getElementById('exportCSVRows').textContent = state.ballLog.length + ' rows';
  document.getElementById('resultsTitle').textContent  = '✓ Trial saved';

  showScreen('results');
}

// ── Exports ────────────────────────────────────────────────────────────────
function exportVideo() {
  if (!state.videoBlob) { alert('No video recorded.'); return; }
  const ext = state.videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
  downloadBlob(state.videoBlob, `eyetrack_${state.mode}_${Date.now()}.${ext}`);
}

function exportCSV() {
  const header = 't_ms,x_px,y_px,x_norm,y_norm,phase';
  const rows   = state.ballLog.map(r =>
    `${r.t_ms},${r.x_px},${r.y_px},${r.x_norm},${r.y_norm},${r.phase}`
  );
  const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' });
  downloadBlob(blob, `eyetrack_${state.mode}_${Date.now()}.csv`);
}

function exportJSON() {
  const session = {
    version:         2,
    mode:            state.mode,
    timestamp_iso:   new Date().toISOString(),
    screen_w_px:     window.innerWidth,
    screen_h_px:     window.innerHeight,
    device_px_ratio: window.devicePixelRatio || 1,
    ball_log:        state.ballLog,
  };
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `eyetrack_${state.mode}_${Date.now()}.json`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
