# Eye Track Calibration PWA

Gaze calibration and lag testing tool for MOT research.
Records front-camera video synced to known ball positions for offline MediaPipe iris extraction.

## Deploy to GitHub Pages

1. Create a new repo named `eyetrack-pwa` on GitHub
2. Push these files to the `main` branch root:
   ```
   index.html
   app.js
   sw.js
   manifest.json
   icon.png
   ```
3. Go to repo Settings → Pages → Source: `main` branch, `/ (root)`
4. Your PWA will be live at `https://yourusername.github.io/eyetrack-pwa/`

**No GitHub Actions needed.** GitHub Pages deploys static files directly.

## Update / Cache Busting

The service worker uses network-first and nukes all caches on activate.
The `app.js` script tag includes `?v=TIMESTAMP` to force reload.

To push an update:
- Edit files, commit, push
- On next visit the SW activates, clears cache, serves fresh files

## Trial Types

| Mode | Purpose | Duration |
|------|---------|----------|
| Corner Calibration | 5-point affine transform fit | ~20s |
| Figure-8 Lag Test | Smooth pursuit, continuous lag measurement | ~30s |
| Box Path | Sharp corners, saccade latency | ~20s |
| Arena Circle | MOT boundary eccentricity | ~25s |

## Exports (per trial)

- **Video** — front camera `.mp4` or `.webm`
- **CSV** — `t_ms, x_px, y_px, x_norm, y_norm, phase` at ~60Hz
- **JSON** — full session metadata + ball log

## Colab Analysis

Upload `eyetrack_analysis.ipynb` to Google Colab.
Run cells top to bottom with your video + CSV files.

Outputs:
- Spatial overlay plot (gaze vs ball path)
- X time series comparison
- Error over time
- Cross-correlation lag estimate
- `eyetrack_aligned.csv` — gaze + ball positions aligned by timestamp

## Hardware Requirements

- iPhone with Face ID (any model) or Android with front camera
- Good frontal lighting — avoid backlit windows
- ~30cm viewing distance
- Safari iOS or Chrome Android

## Screen Dimensions

Edit `SCREEN_W_MM` and `SCREEN_H_MM` in the Colab notebook cell 4.

Common values:
- iPhone 14: 71.5 × 154.9 mm
- iPhone 14 Pro: 71.5 × 154.9 mm  
- iPhone 13: 71.5 × 146.7 mm
- Samsung S23: 70.6 × 146.3 mm
