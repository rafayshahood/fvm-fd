// LiveIDVerification.jsx
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, WS_BASE } from "./api";
import { ensureReqId, getReqId } from "./storage";

const RECT_W_RATIO = 0.95;  // 🔺 wider guide
const RECT_H_RATIO = 0.55;  // 🔺 taller guide

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

  // --- viewport
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

  // contain layout (no visual crop)
  function containLayout(containerW, containerH, vidW, vidH) {
    if (!vidW || !vidH) return { scale: 1, dx: 0, dy: 0, dispW: 0, dispH: 0 };
    const scale = Math.min(containerW / vidW, containerH / vidH);
    const dispW = vidW * scale;
    const dispH = vidH * scale;
    return { scale, dx: (containerW - dispW) / 2, dy: (containerH - dispH) / 2, dispW, dispH };
  }

  function currentDisplayRect() {
    const v = videoRef.current;
    if (!v) return null;
    const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
    if (!vw || !vh) return null;
    const { scale, dx, dy, dispW, dispH } = containLayout(vp.w, vp.h, vw, vh);
    const rectW = dispW * RECT_W_RATIO;
    const rectH = dispH * RECT_H_RATIO;
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

      // Ask for the rear camera and let the UA pick best resolution.
      // Don’t hard-fail if a device can’t do 1080p.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
          // advanced can help some Android devices pick higher res:
          advanced: [{ width: 1920, height: 1080 }]
        },
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

  function startSendingFrames() {
    let stop = false;
    const loop = () => {
      if (stop) return;
      const v = videoRef.current, ws = wsRef.current;
      if (!v || !ws || ws.readyState !== WebSocket.OPEN) { requestAnimationFrame(loop); return; }
      if (v.videoWidth && v.videoHeight) {
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const b64 = canvas.toDataURL("image/jpeg", 0.75).split(",")[1];
        if (b64) { try { ws.send(b64); } catch {} }
      }
      setTimeout(() => requestAnimationFrame(loop), 120);
    };
    requestAnimationFrame(loop);
    return () => { stop = true; };
  }

  async function handleCapture() {
    if (isUploading) return;
    const v = videoRef.current;
    const stream = streamRef.current;
    if (!v || !stream) return;

    try {
      setIsUploading(true);
      const reqId = getReqId();
      if (!reqId) throw new Error("No request id. Refresh the page.");

      let blob = null;

      // 1) Try full-resolution still via ImageCapture (best quality on mobile)
      const track = stream.getVideoTracks?.()[0];
      if (track && "ImageCapture" in window) {
        try {
          const ic = new window.ImageCapture(track);
          blob = await ic.takePhoto(); // full-res JPEG from camera
        } catch (e) {
          console.warn("ImageCapture.takePhoto() failed; falling back to canvas ROI.", e);
        }
      }

      // 2) Fallback: crop ROI from the live video frame (keep high quality)
      if (!blob) {
        const disp = currentDisplayRect();
        if (!disp) throw new Error("Camera not ready");
        const { rectX, rectY, rectW, rectH } = disp;
        const roi = mapScreenRectToVideoRect(rectX, rectY, rectW, rectH);
        if (!roi) throw new Error("Camera not ready");
        const { x, y, w, h } = roi;

        // Require the rect to be large enough relative to the sensor
        const vw = v.videoWidth || 0;
        const MIN_RATIO = 0.55; // keep your proximity rule
        const minW = Math.round(vw * MIN_RATIO);
        if (w < minW) {
          alert("Please move closer so the ID fills the rectangle.");
          setIsUploading(false);
          return;
        }

        const full = document.createElement("canvas");
        full.width = v.videoWidth; full.height = v.videoHeight;
        full.getContext("2d").drawImage(v, 0, 0, full.width, full.height);

        const crop = document.createElement("canvas");
        crop.width = w; crop.height = h;
        crop.getContext("2d").drawImage(full, x, y, w, h, 0, 0, w, h);

        blob = await new Promise((res) => crop.toBlob(res, "image/jpeg", 0.98));
      }

      const form = new FormData();
      form.append("image", blob, "id_still.jpg");

      const resp = await fetch(`${API_BASE}/upload-id-still?req_id=${encodeURIComponent(reqId)}`, {
        method: "POST", body: form
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Upload failed");

      // Cleanup and go home
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

  // simple guidance
  const guidance = !cameraOn
    ? "Tap “Start Camera” and align your ID so it fills the white box."
    : result?.id_card_detected === false
      ? "📇 Place the ID fully in view."
      : result?.brightness_status === "too_dark"
        ? "💡 Too dark — add light."
        : result?.brightness_status === "too_bright"
          ? "☀️ Too bright — reduce direct light."
          : "Hold steady, then tap Capture.";

  const idCardBox  = mapBoxToScreen(result?.id_card_bbox);
  const disp = currentDisplayRect();
  const showMask = cameraOn && disp;

  return (
    <div className="position-relative" style={{ width:"100vw", height:"100dvh", overflow:"hidden", background:"#000" }}>
      <video
        ref={videoRef}
        autoPlay muted playsInline
        style={{ position:"absolute", inset:0, width:"100%", height:"100%", objectFit:"contain" }}
      />

      {showMask && (
        <svg width={vp.w} height={vp.h} viewBox={`0 0 ${vp.w} ${vp.h}`} style={{ position:"absolute", inset:0, pointerEvents:"none" }}>
          <defs>
            <mask id="rect-cutout">
              <rect x="0" y="0" width={vp.w} height={vp.h} fill="white" />
              <rect x={disp.rectX} y={disp.rectY} width={disp.rectW} height={disp.rectH} rx="12" ry="12" fill="black" />
            </mask>
          </defs>
          <rect x="0" y="0" width={vp.w} height={vp.h} fill="rgba(0,0,0,0.55)" mask="url(#rect-cutout)" />
          <rect x={disp.rectX} y={disp.rectY} width={disp.rectW} height={disp.rectH}
                rx="12" ry="12" fill="none" stroke="white" strokeWidth="3" strokeDasharray="6 6" />
          {idCardBox && (
            <rect x={idCardBox.x} y={idCardBox.y} width={idCardBox.w} height={idCardBox.h}
                  fill="none" stroke="#34c759" strokeWidth="3" />
          )}
        </svg>
      )}

      <div className="position-absolute w-100 d-flex justify-content-center"
           style={{ top: Math.max(16, (disp ? disp.rectY : 0) - 60), left: 0, padding: "0 16px" }}>
        <div style={{ maxWidth: 680, width: "100%", textAlign: "center", background: "rgba(0,0,0,0.6)", color: "#fff",
                      borderRadius: 12, padding: "10px 14px", fontSize: 16, backdropFilter: "blur(4px)" }}>
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
            <button className="btn btn-success" onClick={handleCapture} disabled={isUploading}>
              {isUploading ? "Capturing…" : "Capture"}
            </button>
          )}
        </div>
        <div className="text-light text-center" style={{ background:"rgba(0,0,0,0.35)", borderRadius:12, padding:"6px 10px", fontSize:12 }}>
          {status}
        </div>
      </div>
    </div>
  );
}

export default LiveIDVerification;