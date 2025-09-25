// LiveIDVerification.jsx — Freeze-on-verify with exact-frame upload
// - Sends frames as JSON { seq, img } (img = base64 JPEG).
// - Keeps a small FE ring buffer of sent frames keyed by seq.
// - On first verified payload, stops streaming, closes WS, pauses camera,
//   and uploads the exact analyzed frame (cropped by backend rect).

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
      <div style={{ marginTop: 14, color: "#fff", fontSize: 16, textAlign: "center", padding: "6px 10px" }}>
        {text}
      </div>
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

  // Viewport / overlay sizing
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

  // ---- Geometry helpers (for overlay only — capture uses backend rect on analyzed pixels) ----
  function containLayout(containerW, containerH, vidW, vidH) {
    if (!vidW || !vidH) return { scale: 1, dx: 0, dy: 0, dispW: 0, dispH: 0, vw: vidW, vh: vidH };
    const scale = Math.min(containerW / vidW, containerH / vidH);
    const dispW = vidW * scale;
    const dispH = vidH * scale;
    return { scale, dx: (containerW - dispW) / 2, dy: (containerH - dispH) / 2, dispW, dispH, vw: vidW, vh: vidH };
  }

  function currentDisplayRect() {
    const v = videoRef.current; if (!v) return null;
    const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
    if (!vw || !vh) return null;
    return containLayout(vp.w, vp.h, vw, vh);
  }

  function localGuideRect() {
    const geo = currentDisplayRect(); if (!geo) return null;
    const { dx, dy, dispW, dispH } = geo;
    const rectW = dispW * 0.95; // must mirror backend RECT_W_RATIO
    const rectH = dispH * 0.45; // must mirror backend RECT_H_RATIO
    return { x: dx + (dispW - rectW) / 2, y: dy + (dispH - rectH) / 2, w: rectW, h: rectH };
  }

  // ---- Freeze-on-verify plumbing ----
  const sendLoopStopRef = useRef(null);
  const lockingRef = useRef(false); // prevent double-freeze

  // Tiny ring buffer: seq -> { b64, w, h }
  const seqRef = useRef(0);
  const bufRef = useRef(new Map());
  const BUF_MAX = 24;

  function bufferPut(seq, b64, w, h) {
    const m = bufRef.current;
    m.set(seq, { b64, w, h });
    while (m.size > BUF_MAX) {
      const firstKey = m.keys().next().value;
      m.delete(firstKey);
    }
  }
  function bufferGet(seq) {
    return bufRef.current.get(seq) || null;
  }

  async function startCamera() {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("Requesting camera…");
    try {
      const reqId = await ensureReqId(API_BASE);

      // Prefer rear camera; try HD then fall back
      const trials = [
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: { facingMode: { ideal: "environment" } }, audio: false },
      ];
      let stream = null;
      for (const c of trials) {
        try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch {}
      }
      if (!stream) throw new Error("Camera unavailable");

      streamRef.current = stream;

      const v = videoRef.current; if (!v) return;
      v.srcObject = stream;
      v.muted = true;
      v.setAttribute("playsInline", "true");

      // Nice-to-have continuous focus/exposure
      try {
        const [track] = stream.getVideoTracks();
        const caps = track.getCapabilities?.() || {};
        const adv = {};
        if (caps.focusMode && caps.focusMode.includes("continuous")) adv.focusMode = "continuous";
        if (caps.exposureMode && caps.exposureMode.includes("continuous")) adv.exposureMode = "continuous";
        if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] });
      } catch {}

      v.addEventListener("loadedmetadata", function onLoaded() {
        v.removeEventListener("loadedmetadata", onLoaded);
        setStatus(`Video ${v.videoWidth}×${v.videoHeight}`);
        v.play().catch(()=>{});
        setCameraOn(true);
      });

      // Open WS
      const ws = new WebSocket(`${WS_BASE}/ws-id-live?req_id=${encodeURIComponent(reqId)}`);
      wsRef.current = ws;
      ws.onopen = () => setStatus("WS connected, streaming frames…");
      ws.onerror = () => setStatus("WS error");
      ws.onclose = () => setStatus("WS closed");

      ws.onmessage = async (evt) => {
        try {
          const data = JSON.parse(evt.data);
          setResult(data);

          // FIRST verified => lock, stop streaming, pause camera, upload exact analyzed frame
          if (data?.verified === true && !lockingRef.current) {
            lockingRef.current = true;
            setStatus("Verified — locking frame…");

            // 1) stop send loop
            try { sendLoopStopRef.current?.(); } catch {}
            sendLoopStopRef.current = null;

            // 2) close WS
            try { wsRef.current?.close(); } catch {}
            wsRef.current = null;

            // 3) pause/stop camera
            try { videoRef.current?.pause(); } catch {}
            try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
            streamRef.current = null;

            // 4) fetch exact analyzed frame from buffer via analyzed_seq
            const seq = data?.analyzed_seq;
            const entry = seq ? bufferGet(seq) : null;
            if (!entry) {
              // Very rare if buffer overflowed; allow retry
              setStatus("Verified but frame not found. Please hold steady and retry.");
              lockingRef.current = false;
              return;
            }

            // 5) upload cropped region from that exact frame
            setIsUploading(true);
            try {
              await uploadCroppedFromB64(entry.b64, entry.w, entry.h, data?.rect);
              navigate("/", { replace: true });
              setTimeout(() => {
                if (window.location.pathname !== "/") window.location.assign("/");
              }, 200);
            } catch (e) {
              console.error("Upload failed:", e);
              alert("Upload failed. Please try again.");
              setIsUploading(false);
              lockingRef.current = false;
            }
          }
        } catch {}
      };

      // Start encoding/sending frames with seq + ring buffer
      sendLoopStopRef.current = startSendingFrames();

    } catch (err) {
      console.error(err);
      setStatus(err?.message || "Camera unavailable. Check permissions.");
      startedRef.current = false;
      setCameraOn(false);
    }
  }

  // Encode + send loop (JSON envelope {seq, img}), store each sent frame in the ring buffer
  function startSendingFrames() {
    let stopped = false;
    let sending = false;
    let lastSentAt = 0;
    const TARGET_FPS = 30;
    const MIN_INTERVAL_MS = Math.floor(1000 / TARGET_FPS);
    const SEND_EVERY_NTH = 5; // ~6fps to server
    let tick = 0;

    const loop = () => {
      if (stopped) return;
      const v = videoRef.current, ws = wsRef.current;
      if (!v || !ws || ws.readyState !== WebSocket.OPEN) {
        requestAnimationFrame(loop);
        return;
      }
      if (!(v.videoWidth && v.videoHeight)) {
        requestAnimationFrame(loop);
        return;
      }

      const now = performance.now();
      const timeOk = now - lastSentAt >= MIN_INTERVAL_MS;
      tick = (tick + 1) % SEND_EVERY_NTH;
      if (!timeOk && tick !== 0) {
        requestAnimationFrame(loop);
        return;
      }
      if (sending) { requestAnimationFrame(loop); return; }
      if (ws.bufferedAmount > 256 * 1024) { requestAnimationFrame(loop); return; }

      sending = true;
      try {
        const maxW = 960;
        const scale = Math.min(1, maxW / v.videoWidth);
        const W = Math.round(v.videoWidth * scale);
        const H = Math.round(v.videoHeight * scale);

        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(v, 0, 0, W, H);

        const b64 = canvas.toDataURL("image/jpeg", 0.6).split(",")[1];
        if (b64) {
          const seq = ++seqRef.current;
          bufferPut(seq, b64, W, H);
          try {
            ws.send(JSON.stringify({ seq, img: b64 }));
            lastSentAt = now;
          } catch {}
        }
      } finally {
        sending = false;
        setTimeout(() => requestAnimationFrame(loop), 16);
      }
    };

    requestAnimationFrame(loop);
    return () => { stopped = true; };
  }

  // Upload a crop from the exact analyzed frame (base64 -> <img> -> crop via backend rect -> POST)
  async function uploadCroppedFromB64(b64, fw, fh, rect) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `data:image/jpeg;base64,${b64}`;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });

    const full = document.createElement("canvas");
    full.width = fw; full.height = fh;
    const fctx = full.getContext("2d", { alpha: false });
    fctx.imageSmoothingEnabled = false;
    fctx.drawImage(img, 0, 0, fw, fh);

    let cropCanvas = full;
    if (Array.isArray(rect) && rect.length === 4) {
      let [rx, ry, rw, rh] = rect.map(Number);
      // clamp & integerize to be safe
      rx = Math.max(0, Math.min(fw - 1, Math.floor(rx)));
      ry = Math.max(0, Math.min(fh - 1, Math.floor(ry)));
      rw = Math.max(1, Math.min(fw - rx, Math.round(rw)));
      rh = Math.max(1, Math.min(fh - ry, Math.round(rh)));

      const cx = document.createElement("canvas");
      cx.width = rw; cx.height = rh;
      const cctx = cx.getContext("2d", { alpha: false });
      cctx.imageSmoothingEnabled = false;
      cctx.drawImage(full, rx, ry, rw, rh, 0, 0, rw, rh);
      cropCanvas = cx;
    }

    const blob = await new Promise((res) => cropCanvas.toBlob(res, "image/jpeg", 0.95));
    if (!blob) throw new Error("Failed to encode crop");

    const reqId = getReqId();
    if (!reqId) throw new Error("No request id");

    const form = new FormData();
    form.append("image", blob, "id_roi.jpg");
    const resp = await fetch(`${API_BASE}/upload-id-still?req_id=${encodeURIComponent(reqId)}`, {
      method: "POST",
      body: form,
    });
    const data = await resp.json();
    if (!resp.ok || !data?.ok) throw new Error(data?.error || "Upload failed");
  }

  // Cleanup
  useEffect(() => {
    return () => {
      try { sendLoopStopRef.current?.(); } catch {}
      sendLoopStopRef.current = null;
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
      try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
      streamRef.current = null;
      try { videoRef.current?.pause(); } catch {}
      if (videoRef.current) videoRef.current.srcObject = null;
      startedRef.current = false;
      setCameraOn(false);
    };
  }, []);

  // Guidance text (UX only)
  const guidance = (() => {
    if (!cameraOn) return "Tap “Start Camera” to begin.";
    if (!result) return "Connecting…";
    if (!result.id_card_detected) return "📇 Place the ID card in view.";
    if (!result.id_overlap_ok) return "📐 Move ID fully into the box.";
    if (!result.id_size_ok) return "↔️ Move closer so the ID fills the box.";
    if (!result.face_on_id) return "👤 Make sure the ID portrait is visible.";
    if (!result.ocr_ok) return "🔎 Hold steady—text unclear.";
    return "✅ Perfect. Capturing…";
  })();

  // Overlay rectangle (for user guidance; capture uses backend rect on analyzed frame)
  const guideRect = localGuideRect();

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
              x={guideRect.x} y={guideRect.y} width={guideRect.w} height={guideRect.h}
              rx="12" ry="12" fill="none" stroke="white" strokeWidth="3" strokeDasharray="6 6"
            />
          </svg>

          <div className="position-absolute w-100 d-flex justify-content-center" style={{ top: Math.max(8, guideRect.y - 16), left: 0, padding: "0 16px" }}>
            <div
              style={{
                maxWidth: 680, width: "100%", textAlign: "center",
                background: "rgba(0,0,0,0.6)", color: "#fff",
                borderRadius: 12, padding: "10px 14px", fontSize: 16, backdropFilter: "blur(4px)",
              }}
            >
              {guidance}
            </div>
          </div>
        </>
      )}

      {!cameraOn && (
        <div className="position-absolute w-100 d-flex justify-content-center" style={{ bottom: 32, left: 0 }}>
          <button className="btn btn-primary" onClick={startCamera}>Start Camera</button>
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