// src/config/captureConfig.js
const CONFIG = {
  ID: {
    OVERLAY: { MODE: 'fixed', WIDTH_VW: 70, HEIGHT_VH: 40, ID_RATIO: 1.58 },
    BRIGHTNESS: { MIN: 90, MAX: 210 },
    FACE: { MIN_BOX_H_FRAC: 0.18, MAX_BOX_H_FRAC: 0.50 },
    POSE: { ROLL_MAX_DEG: 10, YAW_MAX: 0.20, PITCH_MAX: 0.18 },
    ANALYSIS: { INTERVAL_MS: 200, DOWNSCALE_LONG_EDGE: 720, OVERLAY_W_FRAC: 0.70, OVERLAY_H_FRAC: 0.40 },
    CAMERA: { FACING_MODE: 'environment', WIDTH: 1080, HEIGHT: 1920, ASPECT: 9 / 16 },
  },

  /* ====== NEW: Face (live guidance) ====== */
  FACE_VIDEO: {
    CIRCLE: {
      WIDTH_FRAC: 0.90,      // 90% of viewport width
      HEIGHT_FRAC: 0.80,     // 40% of viewport height
      CENTER_TOL_FRAC: 0.12, // tolerance as fraction of circle radius for "centered"
    },
    POSE: {                  // You can tune these independently from ID flow
      ROLL_MAX_DEG: 12,
      YAW_MAX: 0.25,
      PITCH_MAX: 0.22,
    },
    ANALYSIS: {
      INTERVAL_MS: 150,         // a bit snappier for UX
      DOWNSCALE_LONG_EDGE: 720, // analyser resolution
    },
    CAMERA: {
      FACING_MODE: 'user',   // front camera for face
      WIDTH: 1280,
      HEIGHT: 720,
      ASPECT: 3 / 4,
    },
  },
};

export default CONFIG;