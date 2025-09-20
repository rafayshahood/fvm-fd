// LiveVerification.jsx
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, WS_BASE } from "./api";
import { ensureReqId, getReqId } from "./storage";

// Minimal full-screen blocking overlay (spinner + message)
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
        <circle
          cx="25" cy="25" r="20"
          fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" opacity="0.25"
        />
        <path
          fill="none" stroke="white" strokeWidth="5" strokeLinecap="round"
          d="M25 5 a20 20 0 0 1 0 40"
        >
          <animateTransform
            attributeName="transform" type="rotate"
            from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite"
          />
        </path>
      </svg>
      <div style={{ marginTop: 14, color: "#fff", fontSize: 16, textAlign: "center", padding: "6px 10px" }}>
        {text}
      </div>
    </div>
  );
}

function LiveVerification() {
  const navigate = useNavigate();

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const wsRef = useRef(null);
  const startedRef = useRef(false);

  // Recording
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const stableStartRef = useRef(null);
  const recordingStartRef = useRef(null);
  const abortingRef = useRef(false);

  // Offscreen canvas for upright recording
  const recCanvasRef = useRef(null);
  const recCtxRef = useRef(null);
  const recRAFRef = useRef(null);

  // Double-upload guards
  const hasUploadedRef = useRef(false);
  const uploadingRef = useRef(false);

  const sendTickRef = useRef(0);

  // Session timeout & countdown (start ONLY when analyzer is ready)
  const timeoutIdRef = useRef(null);
  const countdownIdRef = useRef(null);
  const sessionEndAtRef = useRef(null);
  const analyzerReadyRef = useRef(false); // NEW: flips on first analyzer payload
  const [remainingMs, setRemainingMs] = useState(null);

  // Tunables
  const STABLE_REQUIRED_MS = 1000;
  const RECORD_TARGET_MS = 8000;
  const SEND_FRAME_INTERVAL_MS = 80;
  const SEND_EVERY_NTH_FRAME = 5; // 5fps regardless of camera FPS
  const TIMEOUT_TOTAL_MS = 30000;

  const [status, setStatus] = useState("Idle");
  const [result, setResult] = useState(null);

  // Show blocking overlay during upload/processing
  const [isProcessing, setIsProcessing] = useState(false);

  // Viewport (use visualViewport height for mobile)
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

  // Contain layout: show full sensor without cropping
  function containLayout(containerW, containerH, vidW, vidH) {
    if (!vidW || !vidH) return { scale: 1, dx: 0, dy: 0, dispW: 0, dispH: 0 };
    const scale = Math.min(containerW / vidW, containerH / vidH);
    const dispW = vidW * scale;
    const dispH = vidH * scale;
    return { scale, dx: (containerW - dispW) / 2, dy: (containerH - dispH) / 2, dispW, dispH };
  }

  // Ellipse defined inside the displayed video (mapped to video coords for backend)
  function currentDisplayEllipse() {
    const v = videoRef.current; if (!v) return null;
    const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
    if (!vw || !vh) return null;
    const { scale, dx, dy, dispW, dispH } = containLayout(vp.w, vp.h, vw, vh);

    const ellipseRxDisp = (dispW * 0.9) / 2;
    const ellipseRyDisp = (dispH * 0.7) / 2;
    const ellipseCxDisp = dx + dispW / 2;
    const ellipseCyDisp = dy + dispH / 2;

    // Map displayed ellipse → video pixel coords for backend
    const ellipseRxVid = ellipseRxDisp / scale;
    const ellipseRyVid = ellipseRyDisp / scale;
    const ellipseCxVid = (ellipseCxDisp - dx) / scale;
    const ellipseCyVid = (ellipseCyDisp - dy) / scale;

    return {
      disp: { cx: ellipseCxDisp, cy: ellipseCyDisp, rx: ellipseRxDisp, ry: ellipseRyDisp },
      vid:  { cx: ellipseCxVid, cy: ellipseCyVid, rx: ellipseRxVid, ry: ellipseRyVid },
    };
  }

  // Offscreen canvas drawing for recording upright pixels
  function startRecCanvasDraw() {
    const v = videoRef.current;
    if (!v) return;
    const cw = v.videoWidth, ch = v.videoHeight;
    if (!cw || !ch) return;

    let c = recCanvasRef.current;
    if (!c) {
      c = document.createElement("canvas");
      recCanvasRef.current = c;
    }
    c.width = cw; c.height = ch;
    recCtxRef.current = c.getContext("2d");

    const draw = () => {
      const ctx = recCtxRef.current;
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, cw, ch);
      recRAFRef.current = requestAnimationFrame(draw);
    };
    draw();
  }

  function stopRecCanvasDraw() {
    if (recRAFRef.current) cancelAnimationFrame(recRAFRef.current);
    recRAFRef.current = null;
    recCtxRef.current = null;
  }

  function clearTimers() {
    if (timeoutIdRef.current) { clearTimeout(timeoutIdRef.current); timeoutIdRef.current = null; }
    if (countdownIdRef.current) { clearInterval(countdownIdRef.current); countdownIdRef.current = null; }
    sessionEndAtRef.current = null;
    setRemainingMs(null);
  }

  function cleanup() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.close(); } catch {}
    }
    wsRef.current = null;

    if (recRef.current) {
      try { recRef.current.stop(); } catch {}
      recRef.current = null;
    }
    stopRecCanvasDraw();

    chunksRef.current = [];
    recordingStartRef.current = null;
    abortingRef.current = false;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch {}
      videoRef.current.srcObject = null;
    }

    clearTimers();
    startedRef.current = false;
    analyzerReadyRef.current = false;
  }

  function handleTimeout() {
    cleanup();
    setIsProcessing(false); // ensure overlay is gone on timeout
    navigate("/", { replace: true });
    setTimeout(() => {
      if (window.location.pathname !== "/") window.location.assign("/");
    }, 200);
  }

  function startCountdownAndTimeout() {
    // Start the 30s window only when analyzer is ready (first payload)
    sessionEndAtRef.current = performance.now() + TIMEOUT_TOTAL_MS;
    setRemainingMs(TIMEOUT_TOTAL_MS);
    countdownIdRef.current = setInterval(() => {
      const left = Math.max(0, sessionEndAtRef.current - performance.now());
      setRemainingMs(left);
    }, 200);
    timeoutIdRef.current = setTimeout(handleTimeout, TIMEOUT_TOTAL_MS);
  }

  async function startCamera() {
    if (startedRef.current || isProcessing) return; // block while processing
    startedRef.current = true;
    setStatus("Requesting camera…");

    try {
      await ensureReqId(API_BASE);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;

      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      v.muted = true;
      v.playsInline = true;
      v.addEventListener("loadedmetadata", function onLoaded() {
        v.removeEventListener("loadedmetadata", onLoaded);
        setStatus(`Video ${v.videoWidth}×${v.videoHeight}`);
        const p = v.play(); if (p?.catch) p.catch(()=>{});
      });
      v.addEventListener("canplay", () => setStatus("Camera ready"));
      v.addEventListener("play", () => setStatus("Streaming…"));

      const ws = new WebSocket(`${WS_BASE}/ws-live-verification`);
      ws.onopen = () => {
        setStatus((s) => s + " | WS connected");
        // Send ellipse immediately
        const e = currentDisplayEllipse();
        if (e) {
          const { cx, cy, rx, ry } = e.vid;
          safeSend(ws, JSON.stringify({ ellipseCx: cx, ellipseCy: cy, ellipseRx: rx, ellipseRy: ry }));
        }
      };
      ws.onerror = () => setStatus((s) => s + " | WS error");
      ws.onclose = () => setStatus((s) => s + " | WS closed");

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          setResult(data);

          // FIRST analyzer payload → start the 30s session now
          if (!analyzerReadyRef.current) {
            analyzerReadyRef.current = true;
            startCountdownAndTimeout();
          }

          const enabled = data?.checks || {
            face: true, ellipse: true, brightness: true, frontal: true, spoof: true, glasses: true,
          };
          const passIfEnabled = (flag, condition) => (flag ? !!condition : true);

          const allGood =
            passIfEnabled(enabled.face,       data?.face_detected === true) &&
            passIfEnabled(enabled.ellipse,    data?.inside_ellipse === true) &&
            passIfEnabled(enabled.brightness, data?.brightness_status === "ok") &&
            passIfEnabled(enabled.frontal,    data?.front_facing === true) &&
            passIfEnabled(enabled.glasses,    data?.glasses_detected !== true) &&
            passIfEnabled(enabled.spoof,      data?.spoof_is_real !== false);

          const now = performance.now();

          if (allGood && !uploadingRef.current && !hasUploadedRef.current) {
            if (!stableStartRef.current) stableStartRef.current = now;
            const stableFor = now - stableStartRef.current;
            const isRecording = !!recRef.current;

            if (!isRecording && stableFor >= STABLE_REQUIRED_MS) {
              startRecording();
            }
            if (isRecording && recordingStartRef.current) {
              const recElapsed = now - recordingStartRef.current;
              if (recElapsed >= RECORD_TARGET_MS) stopRecording();
            }

            if (recRef.current) {
              const recElapsed = now - (recordingStartRef.current || now);
              setStatus(`Recording… ${(Math.min(100, (recElapsed / RECORD_TARGET_MS) * 100)).toFixed(0)}%`);
            } else {
              setStatus(`Stable — starting soon… ${(Math.min(100, (stableFor / STABLE_REQUIRED_MS) * 100)).toFixed(0)}%`);
            }
          } else {
            stableStartRef.current = null;
            if (recRef.current) {
              abortRecording();
              setStatus(`Recording aborted`);
            }
          }
        } catch {}
      };
      wsRef.current = ws;

      // Resend ellipse on resize (keeps backend in sync)
      const resendOnResize = () => {
        const e = currentDisplayEllipse();
        const ws2 = wsRef.current;
        if (ws2 && ws2.readyState === WebSocket.OPEN && e) {
          const { cx, cy, rx, ry } = e.vid;
          safeSend(ws2, JSON.stringify({ ellipseCx: cx, ellipseCy: cy, ellipseRx: rx, ellipseRy: ry }));
        }
      };
      window.addEventListener("resize", resendOnResize);
      window.addEventListener("orientationchange", resendOnResize);

      // Start streaming frames (5 fps)
      startSendingFrames();

      // Clean window listeners on unmount
      const clean = () => {
        window.removeEventListener("resize", resendOnResize);
        window.removeEventListener("orientationchange", resendOnResize);
      };
      // ensure removal on unmount
      setTimeout(() => {
        if (!startedRef.current) clean();
      }, 0);
    } catch (err) {
      startedRef.current = false;
      setStatus(err?.message || "Camera unavailable. Check permissions.");
      clearTimers();
    }
  }

  function safeSend(ws, payload) { try { ws.send(payload); } catch {} }

  function startSendingFrames() {
    let stop = false;
    const loop = () => {
      if (stop) return;
      const v = videoRef.current, ws = wsRef.current;
      if (!v || !ws || ws.readyState !== WebSocket.OPEN || !v.videoWidth || !v.videoHeight) {
        requestAnimationFrame(loop); return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

      // Occasionally refresh ellipse in VIDEO coordinates
      if (Math.random() < 0.02) {
        const e = currentDisplayEllipse();
        if (e) {
          const { cx, cy, rx, ry } = e.vid;
          safeSend(ws, JSON.stringify({ ellipseCx: cx, ellipseCy: cy, ellipseRx: rx, ellipseRy: ry }));
        }
      }

      sendTickRef.current = (sendTickRef.current + 1) % SEND_EVERY_NTH_FRAME;
      if (sendTickRef.current === 0) {
        const b64 = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
        if (b64) safeSend(ws, b64);
      }

      setTimeout(() => requestAnimationFrame(loop), SEND_FRAME_INTERVAL_MS);
    };
    requestAnimationFrame(loop);
    return () => { stop = true; };
  }

  // Record from the offscreen canvas (upright pixels)
  function startRecording() {
    if (recRef.current || !streamRef.current || uploadingRef.current || hasUploadedRef.current || isProcessing) return;

    startRecCanvasDraw();

    const canvas = recCanvasRef.current;
    const recStream = canvas.captureStream(30);

    chunksRef.current = [];
    let mr;
    try { mr = new MediaRecorder(recStream, { mimeType: "video/webm;codecs=vp9" }); }
    catch { try { mr = new MediaRecorder(recStream, { mimeType: "video/webm" }); } catch { mr = new MediaRecorder(recStream); } }

    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = async () => {
      stopRecCanvasDraw();

      if (abortingRef.current) {
        chunksRef.current = [];
        abortingRef.current = false;
        recordingStartRef.current = null;
        return;
      }
      if (hasUploadedRef.current) {
        chunksRef.current = [];
        recordingStartRef.current = null;
        return;
      }
      const blob = new Blob(chunksRef.current, { type: "video/webm" });
      chunksRef.current = [];
      uploadingRef.current = true;
      hasUploadedRef.current = true;

      setIsProcessing(true);
      await uploadSingle(blob);
      // overlay remains until navigation
      uploadingRef.current = false;
      recordingStartRef.current = null;
    };

    mr.start(250);
    recRef.current = mr;
    recordingStartRef.current = performance.now();
    setStatus("Recording…");
  }

  function stopRecording() {
    if (!recRef.current) return;
    try { recRef.current.stop(); } catch {}
    recRef.current = null;
    stableStartRef.current = null;
  }

  function abortRecording() {
    if (!recRef.current) return;
    abortingRef.current = true;
    try { recRef.current.stop(); } catch {}
    recRef.current = null;
    stopRecCanvasDraw();
    stableStartRef.current = null;
  }

  async function uploadSingle(blob) {
    try {
      const reqId = getReqId();
      if (!reqId) throw new Error("No request id. Refresh the page.");

      const form = new FormData();
      form.append("video", blob, "live_capture.webm");

      // 1) Upload & wait for conversion to finish (endpoint blocks until mp4 is saved)
      const res = await fetch(`${API_BASE}/upload-live-clip?req_id=${encodeURIComponent(reqId)}`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error("Upload failed");
      await res.json();

      // 2) Stay on this page with the blocking overlay UNTIL backend state flips
      //    to video_verified === true, so Home shows “Video Verified” immediately.
      const deadline = Date.now() + 20000; // wait up to 20s (usually far less)
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const stRes = await fetch(`${API_BASE}/req/state/${reqId}`, { cache: "no-store" });
        const st = await stRes.json();
        const ready = !!st?.state?.video_verified;
        if (ready) break;
        if (Date.now() > deadline) break; // fail-safe: don’t trap the user forever
        await new Promise((r) => setTimeout(r, 500));
      }

      // 3) Now teardown and go Home
      cleanup();
      navigate("/", { replace: true });
      setTimeout(() => {
        if (window.location.pathname !== "/") window.location.assign("/");
      }, 200);
    } catch (e) {
      console.error("Upload error:", e);
      setStatus("Upload error");
      setIsProcessing(false); // allow retry
      hasUploadedRef.current = false;
      uploadingRef.current = false;
    }
  }

  useEffect(() => () => { cleanup(); }, []);

  const guidance = (() => {
    if (!result) return "Click Start Camera to begin";
    const enabled = result?.checks || {
      face: true, ellipse: true, brightness: true, frontal: true, spoof: true, glasses: true,
    };

    if (enabled.brightness && result.brightness_status === "too_dark")   return "💡 Lighting too low — move to a brighter place.";
    if (enabled.brightness && result.brightness_status === "too_bright") return "☀️ Lighting too strong — reduce direct light.";
    if (enabled.face && !result.face_detected)                           return "❌ No face detected.";
    if (enabled.face && result.num_faces > 1)                            return "👥 Multiple faces detected — only you should be in the frame.";
    if (enabled.ellipse && !result.inside_ellipse)                       return "🎯 Please bring your face fully inside the oval.";
    if (enabled.frontal && result.front_facing === false)                return `🧭 ${result.front_guidance || "Please face the camera straight-on."}`;
    if (enabled.glasses && result.glasses_detected === true)             return "🕶️ Please remove glasses.";
    if (enabled.spoof && result.spoof_is_real === false)                 return "🔒 Possible spoof detected — show your live face clearly.";
    return recRef.current ? "🎬 Recording… hold steady." : "✅ Perfect — hold steady.";
  })();

  const remainingSec = remainingMs != null ? Math.ceil(remainingMs / 1000) : null;

  const dispEllipse = currentDisplayEllipse(); // for drawing only
  const bannerTop = Math.max(16, (dispEllipse ? dispEllipse.disp.cy - dispEllipse.disp.ry : 0) - 60);

  return (
    <div className="position-relative" style={{ width:"100vw", height:"100dvh", overflow:"hidden", background:"#000" }}>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          position:"absolute", inset:0, width:"100%", height:"100%",
          objectFit:"contain"
        }}
      />

      {dispEllipse && (
        <svg width={vp.w} height={vp.h} viewBox={`0 0 ${vp.w} ${vp.h}`} style={{ position:"absolute", inset:0, pointerEvents:"none" }}>
          <defs>
            <mask id="cutout-mask-live">
              <rect x="0" y="0" width={vp.w} height={vp.h} fill="white"/>
              <ellipse
                cx={dispEllipse.disp.cx}
                cy={dispEllipse.disp.cy}
                rx={dispEllipse.disp.rx}
                ry={dispEllipse.disp.ry}
                fill="black"
              />
            </mask>
          </defs>
          <rect x="0" y="0" width={vp.w} height={vp.h} fill="rgba(0,0,0,0.55)" mask="url(#cutout-mask-live)"/>
          <ellipse
            cx={dispEllipse.disp.cx}
            cy={dispEllipse.disp.cy}
            rx={dispEllipse.disp.rx}
            ry={dispEllipse.disp.ry}
            fill="none"
            stroke="white"
            strokeWidth="3"
            strokeDasharray="6 6"
          />
        </svg>
      )}

      <div className="position-absolute w-100 d-flex justify-content-center" style={{ top: bannerTop, left: 0, padding: "0 16px" }}>
        <div style={{ maxWidth: 680, width: "100%", textAlign: "center", background: "rgba(0,0,0,0.6)", color: "#fff",
                      borderRadius: 12, padding: "10px 14px", fontSize: 16, backdropFilter: "blur(4px)" }}>
          {guidance}
        </div>
      </div>

      {remainingSec != null && (
        <div className="position-absolute" style={{ top: 16, right: 16 }}>
          <div style={{ background: "rgba(0,0,0,0.6)", color: "#fff", borderRadius: 999, padding: "6px 12px", fontSize: 14 }}>
            Session ends in <strong>{remainingSec}s</strong>
          </div>
        </div>
      )}

      <div className="position-absolute w-100 d-flex flex-column align-items-center" style={{ bottom: 24, left: 0, gap: 8 }}>
        <button className="btn btn-success" onClick={startCamera} disabled={startedRef.current || isProcessing}>
          {startedRef.current ? 'Camera Started' : 'Start Camera'}
        </button>
        <div className="text-light text-center" style={{ background:"rgba(0,0,0,0.35)", borderRadius:12, padding:"6px 10px", fontSize:12 }}>
          {status}
          {result?.skipped ? " | (fast mode)" : ""}
          {typeof result?.num_faces === "number" ? ` | faces: ${result.num_faces}` : ""}
          {!analyzerReadyRef.current ? " | Connecting to analyzer…" : ""}
        </div>
      </div>

      {/* Block all interaction while uploading/processing */}
      {isProcessing && <BlockingOverlay text="Uploading your selfie video… Please wait." />}
    </div>
  );
}

export default LiveVerification;