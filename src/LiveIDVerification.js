// LiveIDVerification.jsx — viewport-sized streaming & capture
// Matches LiveVerification pacing; WS frames are full-sensor;
// final upload is the FULL frame (no ROI crop).
// Now includes BRIGHTNESS gate as the first check.

import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, WS_BASE } from "./api";
import { ensureReqId, getReqId } from "./storage";

function BlockingOverlay({ text = "Processing… Please wait." }) {
  return (
    <div
      role="alert"
      aria-busy="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        backdropFilter: "blur(2px)",
        pointerEvents: "all",
      }}
    >
      <svg width="56" height="56" viewBox="0 0 50 50" aria-hidden="true">
        <circle cx="25" cy="25" r="20" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" opacity="0.25" />
        <path fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" d="M25 5 a20 20 0 0 1 0 40">
          <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite" />
        </path>
      </svg>
      <div style={{ marginTop: 14, color: "#fff", fontSize: 16, textAlign: "center", padding: "6px 10px" }}>{text}</div>
    </div>
  );
}

export default function LiveIDVerification() {
  const navigate = useNavigate();

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const wsRef = useRef(null);
  const startedRef = useRef(false);
  const autoCapturedRef = useRef(false);

  const sendTickRef = useRef(0);

  const [status, setStatus] = useState("Idle");
  const [result, setResult] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);

  // ---- VIEWPORT / OVERLAY ----
  const [vp, setVp] = useState({
    w: typeof window !== "undefined" ? window.innerWidth : 0,
    h: typeof window !== "undefined" ? window.visualViewport?.height ?? window.innerHeight : 0,
  });
  useEffect(() => {
    const onResize = () =>
      setVp({
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

  function containLayout(containerW, containerH, vidW, vidH) {
    if (!vidW || !vidH) return { scale: 1, dx: 0, dy: 0, dispW: 0, dispH: 0 };
    const scale = Math.min(containerW / vidW, containerH / vidH);
    const dispW = vidW * scale,
      dispH = vidH * scale;
    return { scale, dx: (containerW - dispW) / 2, dy: (containerH - dispH) / 2, dispW, dispH };
  }

  function currentDisplayRect() {
    const v = videoRef.current;
    if (!v) return null;
    const vw = v.videoWidth || 0,
      vh = v.videoHeight || 0;
    if (!vw || !vh) return null;
    const { scale, dx, dy, dispW, dispH } = containLayout(vp.w, vp.h, vw, vh);
    return { scale, dx, dy, dispW, dispH, vw, vh };
  }

  // BACKEND-normalized mapping (for overlay only)
  function mapBoxToScreen(b, fw, fh) {
    const v = videoRef.current;
    if (!v || !b || b.length !== 4) return null;
    const geo = currentDisplayRect();
    if (!geo || !fw || !fh) return null;
    const { dx, dy, dispW, dispH } = geo;
    const [x1, y1, x2, y2] = b.map(Number);
    return {
      x: dx + (x1 / fw) * dispW,
      y: dy + (y1 / fh) * dispH,
      w: ((x2 - x1) / fw) * dispW,
      h: ((y2 - y1) / fh) * dispH,
    };
  }

  function mapRectToScreenRect(r, fw, fh) {
    const v = videoRef.current;
    if (!v || !r || r.length !== 4) return null;
    const geo = currentDisplayRect();
    if (!geo || !fw || !fh) return null;
    const { dx, dy, dispW, dispH } = geo;
    const [rx, ry, rw, rh] = r.map(Number);
    return {
      x: dx + (rx / fw) * dispW,
      y: dy + (ry / fh) * dispH,
      w: (rw / fw) * dispW,
      h: (rh / fh) * dispH,
    };
  }

  // Local placeholder guide (shown immediately on camera start)
  function localGuideRect() {
    const geo = currentDisplayRect();
    if (!geo) return null;
    const { dx, dy, dispW, dispH } = geo;
    const rectW = dispW * 0.95; // must match backend RECT_W_RATIO
    const rectH = dispH * 0.45; // must match backend RECT_H_RATIO
    const rectX = dx + (dispW - rectW) / 2;
    const rectY = dy + (dispH - rectH) / 2;
    return { x: rectX, y: rectY, w: rectW, h: rectH };
  }

  // ✅ Same constraints style as video page
  async function getBestStream() {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  }

  async function startCamera() {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("Requesting camera…");
    try {
      const reqId = await ensureReqId(API_BASE);
      const stream = await getBestStream();
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      v.muted = true;
      v.setAttribute("playsInline", "true");

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
        v.play().catch(() => {});
        setCameraOn(true);
      });

      const ws = new WebSocket(`${WS_BASE}/ws-id-live?req_id=${encodeURIComponent(reqId)}`);
      ws.onopen = () => setStatus("WS connected, streaming frames…");
      ws.onclose = () => setStatus("WS closed");
      ws.onerror = () => setStatus("WS error");
      ws.onmessage = (evt) => {
        try {
          setResult(JSON.parse(evt.data));
        } catch {}
      };
      wsRef.current = ws;
      startSendingFrames();
    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Camera unavailable. Check permissions.");
      startedRef.current = false;
      setCameraOn(false);
    }
  }

  // --- MATCH LiveVerification pacing exactly ---
  const SEND_FRAME_INTERVAL_MS = 100;
  const SEND_EVERY_NTH_FRAME = 1;

  function startSendingFrames() {
    let stop = false;
    const loop = () => {
      if (stop) return;
      const v = videoRef.current, ws = wsRef.current;
      if (!v || !ws || ws.readyState !== WebSocket.OPEN || !v.videoWidth || !v.videoHeight) {
        requestAnimationFrame(loop);
        return;
      }

      // Send FULL sensor frame to analyzer (no display scaling)
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

      sendTickRef.current = (sendTickRef.current + 1) % SEND_EVERY_NTH_FRAME;
      if (sendTickRef.current === 0) {
        const b64 = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
        if (b64) { try { ws.send(b64); } catch {} }
      }

      setTimeout(() => requestAnimationFrame(loop), SEND_FRAME_INTERVAL_MS);
    };
    requestAnimationFrame(loop);
    return () => { stop = true; };
  }

  // AUTO-CAPTURE when all gates pass
  useEffect(() => {
    const allGreen =
      !!result &&
      result.brightness_ok === true &&                  // ⬅️ new: brightness first
      result.id_card_detected === true &&
      result.id_overlap_ok === true &&
      result.id_size_ok === true &&
      result.face_on_id === true &&
      result.ocr_ok === true;

    if (cameraOn && allGreen && !isUploading && !autoCapturedRef.current) {
      autoCapturedRef.current = true;
      handleCapture();
    }
  }, [cameraOn, result, isUploading]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⬇️ FINAL CAPTURE: upload FULL frame (not ROI)
  async function handleCapture() {
    if (isUploading || !videoRef.current) return;
    try {
      setIsUploading(true);
      
      // Stop all detection and frame analysis since capture is complete
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try { wsRef.current.close(); } catch {}
      }
      wsRef.current = null;
      
      const reqId = getReqId();
      if (!reqId) throw new Error("No request id. Refresh the page.");
      const v = videoRef.current;

      const FW = v.videoWidth, FH = v.videoHeight;
      if (!FW || !FH) throw new Error("Camera not ready");

      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = FW;
      fullCanvas.height = FH;
      const fctx = fullCanvas.getContext("2d", { alpha: false });
      fctx.imageSmoothingEnabled = false;
      fctx.drawImage(v, 0, 0, FW, FH);

      const blob = await new Promise((res) => fullCanvas.toBlob(res, "image/jpeg", 0.95));
      const form = new FormData();
      form.append("image", blob, "id_full.jpg");

      const resp = await fetch(`${API_BASE}/upload-id-still?req_id=${encodeURIComponent(reqId)}`, {
        method: "POST",
        body: form,
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Upload failed");

      // Final teardown and navigation
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        try { videoRef.current.pause(); } catch {}
        videoRef.current.srcObject = null;
      }
      navigate("/", { replace: true });
    } catch (e) {
      console.error(e);
      alert(e.message || "Capture failed");
      autoCapturedRef.current = false;
    } finally {
      setIsUploading(false);
    }
  }

  useEffect(() => {
    return () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close();
      wsRef.current = null;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        try { videoRef.current.pause(); } catch {}
        videoRef.current.srcObject = null;
      }
      startedRef.current = false;
      autoCapturedRef.current = false;
      setCameraOn(false);
    };
  }, []);

  const guidance = (() => {
    if (!cameraOn) return "Tap Start Camera to begin.";
    if (!result) return "Connecting…";

    // ⬇️ brightness first
    if (result.brightness_ok === false) {
      if (result.brightness_status === "dark") return "💡 Increase lighting on the ID.";
      if (result.brightness_status === "bright") return "✨ Reduce glare or move away from direct light.";
      return "💡 Adjust lighting.";
    }

    if (!result.id_card_detected) return "📇 Place the ID card in view.";
    if (!result.id_overlap_ok) return "📐 Move ID fully into the box.";
    if (!result.id_size_ok) return "↔️ Move closer so the ID fills the box.";
    if (!result.face_on_id) return "👤 Make sure the ID portrait is visible.";
    if (!result.ocr_ok) return "🔎 Hold steady—text unclear.";
    return "✅ Perfect. Capturing…";
  })();

  // Overlay geometry
  const fw = result?.frame_w, fh = result?.frame_h;
  const backendGuide = result?.rect && fw && fh ? mapRectToScreenRect(result.rect, fw, fh) : null;
  const guideRect = backendGuide || localGuideRect();

  const idCardBox = result?.id_card_bbox && fw && fh ? mapBoxToScreen(result.id_card_bbox, fw, fh) : null;
  const faceBox = result?.largest_bbox && fw && fh ? mapBoxToScreen(result?.largest_bbox, fw, fh) : null;

  const fmt = (v, d = 2) => (typeof v === "number" && isFinite(v) ? v.toFixed(d) : "—");
  const metricsText =
    result && idCardBox
      ? [
          `conf ${fmt(result.id_card_conf)}`,
          `ar ${fmt(result.id_ar)}`,
          `in ${fmt(result.id_frac_in)}`,
          `size ${fmt(result.id_size_ratio)}`,
          `txt_in ${fmt(result.ocr_inside_ratio)}`,
          `hits ${result.ocr_hits ?? "—"}`,
          `conf ${fmt(result.ocr_mean_conf)}`,
        ].join(" | ")
      : null;

  return (
    <div className="position-relative" style={{ width: "100vw", height: "100dvh", overflow: "hidden", background: "#000" }}>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
      />

      {cameraOn && guideRect && (
        <>
          <svg width={vp.w} height={vp.h} viewBox={`0 0 ${vp.w} ${vp.h}`} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <defs>
              <mask id="rect-cutout">
                <rect x="0" y="0" width={vp.w} height={vp.h} fill="white" />
                <rect x={guideRect.x} y={guideRect.y} width={guideRect.w} height={guideRect.h} rx="12" ry="12" fill="black" />
              </mask>
            </defs>
            <rect x="0" y="0" width={vp.w} height={vp.h} fill="rgba(0,0,0,0.55)" mask="url(#rect-cutout)" />
            <rect
              x={guideRect.x}
              y={guideRect.y}
              width={guideRect.w}
              height={guideRect.h}
              rx="12"
              ry="12"
              fill="none"
              stroke="white"
              strokeWidth="3"
              strokeDasharray="6 6"
            />
            {idCardBox && (
              <rect
                x={idCardBox.x}
                y={idCardBox.y}
                width={idCardBox.w}
                height={idCardBox.h}
                fill="none"
                stroke={result?.verified ? "#00dc00" : "#00b4ff"}
                strokeWidth="3"
              />
            )}
            {faceBox && <rect x={faceBox.x} y={faceBox.y} width={faceBox.w} height={faceBox.h} fill="none" stroke="#ff8c00" strokeWidth="3" />}
          </svg>

          {metricsText && idCardBox && (
            <div
              style={{
                position: "absolute",
                left: idCardBox.x,
                top: Math.max(20, idCardBox.y - 10),
                background: "rgba(0,0,0,0.6)",
                color: "#fff",
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: 12.5,
                lineHeight: 1.25,
                pointerEvents: "none",
              }}
            >
              {metricsText}
            </div>
          )}

          {result?.verified && idCardBox && (
            <div
              style={{
                position: "absolute",
                left: idCardBox.x,
                top: Math.max(20, idCardBox.y - 28),
                background: "rgba(0,0,0,0.6)",
                color: "rgb(0,220,0)",
                borderRadius: 6,
                padding: "4px 8px",
                fontSize: 14,
                fontWeight: 600,
                pointerEvents: "none",
              }}
            >
              ID VERIFIED (OCR + FACE)
            </div>
          )}
        </>
      )}

      {/* Raise banner a bit to avoid overlap */}
      {cameraOn && guideRect && (
        <div
          className="position-absolute w-100 d-flex justify-content-center"
          style={{ top: Math.max(8, guideRect.y - 48), left: 0, padding: "0 16px" }}
        >
          <div
            style={{
              maxWidth: 680,
              width: "100%",
              textAlign: "center",
              background: "rgba(0,0,0,0.6)",
              color: "#fff",
              borderRadius: 12,
              padding: "10px 14px",
              fontSize: 16,
              backdropFilter: "blur(4px)",
            }}
          >
            {guidance}
          </div>
        </div>
      )}

      {!cameraOn && (
        <div className="position-absolute w-100 d-flex justify-content-center" style={{ bottom: 32, left: 0 }}>
          <button className="btn btn-primary" onClick={startCamera}>
            Start Camera
          </button>
        </div>
      )}

      {cameraOn && (
        <div className="position-absolute w-100 d-flex flex-column align-items-center" style={{ bottom: 24, left: 0, gap: 8 }}>
          <div className="text-light text-center" style={{ background: "rgba(0,0,0,0.35)", borderRadius: 12, padding: "6px 10px", fontSize: 12 }}>
            {status}
          </div>
        </div>
      )}

      {isUploading && <BlockingOverlay text="Processing your ID… Please wait." />}
    </div>
  );
}