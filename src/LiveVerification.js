// LiveVerification.jsx
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE, WS_BASE } from "./api";
import { ensureReqId, getReqId } from "./storage";

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

  // NEW: prevent double uploads / races
  const hasUploadedRef = useRef(false);
  const uploadingRef = useRef(false);

  const sendTickRef = useRef(0);

  // Timeouts & countdown
  const timeoutIdRef = useRef(null);
  const countdownIdRef = useRef(null);
  const sessionEndAtRef = useRef(null);
  const [remainingMs, setRemainingMs] = useState(null);

  // Tunables
  const STABLE_REQUIRED_MS = 1000;
  const RECORD_TARGET_MS = 8000;
  const SEND_FRAME_INTERVAL_MS = 80;
  const SEND_EVERY_NTH_FRAME = 5;
  const TIMEOUT_TOTAL_MS = 30000;

  const [status, setStatus] = useState("Idle");
  const [result, setResult] = useState(null);

  // Viewport & ellipse
  const [vp, setVp] = useState({
    w: typeof window !== "undefined" ? window.innerWidth : 0,
    h: typeof window !== "undefined" ? window.innerHeight : 0,
  });
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const ellipseCx = vp.w / 2;
  const ellipseCy = vp.h / 2;
  const ellipseRx = (vp.w * 0.9) / 2;
  const ellipseRy = (vp.h * 0.7) / 2;
  const bannerTop = Math.max(16, ellipseCy - ellipseRy - 60);

  function cleanup() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.close(); } catch {}
    }
    wsRef.current = null;

    if (recRef.current) {
      try { recRef.current.stop(); } catch {}
      recRef.current = null;
    }
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

    if (timeoutIdRef.current) { clearTimeout(timeoutIdRef.current); timeoutIdRef.current = null; }
    if (countdownIdRef.current) { clearInterval(countdownIdRef.current); countdownIdRef.current = null; }
    sessionEndAtRef.current = null;
    setRemainingMs(null);

    startedRef.current = false;
  }

  function handleTimeout() {
    cleanup();
    navigate("/", { replace: true });
    setTimeout(() => {
      if (window.location.pathname !== "/") window.location.assign("/");
    }, 200);
  }

  function startCountdown() {
    sessionEndAtRef.current = performance.now() + TIMEOUT_TOTAL_MS;
    setRemainingMs(TIMEOUT_TOTAL_MS);
    countdownIdRef.current = setInterval(() => {
      const left = Math.max(0, sessionEndAtRef.current - performance.now());
      setRemainingMs(left);
    }, 200);
  }

  async function startCamera() {
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("Requesting camera…");
    timeoutIdRef.current = setTimeout(handleTimeout, TIMEOUT_TOTAL_MS);
    startCountdown();

    try {
      await ensureReqId(API_BASE);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
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
        safeSend(ws, JSON.stringify({ ellipseCx, ellipseCy, ellipseRx, ellipseRy }));
      };
      ws.onerror = () => setStatus((s) => s + " | WS error");
      ws.onclose = () => setStatus((s) => s + " | WS closed");
      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          setResult(data);

          const enabled = data?.checks || {
            face: true, ellipse: true, brightness: true, spoof: true, glasses: true,
          };
          const passIfEnabled = (flag, condition) => (flag ? !!condition : true);
          const allGood =
            passIfEnabled(enabled.face,       data?.face_detected === true) &&
            passIfEnabled(enabled.ellipse,    data?.inside_ellipse === true) &&
            passIfEnabled(enabled.brightness, data?.brightness_status === "ok") &&
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

      startSendingFrames();
    } catch (err) {
      startedRef.current = false;
      setStatus(err?.message || "Camera unavailable. Check permissions.");
      if (timeoutIdRef.current) { clearTimeout(timeoutIdRef.current); timeoutIdRef.current = null; }
      if (countdownIdRef.current) { clearInterval(countdownIdRef.current); countdownIdRef.current = null; }
      setRemainingMs(null);
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
      const cw = vp.w || window.innerWidth, ch = vp.h || window.innerHeight;
      const canvas = document.createElement("canvas"); canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext("2d");
      const vidW = v.videoWidth, vidH = v.videoHeight;
      const scale = Math.max(cw / vidW, ch / vidH);
      const drawW = vidW * scale, drawH = vidH * scale;
      const dx = (cw - drawW) / 2, dy = (ch - drawH) / 2;
      ctx.save(); ctx.translate(cw, 0); ctx.scale(-1, 1); ctx.drawImage(v, dx, dy, drawW, drawH); ctx.restore();

      if (Math.random() < 0.02) safeSend(ws, JSON.stringify({ ellipseCx, ellipseCy, ellipseRx, ellipseRy }));

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

  function startRecording() {
    if (recRef.current || !streamRef.current || uploadingRef.current || hasUploadedRef.current) return;
    chunksRef.current = [];
    let mr;
    try { mr = new MediaRecorder(streamRef.current, { mimeType: "video/webm;codecs=vp9" }); }
    catch { try { mr = new MediaRecorder(streamRef.current, { mimeType: "video/webm" }); } catch { mr = new MediaRecorder(streamRef.current); } }

    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = async () => {
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
      await uploadSingle(blob);
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
    stableStartRef.current = null;
  }

  async function uploadSingle(blob) {
    try {
      const reqId = getReqId();
      if (!reqId) throw new Error("No request id. Refresh the page.");

      const form = new FormData();
      form.append("video", blob, "live_capture.webm");

      const res = await fetch(`${API_BASE}/upload-live-clip?req_id=${encodeURIComponent(reqId)}`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) throw new Error("Upload failed");
      await res.json();

      cleanup();
      navigate("/", { replace: true });
      setTimeout(() => {
        if (window.location.pathname !== "/") window.location.assign("/");
      }, 200);
    } catch (e) {
      console.error("Upload error:", e);
      setStatus("Upload error");
    }
  }

  useEffect(() => () => { cleanup(); }, []);

  const guidance = (() => {
    if (!result) return "Click Start Camera to begin";
    const enabled = result?.checks || {
      face: true, ellipse: true, brightness: true, spoof: true, glasses: true,
    };

    if (enabled.brightness && result.brightness_status === "too_dark")   return "💡 Lighting too low — move to a brighter place.";
    if (enabled.brightness && result.brightness_status === "too_bright") return "☀️ Lighting too strong — reduce direct light.";
    if (enabled.face && !result.face_detected)                           return "❌ No face detected.";
    if (enabled.face && result.num_faces > 1)                            return "👥 Multiple faces detected — only you should be in the frame.";
    if (enabled.glasses && result.glasses_detected === true)             return "🕶️ Please remove glasses.";
    if (enabled.ellipse && !result.inside_ellipse)                       return "🎯 Please bring your face fully inside the oval.";
    if (enabled.spoof && result.spoof_is_real === false)                 return "🔒 Possible spoof detected — show your live face clearly.";
    return recRef.current ? "🎬 Recording… hold steady." : "✅ Perfect — hold steady.";
  })();

  const remainingSec = remainingMs != null ? Math.ceil(remainingMs / 1000) : null;

  return (
    <div className="position-relative" style={{ width:"100vw", height:"100vh", overflow:"hidden", background:"#000" }}>
      <video ref={videoRef} autoPlay muted playsInline
        style={{ position:"absolute", inset:0, width:"100vw", height:"100vh", objectFit:"cover", transform:"scaleX(-1)" }}/>
      <svg width={vp.w} height={vp.h} viewBox={`0 0 ${vp.w} ${vp.h}`} style={{ position:"absolute", inset:0, pointerEvents:"none" }}>
        <defs>
          <mask id="cutout-mask">
            <rect x="0" y="0" width={vp.w} height={vp.h} fill="white"/>
            <ellipse cx={ellipseCx} cy={ellipseCy} rx={ellipseRx} ry={ellipseRy} fill="black"/>
          </mask>
        </defs>
        <rect x="0" y="0" width={vp.w} height={vp.h} fill="rgba(0,0,0,0.55)" mask="url(#cutout-mask)"/>
        <ellipse cx={ellipseCx} cy={ellipseCy} rx={ellipseRx} ry={ellipseRy} fill="none" stroke="white" strokeWidth="3" strokeDasharray="6 6"/>
      </svg>

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
        <button className="btn btn-success" onClick={startCamera} disabled={startedRef.current}>
          {startedRef.current ? 'Camera Started' : 'Start Camera'}
        </button>
        <div className="text-light text-center" style={{ background:"rgba(0,0,0,0.35)", borderRadius:12, padding:"6px 10px", fontSize:12 }}>
          {status}
          {result?.skipped ? " | (fast mode)" : ""}
          {typeof result?.num_faces === "number" ? ` | faces: ${result.num_faces}` : ""}
        </div>
      </div>
    </div>
  );
}

export default LiveVerification;