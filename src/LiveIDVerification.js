// LiveIDVerification.jsx — updated to ONLY use new-script conditions
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, WS_BASE } from "./api";
import { ensureReqId, getReqId } from "./storage";

function BlockingOverlay({ text = "Processing… Please wait." }) {
  return (
    <div role="alert" aria-busy="true" style={{
      position:"fixed", inset:0, background:"rgba(0,0,0,0.65)",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
      zIndex:9999, backdropFilter:"blur(2px)", pointerEvents:"all"
    }}>
      <svg width="56" height="56" viewBox="0 0 50 50" aria-hidden="true">
        <circle cx="25" cy="25" r="20" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" opacity="0.25" />
        <path fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" d="M25 5 a20 20 0 0 1 0 40">
          <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite" />
        </path>
      </svg>
      <div style={{ marginTop:14, color:"#fff", fontSize:16, textAlign:"center", padding:"6px 10px" }}>{text}</div>
    </div>
  );
}

export default function LiveIDVerification() {
  const navigate = useNavigate();

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const wsRef = useRef(null);
  const startedRef = useRef(false);

  const [status, setStatus] = useState("Idle");
  const [result, setResult] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);

  // ---- VIEWPORT / OVERLAY ----
  const [vp, setVp] = useState({
    w: typeof window !== "undefined" ? window.innerWidth : 0,
    h: typeof window !== "undefined" ? (window.visualViewport?.height ?? window.innerHeight) : 0,
  });
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.visualViewport?.height ?? window.innerHeight });
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, []);

  function containLayout(containerW, containerH, vidW, vidH) {
    if (!vidW || !vidH) return { scale:1, dx:0, dy:0, dispW:0, dispH:0 };
    const scale = Math.min(containerW / vidW, containerH / vidH);
    const dispW = vidW * scale, dispH = vidH * scale;
    return { scale, dx:(containerW - dispW)/2, dy:(containerH - dispH)/2, dispW, dispH };
  }

  // must match backend RECT_W_RATIO=0.95, RECT_H_RATIO=0.45
  function currentDisplayRect() {
    const v = videoRef.current; if (!v) return null;
    const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
    if (!vw || !vh) return null;
    const { scale, dx, dy, dispW, dispH } = containLayout(vp.w, vp.h, vw, vh);
    const rectW = dispW * 0.95;
    const rectH = dispH * 0.45;
    const rectX = dx + (dispW - rectW) / 2;
    const rectY = dy + (dispH - rectH) / 2;
    return { rectX, rectY, rectW, rectH, scale, dx, dy, vw, vh };
  }

  function mapBoxToScreen(b) {
    const v = videoRef.current; if (!v || !b || b.length !== 4) return null;
    const geo = currentDisplayRect(); if (!geo) return null;
    const { vw, vh, scale, dx, dy } = geo;
    if (!vw || !vh) return null;
    const [x1,y1,x2,y2] = b.map(Number);
    return { x: dx + x1*scale, y: dy + y1*scale, w: (x2-x1)*scale, h:(y2-y1)*scale };
  }

  function mapScreenRectToVideoRect(sx, sy, sw, sh) {
    const v = videoRef.current; if (!v) return null;
    const geo = currentDisplayRect(); if (!geo) return null;
    const { vw, vh, scale, dx, dy } = geo;
    const x1 = Math.max(0, Math.min(vw, (sx - dx) / scale));
    const y1 = Math.max(0, Math.min(vh, (sy - dy) / scale));
    const x2 = Math.max(0, Math.min(vw, (sx + sw - dx) / scale));
    const y2 = Math.max(0, Math.min(vh, (sy + sh - dy) / scale));
    const w = Math.max(1, Math.round(x2 - x1));
    const h = Math.max(1, Math.round(y2 - y1));
    return { x: Math.round(x1), y: Math.round(y1), w, h };
  }

  async function getBestStream() {
    const trials = [
      { video: { facingMode:{ ideal:"environment" }, width:{ ideal:1920 }, height:{ ideal:1080 } }, audio:false },
      { video: { facingMode:{ ideal:"environment" }, width:{ ideal:1280 }, height:{ ideal:720 } },  audio:false },
      { video: { facingMode:{ ideal:"environment" } }, audio:false },
    ];
    let err = null;
    for (const c of trials) { try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { err = e; } }
    throw err || new Error("Camera unavailable");
  }

  async function startCamera() {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("Requesting camera…");
    try {
      const reqId = await ensureReqId(API_BASE);
      const stream = await getBestStream();
      streamRef.current = stream;
      const v = videoRef.current; if (!v) return;
      v.srcObject = stream; v.muted = true; v.setAttribute("playsInline","true");

      try {
        const [track] = stream.getVideoTracks();
        const caps = track.getCapabilities?.() || {};
        const cons = {};
        if (caps.focusMode && caps.focusMode.includes("continuous")) cons.focusMode = "continuous";
        if (caps.exposureMode && caps.exposureMode.includes("continuous")) cons.exposureMode = "continuous";
        if (Object.keys(cons).length) await track.applyConstraints({ advanced: [cons] });
      } catch {}

      v.addEventListener("loadedmetadata", function onLoaded() {
        v.removeEventListener("loadedmetadata", onLoaded);
        setStatus(`Video ${v.videoWidth}×${v.videoHeight}`);
        v.play().catch(() => {}); setCameraOn(true);
      });

      const ws = new WebSocket(`${WS_BASE}/ws-id-live?req_id=${encodeURIComponent(reqId)}`);
      ws.onopen = () => setStatus("WS connected, streaming frames…");
      ws.onclose = () => setStatus("WS closed");
      ws.onerror = () => setStatus("WS error");
      ws.onmessage = (evt) => { try { setResult(JSON.parse(evt.data)); } catch {} };
      wsRef.current = ws;
      startSendingFrames();
    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Camera unavailable. Check permissions.");
      startedRef.current = false; setCameraOn(false);
    }
  }

  // send loop (unchanged)
  function startSendingFrames() {
    let stop = false;
    let sending = false;
    let lastSentAt = 0;
    let frameCounter = 0;
    const TARGET_FPS = 30;
    const MIN_INTERVAL_MS = Math.floor(1000 / TARGET_FPS);
    const MAX_BUFFERED = 256 * 1024;

    const loop = () => {
      if (stop) return;
      const v = videoRef.current, ws = wsRef.current;
      if (!v || !ws || ws.readyState !== WebSocket.OPEN) { requestAnimationFrame(loop); return; }

      const now = performance.now();
      frameCounter += 1;
      const timeOk = now - lastSentAt >= MIN_INTERVAL_MS;
      const ratioOk = (frameCounter % 5 === 0);
      if (!timeOk && !ratioOk) { requestAnimationFrame(loop); return; }

      if (sending) { requestAnimationFrame(loop); return; }
      if (ws.bufferedAmount > MAX_BUFFERED) { requestAnimationFrame(loop); return; }
      if (!(v.videoWidth && v.videoHeight)) { requestAnimationFrame(loop); return; }

      sending = true;
      try {
        const maxW = 960;
        const scale = Math.min(1, maxW / v.videoWidth);
        const W = Math.round(v.videoWidth * scale);
        const H = Math.round(v.videoHeight * scale);

        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d", { alpha:false });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(v, 0, 0, W, H);
        const b64 = canvas.toDataURL("image/jpeg", 0.6).split(",")[1];
        if (b64) { try { ws.send(b64); lastSentAt = now; } catch {} }
      } finally {
        sending = false;
        setTimeout(() => requestAnimationFrame(loop), 16);
      }
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

      // No old “fill/brightness/glare” gates — only capture when new checks are green (see canCapture below)

      const full = document.createElement("canvas");
      full.width = v.videoWidth; full.height = v.videoHeight;
      const fctx = full.getContext("2d", { alpha:false });
      fctx.imageSmoothingEnabled = false;
      fctx.drawImage(v, 0, 0, full.width, full.height);

      const crop = document.createElement("canvas");
      crop.width = w; crop.height = h;
      const cctx = crop.getContext("2d", { alpha:false });
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(full, x, y, w, h, 0, 0, w, h);

      const blob = await new Promise((res) => crop.toBlob(res, "image/jpeg", 0.95));
      const form = new FormData();
      form.append("image", blob, "id_roi.jpg");

      const resp = await fetch(`${API_BASE}/upload-id-still?req_id=${encodeURIComponent(reqId)}`, {
        method:"POST", body: form
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Upload failed");

      // cleanup
      if (wsRef.current?.readyState === WebSocket.OPEN) { try { wsRef.current.close(); } catch {} }
      wsRef.current = null;
      if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
      if (videoRef.current) { try { videoRef.current.pause(); } catch {}; videoRef.current.srcObject = null; }
      navigate("/", { replace:true });
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

  // --- Guidance (only new checks) ---
  const guidance = (() => {
    if (!cameraOn) return "Tap “Start Camera” to begin.";
    if (!result)   return "Connecting…";

    if (!result.id_card_detected)  return "📇 Place the ID card in view.";
    if (!result.id_overlap_ok)     return "📐 Move the ID fully into the rectangle.";
    if (!result.id_size_ok)        return "↔️ Move closer so the ID fills the rectangle.";
    if (!result.face_on_id)        return "👤 Make sure the ID portrait is visible.";
    if (!result.ocr_ok)            return "🔎 Hold steady—text unclear (try tilting to reduce reflections).";

    return "✅ You can capture now.";
  })();

  // Enable capture only when ALL new checks are satisfied
  const canCapture =
    !!result &&
    result.id_card_detected === true &&
    result.id_overlap_ok === true &&
    result.id_size_ok === true &&
    result.face_on_id === true &&
    result.ocr_ok === true;

  const rawBox    = mapBoxToScreen(result?.largest_bbox);
  const idCardBox = mapBoxToScreen(result?.id_card_bbox);
  const disp = currentDisplayRect();
  const showMask = cameraOn && disp;

  return (
    <div className="position-relative" style={{ width:"100vw", height:"100dvh", overflow:"hidden", background:"#000" }}>
      <video ref={videoRef} autoPlay muted playsInline
        style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"contain" }} />

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
          <rect x="0" y="0" width={vp.w} height={vp.h} fill="rgba(0,0,0,0.55)" mask="url(#rect-cutout)" />
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
          maxWidth:680, width:"100%", textAlign:"center",
          background:"rgba(0,0,0,0.6)", color:"#fff",
          borderRadius:12, padding:"10px 14px", fontSize:16, backdropFilter:"blur(4px)"
        }}>
          {guidance}
        </div>
      </div>

      <div className="position-absolute w-100 d-flex flex-column align-items-center" style={{ bottom:24, left:0, gap:8 }}>
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

      {isUploading && <BlockingOverlay text="Processing your ID… Please wait." />}
    </div>
  );
}