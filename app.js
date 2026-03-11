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
  mode:          null,      // 'corners' | 'fig8' | 'box' | 'arena' | 'numpad9'
  cameraStream:  null,
  mediaRecorder: null,
  videoChunks:   [],
  videoBlob:     null,
  ballLog:       [],        // [{t_ms, x_px, y_px, x_norm, y_norm, phase}]
  t0:            null,      // performance.now() at trial start
  animId:        null,
  phase:         null,
  timerInterval: null,
};

// ── Utility ────────────────────────────────────────────────────────────────
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

/** Fisher-Yates shuffle (in-place, returns array) */
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
 * Randomises visit order on each call.
 * Dwell ≥ 2 s per point; smooth lerp between.
 */
function makeNumpad9Path(W, H) {
  const PAD      = 0.10;   // normalised inset from screen edge
  const DWELL_MS = 2500;   // ≥ 2 s per point
  const MOVE_MS  = 500;    // transition
  const HOLD_MS  = DWELL_MS + MOVE_MS;

  // Define all 9 points in numpad layout (7=TL, 8=TC, 9=TR … 1=BL, 2=BC, 3=BR)
  const allPoints = [
    { x: PAD,       y: PAD,       label: 'NW' },   // 7
    { x: 0.5,       y: PAD,       label: 'N'  },   // 8
    { x: 1 - PAD,   y: PAD,       label: 'NE' },   // 9
    { x: PAD,       y: 0.5,       label: 'W'  },   // 4
    { x: 0.5,       y: 0.5,       label: 'C'  },   // 5
    { x: 1 - PAD,   y: 0.5,       label: 'E'  },   // 6
    { x: PAD,       y: 1 - PAD,   label: 'SW' },   // 1
    { x: 0.5,       y: 1 - PAD,   label: 'S'  },   // 2
    { x: 1 - PAD,   y: 1 - PAD,   label: 'SE' },   // 3
  ];

  // Randomise order; append first point again to complete the last lerp cleanly
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
 * corners: dwell at 5 positions (TL, TR, BR, BL, C)
 */
function makeCornersPath(W, H) {
  const PAD      = 0.08;
  const DWELL_MS = 2500;
  const MOVE_MS  = 600;
  const HOLD_MS  = DWELL_MS + MOVE_MS;

  const points = [
    { x: PAD,       y: PAD,       label: 'top-left'     },
    { x: 1 - PAD,   y: PAD,       label: 'top-right'    },
    { x: 1 - PAD,   y: 1 - PAD,   label: 'bottom-right' },
    { x: PAD,       y: 1 - PAD,   label: 'bottom-left'  },
    { x: 0.5,       y: 0.5,       label: 'centre'       },
  ];

  const total = points.length * HOLD_MS;

  return function(t_ms) {
    const tmod = Math.min(t_ms, total - 1);
    const seg  = Math.floor(tmod / HOLD_MS);
    const into = tmod % HOLD_MS;
    const cur  = points[seg];
    const nxt  = points[(seg + 1) % points.length];

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
      done: tmod >= total - 50,
      total_ms: total,
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
    case 'numpad9':  return makeNumpad9Path(W, H);
    case 'corners':  return makeCornersPath(W, H);
    case 'fig8':     return makeFig8Path(W, H);
    case 'box':      return makeBoxPath(W, H);
    case 'arena':    return makeArenaPath(W, H);
  }
}

// ── Screens ────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function goHome() {
  stopRecording();
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
  state.ballLog    = [];
  state.videoChunks = [];
  state.videoBlob  = null;

  const canvas = document.getElementById('trialCanvas');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const modeLabels = {
    numpad9: '9-Point Calibration',
    corners: 'Corner Calibration',
    fig8:    'Figure-8 Lag Test',
    box:     'Box Path',
    arena:   'Arena Circle',
  };
  document.getElementById('trialPhase').textContent = modeLabels[state.mode] || state.mode;

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
    if (i === 0) {
      el.classList.add('hidden');
      cb();
      return;
    }
    num.textContent = i;
    num.style.animation = 'none';
    num.offsetHeight;
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

    const dot   = document.getElementById('recDot');
    const label = document.getElementById('recLabel');
    dot.classList.add('recording');
    label.textContent = 'recording';
  } catch(e) {
    console.warn('MediaRecorder failed:', e);
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
    document.getElementById('recDot').classList.remove('recording');
    document.getElementById('recDot').classList.add('ready');
    document.getElementById('recLabel').textContent = 'saved';
  });
}

// ── Animation loop ─────────────────────────────────────────────────────────
function runAnimation() {
  const canvas = document.getElementById('trialCanvas');
  const ctx    = canvas.getContext('2d');
  const W      = canvas.width;
  const H      = canvas.height;
  const pathFn = getPathFn(state.mode, W, H);

  // Ball radius: ~2% of shorter dimension
  const BALL_R = Math.min(W, H) * 0.020;

  state.t0 = performance.now();

  // HUD elements – these live outside the canvas so they never occlude the ball
  const timerEl = document.getElementById('recTimer');
  const ctrEl   = document.getElementById('trialCounter');

  function frame() {
    const now  = performance.now();
    const t_ms = now - state.t0;
    const pos  = pathFn(t_ms);

    const x_px = pos.x_norm * W;
    const y_px = pos.y_norm * H;

    // Log
    state.ballLog.push({
      t_ms:   Math.round(t_ms),
      x_px:   Math.round(x_px * 10) / 10,
      y_px:   Math.round(y_px * 10) / 10,
      x_norm: Math.round(pos.x_norm * 10000) / 10000,
      y_norm: Math.round(pos.y_norm * 10000) / 10000,
      phase:  pos.phase,
    });

    // ── Draw ───────────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, W, H);

    // White background for soft face illumination
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // ── 9-point guide dots (numpad9 mode only) ─────────────────────────────
    if (state.mode === 'numpad9') {
      const PAD = 0.10;
      const guidePositions = [
        { x: PAD,       y: PAD       },
        { x: 0.5,       y: PAD       },
        { x: 1 - PAD,   y: PAD       },
        { x: PAD,       y: 0.5       },
        { x: 0.5,       y: 0.5       },
        { x: 1 - PAD,   y: 0.5       },
        { x: PAD,       y: 1 - PAD   },
        { x: 0.5,       y: 1 - PAD   },
        { x: 1 - PAD,   y: 1 - PAD   },
      ];
      guidePositions.forEach(p => {
        const gx = p.x * W;
        const gy = p.y * H;
        ctx.strokeStyle = 'rgba(0,0,0,0.10)';
        ctx.lineWidth   = 1;
        const sz = BALL_R * 0.7;
        ctx.beginPath();
        ctx.moveTo(gx - sz, gy); ctx.lineTo(gx + sz, gy);
        ctx.moveTo(gx, gy - sz); ctx.lineTo(gx, gy + sz);
        ctx.stroke();
      });
    }

    // ── Dwell ring (shrinks to zero over the dwell period) ─────────────────
    if (pos.dwell_pct !== undefined && pos.dwell_pct < 1) {
      const ringR = BALL_R * (2.8 - 1.8 * pos.dwell_pct);
      ctx.strokeStyle = `rgba(0,0,0,${0.18 * (1 - pos.dwell_pct)})`;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.arc(x_px, y_px, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ── Ball: solid black circle ───────────────────────────────────────────
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(x_px, y_px, BALL_R, 0, Math.PI * 2);
    ctx.fill();

    // ── Progress bar – very bottom of screen, 2 px tall ───────────────────
    const pct = Math.min(t_ms / pos.total_ms, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, H - 2, W, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, H - 2, W * pct, 2);

    // ── Point counter for numpad9 (tiny, bottom-left corner) ──────────────
    if (state.mode === 'numpad9' && pos.point_total !== undefined) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.font      = `${Math.round(BALL_R * 0.85)}px monospace`;
      ctx.textAlign = 'left';
      ctx.fillText(
        `${pos.point_index + 1} / ${pos.point_total}  ${pos.phase}`,
        12, H - 10
      );
    }

    // ── HUD timer (DOM, outside canvas – no occlusion risk) ───────────────
    timerEl.textContent = (t_ms / 1000).toFixed(1) + 's';
    ctrEl.textContent   = state.ballLog.length + ' pts';

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

  document.getElementById('trialPhase').textContent = 'Saving…';

  await stopRecording();

  const dur_s = state.ballLog.length > 0
    ? (state.ballLog[state.ballLog.length - 1].t_ms / 1000).toFixed(1)
    : '0';

  const modeLabels = {
    numpad9: '9-Point Cal.',
    corners: 'Corner Cal.',
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

  document.getElementById('exportCSVRows').textContent =
    state.ballLog.length + ' rows';

  document.getElementById('resultsTitle').textContent = '✓ Trial saved';

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
    version:          2,
    mode:             state.mode,
    timestamp_iso:    new Date().toISOString(),
    screen_w_px:      window.innerWidth,
    screen_h_px:      window.innerHeight,
    device_px_ratio:  window.devicePixelRatio || 1,
    ball_log:         state.ballLog,
  };
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `eyetrack_${state.mode}_${Date.now()}.json`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
