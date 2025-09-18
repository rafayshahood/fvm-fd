// LiveIDVerification.jsx
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, WS_BASE } from "./api";
import { ensureReqId, getReqId } from "./storage";

function LiveIDVerification() {
  const navigate = useNavigate();

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const wsRef = useRef(null);
  const startedRef = useRef(false);

  const [status, setStatus] = useState("Idle");
  const [result, setResult] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);

  // ---------- NEW: Grace period / frames-before-judgment ----------
  const JUDGE_GRACE_MS = 1200;    // time after WS open before we judge
  const JUDGE_MIN_FRAMES = 5;     // frames before we judge
  const cameraStartAtRef = useRef(0);
  const framesSeenRef = useRef(0);

  // ---------- STABILITY / HYSTERESIS ----------
  const BRIGHT_STREAK = 12;
  const FRAME_COOLDOWN_MS = 1200;
  const FRAME_OK_MIN = 60,  FRAME_OK_MAX = 190;
  const FRAME_FAIL_MIN = 50, FRAME_FAIL_MAX = 200;

  const FACE_BRIGHT_STREAK = 12;
  const FACE_COOLDOWN_MS = 1500;
  const FACE_OK_MIN = 75,  FACE_OK_MAX = 180;
  const FACE_FAIL_MIN = 65, FACE_FAIL_MAX = 190;

  const FACE_STREAK   = 4;
  const IDCARD_STREAK = 6;
  const INSIDE_STREAK = 8;
  const GLARE_STREAK  = 10;

  const frameSmoothRef = useRef(null);
  const faceSmoothRef  = useRef(null);
  const lastFrameBrightFailAtRef = useRef(0);
  const lastFaceBrightFailAtRef  = useRef(0);
  const streaksRef = useRef({ fb:0, idc:0, i:0, g:0, fr_b:0, face_b:0 });

  // ---------- VIEWPORT / OVERLAY ----------
  const [vp, setVp] = useState({
    w: typeof window !== "undefined" ? window.innerWidth : 0,
    h: typeof window !== "undefined"
      ? (window.visualViewport?.height ?? window.innerHeight)
      : 0,
  });
  useEffect(() => {
    const onResize = () => setVp({
      w: window.innerWidth,
      h: window.visualViewport?.height ?? window.innerHeight,
    });
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, []);

  // Layout helpers — use CONTAIN so nothing is cropped visually
  function containLayout(containerW, containerH, vidW, vidH) {
    if (!vidW || !vidH) return { scale: 1, dx: 0, dy: 0, dispW: 0, dispH: 0 };
    const scale = Math.min(containerW / vidW, containerH / vidH);
    const dispW = vidW * scale;
    const dispH = vidH * scale;
    return { scale, dx: (containerW - dispW) / 2, dy: (containerH - dispH) / 2, dispW, dispH };
  }

  // The ID rectangle is sized/centered within the DISPLAYED video area
  function currentDisplayRect() {
    const v = videoRef.current;
    if (!v) return null;
    const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
    if (!vw || !vh) return null;
    const { scale, dx, dy, dispW, dispH } = containLayout(vp.w, vp.h, vw, vh);
    const rectW = dispW, rectH = dispH * 0.55;
    const rectX = dx + (dispW - rectW) / 2;
    const rectY = dy + (dispH - rectH) / 2;
    return { rectX, rectY, rectW, rectH, scale, dx, dy, vw, vh };
  }

  function mapBoxToScreen(b) {
    const v = videoRef.current;
    if (!v || !b || !Array.isArray(b) || b.length !== 4) return null;
    const { vw, vh, scale, dx, dy } = currentDisplayRect() || {};
    if (!vw || !vh) return null;
    const [x1, y1, x2, y2] = b.map(Number);
    return { x: dx + x1 * scale, y: dy + y1 * scale, w: (x2 - x1) * scale, h: (y2 - y1) * scale };
  }

  function mapScreenRectToVideoRect(sx, sy, sw, sh) {
    const v = videoRef.current;
    if (!v) return null;
    const { vw, vh, scale, dx, dy } = currentDisplayRect() || {};
    if (!vw || !vh) return null;
    const x1 = Math.max(0, Math.min(vw, (sx - dx) / scale));
    const y1 = Math.max(0, Math.min(vh, (sy - dy) / scale));
    const x2 = Math.max(0, Math.min(vw, (sx + sw - dx) / scale));
    const y2 = Math.max(0, Math.min(vh, (sy + sh - dy) / scale));
    const w = Math.max(1, Math.round(x2 - x1));
    const h = Math.max(1, Math.round(y2 - y1));
    return { x: Math.round(x1), y: Math.round(y1), w, h };
  }

  async function startCamera() {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("Requesting camera…");

    try {
      const reqId = await ensureReqId(API_BASE);

      // ⬇️ Minimal constraints: take exactly what the browser/hardware gives
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });

      streamRef.current = stream;
      const v = videoRef.current; if (!v) return;
      v.srcObject = stream; v.muted = true; v.playsInline = true;
      v.addEventListener("loadedmetadata", function onLoaded() {
        v.removeEventListener("loadedmetadata", onLoaded);
        setStatus(`Video ${v.videoWidth}×${v.videoHeight}`);
        v.play().catch(() => {}); setCameraOn(true);
      });

      const ws = new WebSocket(`${WS_BASE}/ws-id-live?req_id=${encodeURIComponent(reqId)}`);
      ws.onopen = () => {
        setStatus("WS connected, streaming frames…");
        cameraStartAtRef.current = Date.now();
        framesSeenRef.current = 0;
      };
      ws.onclose = () => setStatus("WS closed");
      ws.onerror = () => setStatus("WS error");
      ws.onmessage = (evt) => {
        try {
          setResult(JSON.parse(evt.data));
          framesSeenRef.current += 1;
        } catch {}
      };
      wsRef.current = ws;
      startSendingFrames();
    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Camera unavailable. Check permissions.");
      startedRef.current = false; setCameraOn(false);
    }
  }

  function startSendingFrames() {
    let stop = false;
    const loop = () => {
      if (stop) return;
      const v = videoRef.current, ws = wsRef.current;
      if (!v || !ws || ws.readyState !== WebSocket.OPEN) { requestAnimationFrame(loop); return; }
      if (v.videoWidth && v.videoHeight) {
        // Send the RAW sensor frame (no forced resizing)
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const b64 = canvas.toDataURL("image/jpeg", 0.75).split(",")[1];
        if (b64) { try { ws.send(b64); } catch {} }
      }
      setTimeout(() => requestAnimationFrame(loop), 100);
    };
    requestAnimationFrame(loop);
    return () => { stop = true; };
  }

  async function handleCapture() {
    if (isUploading || !videoRef.current) return;
    try {
      setIsUploading(true);
      const reqId = getReqId();
      if (!reqId) throw new Error("No request id. Refresh the page.");
      const v = videoRef.current;

      const disp = currentDisplayRect();
      if (!disp) throw new Error("Camera not ready");
      const { rectX, rectY, rectW, rectH } = disp;

      const roi = mapScreenRectToVideoRect(rectX, rectY, rectW, rectH);
      if (!roi) throw new Error("Camera not ready");
      const { x, y, w, h } = roi;

      // Keep your existing proximity rule (55% of camera width)
      const MIN_RATIO = 0.55;
      const vw = v.videoWidth || 0;
      const minW = Math.round(vw * MIN_RATIO);
      if (w < minW) {
        alert("Please move closer so the ID fills the rectangle.");
        setIsUploading(false);
        return;
      }

      // Create full-frame canvas (raw) then crop ROI
      const full = document.createElement("canvas");
      full.width = v.videoWidth; full.height = v.videoHeight;
      full.getContext("2d").drawImage(v, 0, 0, full.width, full.height);

      const crop = document.createElement("canvas");
      crop.width = w; crop.height = h;
      const cctx = crop.getContext("2d");
      cctx.drawImage(full, x, y, w, h, 0, 0, w, h);

      const blob = await new Promise((res) => crop.toBlob(res, "image/jpeg", 0.95));

      const form = new FormData();
      form.append("image", blob, "id_roi.jpg");

      const resp = await fetch(`${API_BASE}/upload-id-still?req_id=${encodeURIComponent(reqId)}`, {
        method: "POST", body: form
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Upload failed");

      if (wsRef.current?.readyState === WebSocket.OPEN) { try { wsRef.current.close(); } catch {} }
      wsRef.current = null;
      if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
      if (videoRef.current) { try { videoRef.current.pause(); } catch {}; videoRef.current.srcObject = null; }
      navigate("/", { replace: true });
    } catch (e) {
      console.error(e);
      alert(e.message || "Capture failed");
    } finally {
      setIsUploading(false);
    }
  }

  useEffect(() => {
    return () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close();
      wsRef.current = null;
      if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
      if (videoRef.current) { try { videoRef.current.pause(); } catch {}; videoRef.current.srcObject = null; }
      startedRef.current = false;
    };
  }, []);

  // ---------- STABILIZATION PIPELINE (unchanged) ----------
  useEffect(() => {
    if (!result) return;

    const readyToJudge =
      cameraOn &&
      framesSeenRef.current >= JUDGE_MIN_FRAMES &&
      Date.now() - cameraStartAtRef.current >= JUDGE_GRACE_MS;

    if (!readyToJudge) return;

    const frameMean = typeof result.brightness_mean === "number" ? result.brightness_mean : null;
    let frameOk = false;
    if (frameMean != null) {
      if (frameSmoothRef.current == null) frameSmoothRef.current = frameMean;
      else frameSmoothRef.current = 0.25 * frameMean + 0.75 * frameSmoothRef.current;
      const m = frameSmoothRef.current;
      const prevOk = streaksRef.current.fr_b > 0;
      frameOk = prevOk ? (m >= FRAME_FAIL_MIN && m <= FRAME_FAIL_MAX)
                       : (m >= FRAME_OK_MIN  && m <= FRAME_OK_MAX);
      if (!frameOk) lastFrameBrightFailAtRef.current = Date.now();
    } else {
      frameOk = result.brightness_status === "ok";
      if (!frameOk) lastFrameBrightFailAtRef.current = Date.now();
    }

    const faceMean = typeof result.face_brightness_mean === "number" ? result.face_brightness_mean : null;
    let faceBrightOk = false;
    if (faceMean != null) {
      if (faceSmoothRef.current == null) faceSmoothRef.current = faceMean;
      else faceSmoothRef.current = 0.25 * faceMean + 0.75 * faceSmoothRef.current;
      const fm = faceSmoothRef.current;
      const prevFaceOk = streaksRef.current.face_b > 0;
      faceBrightOk = prevFaceOk ? (fm >= FACE_FAIL_MIN && fm <= FACE_FAIL_MAX)
                                : (fm >= FACE_OK_MIN  && fm <= FACE_OK_MAX);
      if (!faceBrightOk) lastFaceBrightFailAtRef.current = Date.now();
    }

    const faceOk   = !!result.face_detected;
    const idOk     = result.id_card_detected === true;
    const insideOk = result.inside_rect === true || result.id_inside_rect === true;
    const glareClr = !result.glare_detected;

    streaksRef.current.fr_b   = frameOk      ? streaksRef.current.fr_b + 1   : 0;
    streaksRef.current.fb     = faceOk       ? streaksRef.current.fb   + 1   : 0;
    streaksRef.current.idc    = idOk         ? streaksRef.current.idc  + 1   : 0;
    streaksRef.current.i      = insideOk     ? streaksRef.current.i    + 1   : 0;
    streaksRef.current.face_b = faceBrightOk ? streaksRef.current.face_b + 1 : 0;
    streaksRef.current.g      = glareClr     ? streaksRef.current.g    + 1   : 0;
  }, [result, cameraOn]);

  const now = Date.now();
  const frameCooldownActive = now - lastFrameBrightFailAtRef.current < FRAME_COOLDOWN_MS;
  const faceCooldownActive  = now - lastFaceBrightFailAtRef.current  < FACE_COOLDOWN_MS;

  const readyToJudge =
    cameraOn &&
    framesSeenRef.current >= JUDGE_MIN_FRAMES &&
    now - cameraStartAtRef.current >= JUDGE_GRACE_MS;

  const frameBrightStable = streaksRef.current.fr_b   >= BRIGHT_STREAK && !frameCooldownActive;
  const facePresentStable = streaksRef.current.fb     >= FACE_STREAK;
  const idCardStable      = streaksRef.current.idc    >= IDCARD_STREAK;
  const insideStable      = streaksRef.current.i      >= INSIDE_STREAK;
  const faceBrightStable  = streaksRef.current.face_b >= FACE_BRIGHT_STREAK && !faceCooldownActive;
  const glareStable       = streaksRef.current.g      >= GLARE_STREAK;

  const canCapture = frameBrightStable && facePresentStable && idCardStable &&
                     insideStable && faceBrightStable && glareStable;

  const guidance = (() => {
    if (!cameraOn) return "Tap “Start Camera” to begin.";
    if (!result) return "Initializing camera…";
    if (!readyToJudge) return "Checking lighting…";

    if (!frameBrightStable) {
      const lbl = result?.brightness_status;
      if (lbl === "too_dark")   return "💡 Image too dark — adjust lighting.";
      if (lbl === "too_bright") return "☀️ Image too bright — reduce brightness.";
      if (frameCooldownActive)  return "⏳ Stabilizing lighting… hold steady.";
      return "💡 Adjust overall lighting.";
    }
    if (!facePresentStable) return "❌ No face detected on ID.";
    if (!idCardStable)      return "📇 Place the ID card in view.";
    if (!insideStable)      return "📐 Align the ID face fully inside the rectangle.";
    if (!faceBrightStable) {
      const fl = result?.face_brightness_status;
      if (fl === "too_dark")   return "💡 Face too dark — add light.";
      if (fl === "too_bright") return "☀️ Face too bright — reduce glare/brightness.";
      if (faceCooldownActive)  return "⏳ Stabilizing face exposure… hold steady.";
      return "💡 Adjust light on the face.";
    }
    if (!glareStable)       return "✨ Reduce glare on the ID (tilt slightly).";
    return "✅ You can capture now.";
  })();

  // Boxes mapped to the displayed video area
  const rawBox     = mapBoxToScreen(result?.largest_bbox);
  const idCardBox  = mapBoxToScreen(result?.id_card_bbox);

  // Display rect (hole) only when video is ready to avoid odd masking
  const disp = currentDisplayRect();
  const showMask = cameraOn && disp;

  return (
    <div className="position-relative"
         style={{ width:"100vw", height:"100dvh", overflow:"hidden", background:"#000" }}>
      <video ref={videoRef} autoPlay muted playsInline
             style={{
               position:"absolute", inset:0, width:"100%", height:"100%",
               objectFit:"contain"  // show full sensor, no cropping
             }} />

      {showMask && (
        <svg width={vp.w} height={vp.h} viewBox={`0 0 ${vp.w} ${vp.h}`}
             style={{ position:"absolute", inset:0, pointerEvents:"none" }}>
          <defs>
            <mask id="rect-cutout">
              <rect x="0" y="0" width={vp.w} height={vp.h} fill="white" />
              <rect x={disp.rectX} y={disp.rectY} width={disp.rectW} height={disp.rectH}
                    rx="12" ry="12" fill="black" />
            </mask>
          </defs>
          <rect x="0" y="0" width={vp.w} height={vp.h}
                fill="rgba(0,0,0,0.55)" mask="url(#rect-cutout)" />
          <rect x={disp.rectX} y={disp.rectY} width={disp.rectW} height={disp.rectH}
                rx="12" ry="12" fill="none" stroke="white" strokeWidth="3" strokeDasharray="6 6" />
          {rawBox &&  <rect x={rawBox.x} y={rawBox.y} width={rawBox.w} height={rawBox.h}
                            fill="none" stroke="#ffd54f" strokeWidth="3" />}
          {idCardBox && <rect x={idCardBox.x} y={idCardBox.y} width={idCardBox.w} height={idCardBox.h}
                              fill="none" stroke="#34c759" strokeWidth="3" />}
        </svg>
      )}

      <div className="position-absolute w-100 d-flex justify-content-center"
           style={{ top: Math.max(16, (disp ? disp.rectY : 0) - 60), left: 0, padding: "0 16px" }}>
        <div style={{
          maxWidth: 680, width: "100%", textAlign: "center",
          background: "rgba(0,0,0,0.6)", color: "#fff",
          borderRadius: 12, padding: "10px 14px", fontSize: 16, backdropFilter: "blur(4px)",
        }}>
          {guidance}
        </div>
      </div>

      <div className="position-absolute w-100 d-flex flex-column align-items-center" style={{ bottom: 24, left: 0, gap: 8 }}>
        <div className="d-flex gap-2">
          {!cameraOn && (
            <button className="btn btn-primary" onClick={() => { startCamera(); setCameraOn(true); }}>
              Start Camera
            </button>
          )}
          {cameraOn && (
            <button className="btn btn-success"
                    onClick={handleCapture}
                    disabled={!canCapture || isUploading}
                    title={canCapture ? "Capture ID still" : "Meet on-screen conditions to enable capture"}>
              {isUploading ? "Capturing…" : "Capture"}
            </button>
          )}
        </div>
        <div className="text-light text-center"
             style={{ background:"rgba(0,0,0,0.35)", borderRadius:12, padding:"6px 10px", fontSize:12 }}>
          {status}
        </div>
      </div>
    </div>
  );
}

export default LiveIDVerification;