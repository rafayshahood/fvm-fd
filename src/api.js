// api.js
const RUNPOD_DEFAULT = 'https://subjects-emma-salon-backed.trycloudflare.com';
const LOCAL_DEFAULT  = 'http://localhost:8888';

// Priority:
// 1) Vite env var (Vercel/locally: VITE_API_BASE)
// 2) CRA env var  (create-react-app: REACT_APP_API_BASE)
// 3) If on localhost -> LOCAL_DEFAULT else RUNPOD_DEFAULT
const fromVite   = typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE;
const fromCRA    = typeof process !== 'undefined' && process.env?.REACT_APP_API_BASE;
const isLocal    = typeof window !== 'undefined' && /^localhost$/i.test(window.location.hostname);

export const API_BASE = (fromVite || fromCRA || (isLocal ? LOCAL_DEFAULT : RUNPOD_DEFAULT)).replace(/\/+$/,'');
export const WS_BASE  = API_BASE.replace(/^http/i, 'ws');


main.py:
# main.py
from __future__ import annotations
from typing import Dict, Any, Optional, List

import base64
import json
import os
import shutil
import time
import subprocess
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from uuid import uuid4
import threading  # ← NEW

import cv2
import numpy as np
from fastapi import (
    FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect, Request, HTTPException
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from id import analyze_id_frame, run_id_extraction
from new_verif import run_verif  # noqa: F401
from all_video import (
    run_full_frame_pipeline,   # noqa: F401
    analyze_frame,
)

app = FastAPI(title="Face Verification API (stateless)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # stateless: no cookies/sessions
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/temp", StaticFiles(directory="temp"), name="temp")


# --- Debounce helper for boolean conditions (N consecutive frames to flip) ---
class BoolStreak:
    def __init__(self, n: int = 3):
        self.n = int(n)
        self.stable: Optional[bool] = None
        self.counter = 0

    def update(self, val: Optional[bool]) -> Optional[bool]:
        if val is None:
            return self.stable  # ignore None (don't change anything)
        if self.stable is None:
            self.stable = bool(val)
            self.counter = 0
            return self.stable
        if bool(val) == self.stable:
            self.counter = 0
            return self.stable
        # value differs → count toward flipping
        self.counter += 1
        if self.counter >= self.n:
            self.stable = bool(val)
            self.counter = 0
        return self.stable

# ---------- JSON safety for numpy types ----------
def _to_jsonable(o):
    import numpy as np
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.bool_, np.integer, np.floating)):
        return o.item()
    if isinstance(o, (list, tuple)):
        return [_to_jsonable(x) for x in o]
    if isinstance(o, dict):
        return {str(k): _to_jsonable(v) for k, v in o.items()}
    return o

# ---------- path helpers ----------
def _abs_url(request: Optional[Request], path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    if not request:
        return path
    base = str(request.base_url).rstrip("/")
    return f"{base}{path}"

def _req_id_from(request: Request) -> str:
    q = request.query_params.get("req_id")
    if q:
        return q
    h = request.headers.get("X-Req-ID")
    if h:
        return h
    return uuid4().hex

def _base_paths(req_id: str) -> Dict[str, Path]:
    base = Path("temp") / req_id
    id_dir = base / "id"            # front side folder
    id_back_dir = base / "id_back"  # back side folder
    rec_dir = base / "recordings"
    selected_dir = base / "selected_faces"
    return {
        "base": base,
        "id_dir": id_dir,
        "id_back_dir": id_back_dir,
        "rec_dir": rec_dir,
        "selected_dir": selected_dir
    }

def _used_id_image_path(id_dir: Path) -> Optional[Path]:
    enhanced = id_dir / "id_enhanced.jpg"
    raw = id_dir / "id_raw_upload.jpg"
    if enhanced.exists():
        return enhanced
    if raw.exists():
        return raw
    return None

def _used_id_back_image_path(id_back_dir: Path) -> Optional[Path]:
    enhanced = id_back_dir / "id_back_enhanced.jpg"
    raw = id_back_dir / "id_back_raw_upload.jpg"
    if enhanced.exists():
        return enhanced
    if raw.exists():
        return raw
    return None

def _selected_frame_files(selected_dir: Path, limit: Optional[int] = None) -> List[Path]:
    if not selected_dir.exists():
        return []
    exts = (".jpg", ".jpeg", ".png")
    files = [p for p in selected_dir.iterdir() if p.is_file() and p.suffix.lower() in exts]
    files.sort(key=lambda p: p.name)
    return files[:limit] if limit else files

def _result_urls_for_req(req_id: str, request: Optional[Request] = None) -> Dict[str, Any]:
    paths = _base_paths(req_id)
    base, id_dir, id_back_dir, selected_dir = (
        paths["base"], paths["id_dir"], paths["id_back_dir"], paths["selected_dir"]
    )
    used_id_front = _used_id_image_path(id_dir)
    used_id_back = _used_id_back_image_path(id_back_dir)
    cropped = id_dir / "cropped_id_face.jpg"
    video = base / "video.mp4"
    best = base / "best_match.png"

    id_image_url = f"/temp/{req_id}/id/{used_id_front.name}" if used_id_front else None
    id_back_image_url = f"/temp/{req_id}/id_back/{used_id_back.name}" if used_id_back else None
    cropped_face_url = f"/temp/{req_id}/id/{cropped.name}" if cropped.exists() else None
    video_url = f"/temp/{req_id}/video.mp4" if video.exists() else None
    best_match_url = f"/temp/{req_id}/best_match.png" if best.exists() else None
    selected_frames = [f"/temp/{req_id}/selected_faces/{p.name}" for p in _selected_frame_files(selected_dir)]

    return {
        "id_image_url": _abs_url(request, id_image_url),
        "id_back_image_url": _abs_url(request, id_back_image_url),
        "cropped_face_url": _abs_url(request, cropped_face_url),
        "video_url": _abs_url(request, video_url),
        "selected_frames": [_abs_url(request, u) for u in selected_frames],
        "best_match_url": _abs_url(request, best_match_url),
    }

# ---------- deepfake helpers (NEW) ----------
def _deepfake_json_path(base: Path) -> Path:
    return base / "deepfake.json"

def _write_deepfake_status(base: Path, payload: dict) -> None:
    try:
        _deepfake_json_path(base).write_text(json.dumps(payload, indent=2))
    except Exception as e:
        print(f"⚠️ deepfake status write error: {e}")

def _read_deepfake_status(base: Path) -> Optional[dict]:
    jf = _deepfake_json_path(base)
    if not jf.exists():
        return None
    try:
        return json.loads(jf.read_text() or "{}")
    except Exception:
        return None

def _run_genconvit(video_path: Path) -> dict:
    """
    Calls GenConViT/prediction.py and parses stdout.
    Returns dict: {ok, completed, is_real, is_deepfake, raw_tail}
    """
    cmd = [
        "python", "GenConViT/prediction.py",
        "--p", str(video_path),
        "--e", "--v", "--f", "10",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        out = proc.stdout or ""
        err = proc.stderr or ""
        is_real = None

        for line in out.splitlines():
            if "Fake: 0 Real: 1" in line:
                is_real = True
            elif "Fake: 1 Real: 0" in line:
                is_real = False

        if is_real is None:
            # conservative default (don’t block flow; mark as real)
            is_real = True

        return {
            "ok": True,
            "completed": True,
            "is_real": bool(is_real),
            "is_deepfake": (not bool(is_real)),
            "raw_tail": (out + "\n" + err)[-1200:],
        }
    except Exception as e:
        return {"ok": False, "completed": True, "error": str(e)}

def _deepfake_worker(mp4_path: Path, base: Path):
    # mark running
    _write_deepfake_status(base, {"ok": True, "completed": False, "started_at": time.time()})
    res = _run_genconvit(mp4_path)
    res["finished_at"] = time.time()
    _write_deepfake_status(base, res)

def _ensure_deepfake_async(mp4_path: Path, base: Path):
    """
    Starts (or restarts) the deepfake job for this req.
    """
    try:
        # Mark/reset as running immediately
        _write_deepfake_status(base, {"ok": True, "completed": False, "started_at": time.time()})
        t = threading.Thread(target=_deepfake_worker, args=(mp4_path, base), daemon=True)
        t.start()
    except Exception as e:
        print(f"⚠️ deepfake thread start error: {e}")
        _write_deepfake_status(base, {"ok": False, "completed": True, "error": str(e)})

def _deepfake_state_for_req(base: Path) -> dict:
    st = _read_deepfake_status(base)
    if not st:
        return {"status": "missing", "deepfake_detected": None}
    if not st.get("completed"):
        return {"status": "running", "deepfake_detected": None}
    if st.get("ok"):
        return {"status": "completed", "deepfake_detected": bool(st.get("is_deepfake"))}
    return {"status": "error", "deepfake_detected": None, "error": st.get("error")}

def _state_for_req(req_id: str) -> Dict[str, bool | Any]:
    paths = _base_paths(req_id)
    id_face = paths["id_dir"] / "cropped_id_face.jpg"     # front
    id_back_img = _used_id_back_image_path(paths["id_back_dir"])
    video_mp4 = paths["base"] / "video.mp4"
    deepfake = _deepfake_state_for_req(paths["base"])
    return {
        "id_verified": id_face.exists(),                                # front verified
        "id_back_verified": bool(id_back_img is not None),              # back verified
        "video_verified": video_mp4.exists() and video_mp4.stat().st_size > 0,
        "deepfake": deepfake,
    }

# ---------- simple helpers used by /verify-session fallbacks ----------
def _latest_file(directory: Path) -> Optional[Path]:
    if not directory.exists():
        return None
    files = [p for p in directory.iterdir() if p.is_file()]
    return max(files, key=lambda p: p.stat().st_mtime) if files else None

def _publish_canonical_mp4(src: Path, base_dir: Path) -> Path:
    dst = base_dir / "video.mp4"
    shutil.copyfile(src, dst)
    return dst

# ---------- ffprobe rotation + conversion with autorotate ----------
def _ffprobe_rotation(path: Path) -> int:
    if shutil.which("ffprobe") is None:
        return 0
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream_tags=rotate:side_data_list=displaymatrix",
            "-of", "json", str(path)
        ]
        out = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(out.stdout or "{}")
        try:
            rotate = int(data["streams"][0]["tags"]["rotate"])
            rotate = ((rotate % 360) + 360) % 360
            if rotate in (0, 90, 180, 270):
                return rotate
        except Exception:
            pass
        try:
            sdl = data["streams"][0].get("side_data_list", [])
            for sd in sdl:
                val = sd.get("rotation", None)
                if isinstance(val, (int, float)):
                    rot = int(round(val))
                    rot = ((rot % 360) + 360) % 360
                    if rot in (0, 90, 180, 270):
                        return rot
        except Exception:
            pass
    except Exception:
        return 0
    return 0

def convert_to_mp4(input_path: str | Path, output_dir: str | Path) -> Path:
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    out = output_dir / (input_path.stem + ".mp4")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH")
    rot = _ffprobe_rotation(input_path)
    vf = None
    if rot == 90:
        vf = "transpose=1"
    elif rot == 270:
        vf = "transpose=2"
    elif rot == 180:
        vf = "transpose=2,transpose=2"
    cmd = ["ffmpeg", "-y", "-i", str(input_path)]
    if vf:
        cmd += ["-vf", vf]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-c:a", "aac", str(out)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        try:
            if out.exists():
                out.unlink()
        except Exception:
            pass
        err = proc.stderr or "no stderr"
        raise RuntimeError(f"ffmpeg conversion failed for {input_path.name}: {err[:800]}")
    return out

# ------------------------------------------------------------------------------
# Minimal endpoints (stateless)
# ------------------------------------------------------------------------------
@app.post("/req/new")
async def req_new(request: Request):
    req_id = uuid4().hex
    paths = _base_paths(req_id)
    paths["base"].mkdir(parents=True, exist_ok=True)
    paths["id_dir"].mkdir(parents=True, exist_ok=True)
    paths["id_back_dir"].mkdir(parents=True, exist_ok=True)
    paths["rec_dir"].mkdir(parents=True, exist_ok=True)
    return JSONResponse({"ok": True, "req_id": req_id, "state": _state_for_req(req_id)})

@app.get("/req/state/{req_id}")
async def req_state(req_id: str, request: Request):
    if not (Path("temp") / req_id).exists():
        return JSONResponse({
            "ok": True,
            "req_id": req_id,
            "state": {
                "id_verified": False,
                "id_back_verified": False,
                "video_verified": False,
                "deepfake": {"status": "missing", "deepfake_detected": None}
            }
        })
    return JSONResponse({
        "ok": True,
        "req_id": req_id,
        "state": _state_for_req(req_id),
        **_result_urls_for_req(req_id, request)
    })


# ------------------------------------------------------------------------------
# LIVE ID WebSocket (front side — NEW conditions only)
# ------------------------------------------------------------------------------
# ------------------------------------------------------------------------------
# LIVE ID WebSocket — EXACT new-script conditions + full metrics + frame size
# Adds: per-frame `seq` support (JSON or raw b64); echoes `analyzed_seq`;
# sends an immediate payload on the first verified frame (no throttle).
# ------------------------------------------------------------------------------
@app.websocket("/ws-id-live")
async def websocket_id_live(ws: WebSocket):
    await ws.accept()
    qs = parse_qs(urlparse(str(ws.url)).query)
    req_id = (qs.get("req_id", [None])[0]) or (qs.get("sid", [None])[0]) or uuid4().hex
    base = Path("temp") / req_id
    (base / "id").mkdir(parents=True, exist_ok=True)

    STREAK_N = int(os.getenv("ID_STREAK_N", "3"))
    OCR_STREAK_N = max(1, STREAK_N // 2)

    streaks = {
        "id_card_detected": BoolStreak(STREAK_N),
        "id_overlap_ok":    BoolStreak(STREAK_N),
        "id_size_ok":       BoolStreak(STREAK_N),
        "face_on_id":       BoolStreak(STREAK_N),
        "ocr_ok":           BoolStreak(OCR_STREAK_N),
    }

    frame_idx = 0
    last_payload: Optional[dict] = None
    last_verified: bool = False  # to detect first verified edge

    try:
        while True:
            data = await ws.receive_text()

            # ---- Accept either raw base64 JPEG or JSON {"seq":..., "img": "<b64>"} ----
            seq_in: Optional[int] = None
            frame_bytes: Optional[bytes] = None
            try:
                # Fast path: raw base64 (back-compat)
                frame_bytes = base64.b64decode(data)
            except Exception:
                # Try JSON envelope
                try:
                    obj = json.loads(data)
                    seq_in = int(obj.get("seq")) if obj.get("seq") is not None else None
                    img_b64 = obj.get("img") or obj.get("frame")
                    if isinstance(img_b64, str):
                        frame_bytes = base64.b64decode(img_b64)
                except Exception:
                    frame_bytes = None

            if frame_bytes is None:
                continue

            np_arr = np.frombuffer(frame_bytes, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            if frame is None:
                continue

            H, W = frame.shape[:2]
            frame_idx += 1
            if seq_in is None:
                seq_in = frame_idx  # fallback seq when client didn't send one

            rep = analyze_id_frame(frame)

            # Debounced gates
            id_card_ok = streaks["id_card_detected"].update(rep.get("id_card_detected"))
            overlap_ok = streaks["id_overlap_ok"].update(rep.get("id_overlap_ok"))
            size_ok    = streaks["id_size_ok"].update(rep.get("id_size_ok"))
            face_ok    = streaks["face_on_id"].update(rep.get("face_on_id"))
            ocr_ok     = streaks["ocr_ok"].update(rep.get("ocr_ok"))

            payload = {
                "req_id": req_id,
                "analyzed_seq": int(seq_in),   # ← echo the sequence we analyzed

                # frame geometry
                "frame_w": int(W),
                "frame_h": int(H),

                # FE overlay geometry (backend pixels)
                "rect": rep.get("rect"),
                "roi_xyxy": rep.get("roi_xyxy"),

                # detections + metrics (debounced booleans)
                "id_card_detected": bool(id_card_ok),
                "id_card_bbox": rep.get("id_card_bbox"),
                "id_card_conf": rep.get("id_card_conf"),

                "id_overlap_ok": bool(overlap_ok),
                "id_frac_in": rep.get("id_frac_in"),
                "id_size_ok": bool(size_ok),
                "id_size_ratio": rep.get("id_size_ratio"),
                "id_ar": rep.get("id_ar"),

                "face_on_id": bool(face_ok),
                "largest_bbox": rep.get("largest_bbox"),

                "ocr_ok": bool(ocr_ok),
                "ocr_inside_ratio": rep.get("ocr_inside_ratio"),
                "ocr_hits": rep.get("ocr_hits"),
                "ocr_mean_conf": rep.get("ocr_mean_conf"),

                # Combined verdict (not debounced)
                "verified": bool(rep.get("verified")),

                "skipped": False,
                "saved": False,
            }

            # --- Throttle normally, but always push immediately on the first verified edge ---
            first_verified_edge = (payload["verified"] is True and last_verified is False)
            if (frame_idx % 5 != 0) and (last_payload is not None) and (not first_verified_edge):
                # send a lightweight heartbeat with the last payload (update dims and seq)
                hb = dict(last_payload)
                hb["skipped"] = True
                hb["frame_w"] = int(W)
                hb["frame_h"] = int(H)
                hb["analyzed_seq"] = int(seq_in)
                await ws.send_json(_to_jsonable(hb))
                last_verified = bool(last_payload.get("verified")) if last_payload else False
                continue

            last_payload = payload
            last_verified = payload["verified"]
            await ws.send_json(_to_jsonable(payload))

    except WebSocketDisconnect:
        print(f"🔌 ID live verification ended for {req_id}")
        
# ------------------------------------------------------------------------------
# LIVE ID BACK WebSocket (brightness + ID detection only)
# ------------------------------------------------------------------------------
@app.websocket("/ws-id-back-live")
async def websocket_id_back_live(ws: WebSocket):
    await ws.accept()
    qs = parse_qs(urlparse(str(ws.url)).query)
    req_id = (qs.get("req_id", [None])[0]) or (qs.get("sid", [None])[0]) or uuid4().hex
    base = Path("temp") / req_id
    (base / "id_back").mkdir(parents=True, exist_ok=True)
    frame_idx = 0
    last_payload: Optional[dict] = None
    try:
        while True:
            data = await ws.receive_text()
            try:
                frame_bytes = base64.b64decode(data)
                np_arr = np.frombuffer(frame_bytes, np.uint8)
                frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                if frame is None:
                    continue
            except Exception:
                continue

            frame_idx += 1
            if frame_idx % 2 != 0 and last_payload is not None:
                payload = dict(last_payload)
                payload["skipped"] = True
                await ws.send_json(_to_jsonable(payload))
                continue

            rep = analyze_id_frame(frame)  # we’ll only forward the minimal fields
            payload = {
                "req_id": req_id,
                "brightness_status": rep.get("brightness_status"),
                "brightness_mean": rep.get("brightness_mean"),
                "id_card_detected": rep.get("id_card_detected"),
                "id_card_bbox": rep.get("id_card_bbox"),
                "id_card_conf": rep.get("id_card_conf"),
                "skipped": False,
            }
            last_payload = payload
            await ws.send_json(_to_jsonable(payload))
    except WebSocketDisconnect:
        print(f"🔌 ID BACK live verification ended for {req_id}")

# ------------------------------------------------------------------------------
# ID still upload (FRONT) — saves still and crops face for verification
# ------------------------------------------------------------------------------
@app.post("/upload-id-still")
async def upload_id_still(request: Request, image: UploadFile = File(...)):
    req_id = _req_id_from(request)
    paths = _base_paths(req_id)
    base, id_dir = paths["base"], paths["id_dir"]
    base.mkdir(parents=True, exist_ok=True)
    id_dir.mkdir(parents=True, exist_ok=True)

    id_raw = id_dir / "id_raw_upload.jpg"
    id_raw.write_bytes(await image.read())

    used_for_cropping = id_raw
    try:
        from id import enhance_id_image
        id_enhanced = id_dir / "id_enhanced.jpg"
        if enhance_id_image(str(id_raw), str(id_enhanced)):
            used_for_cropping = id_enhanced
    except Exception as e:
        print(f"⚠️ Enhancement failed ({e}). Using raw ROI upload.")

    cropped = id_dir / "cropped_id_face.jpg"
    try:
        run_id_extraction(str(used_for_cropping), str(cropped))
    except Exception as e:
        return JSONResponse({"ok": False, "req_id": req_id, "error": str(e)}, status_code=400)

    urls = _result_urls_for_req(req_id, request)
    return JSONResponse({
        "ok": True,
        "req_id": req_id,
        "used_id_path": urls["id_image_url"],
        "cropped_face": urls["cropped_face_url"],
        "state": _state_for_req(req_id),
    })

# ------------------------------------------------------------------------------
# ID BACK still upload — saves back image only (no face crop)
# ------------------------------------------------------------------------------
@app.post("/upload-id-back-still")
async def upload_id_back_still(request: Request, image: UploadFile = File(...)):
    req_id = _req_id_from(request)
    paths = _base_paths(req_id)
    base, id_back_dir = paths["base"], paths["id_back_dir"]
    base.mkdir(parents=True, exist_ok=True)
    id_back_dir.mkdir(parents=True, exist_ok=True)

    raw_path = id_back_dir / "id_back_raw_upload.jpg"
    raw_path.write_bytes(await image.read())

    # Optional enhancement (best-effort; ignore errors)
    enhanced_path = id_back_dir / "id_back_enhanced.jpg"
    try:
        from id import enhance_id_image
        if enhance_id_image(str(raw_path), str(enhanced_path)):
            pass
    except Exception as e:
        print(f"⚠️ Back-side enhancement failed ({e}). Using raw image.")

    urls = _result_urls_for_req(req_id, request)
    return JSONResponse({
        "ok": True,
        "req_id": req_id,
        "used_id_back_path": urls["id_back_image_url"],
        "state": _state_for_req(req_id),
    })

# ------------------------------------------------------------------------------
# LIVE FACE (video) WebSocket
# ------------------------------------------------------------------------------
@app.websocket("/ws-live-verification")
async def websocket_verification(ws: WebSocket):
    await ws.accept()
    ellipse_params: Optional[dict] = None
    try:
        while True:
            data = await ws.receive_text()
            try:
                ellipse_params = json.loads(data)
                continue
            except Exception:
                pass

            if not ellipse_params:
                continue

            try:
                frame_bytes = base64.b64decode(data)
                np_arr = np.frombuffer(frame_bytes, np.uint8)
                frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                if frame is None:
                    continue
            except Exception as e:
                print("⚠️ Frame decode error:", e)
                continue

            af = analyze_frame(frame, ellipse_params=ellipse_params)
            payload = {
                "checks": af.get("checks"),
                "brightness_status": af.get("brightness_status"),
                "face_detected": bool(af.get("face_detected")),
                "num_faces": int(af.get("num_faces") or 0),
                "one_face": bool(af.get("one_face")),
                "inside_ellipse": bool(af.get("inside_ellipse")),
                "front_facing": af.get("front_facing"),
                "front_guidance": af.get("front_guidance"),
                "glasses_detected": af.get("glasses_detected"),
                "spoof_is_real": af.get("spoof_is_real"),
                "spoof_status": af.get("spoof_status"),
                "largest_bbox": af.get("largest_bbox"),
                "skipped": False,
            }
            await ws.send_json(_to_jsonable(payload))
    except WebSocketDisconnect:
        print("🔌 Live verification ended")

# ------------------------------------------------------------------------------
# Upload live clip (8s) — normalize & kick off deepfake job
# ------------------------------------------------------------------------------
@app.post("/upload-live-clip")
async def upload_live_clip(request: Request, video: UploadFile = File(...)):
    req_id = _req_id_from(request)
    paths = _base_paths(req_id)
    base, rec_dir = paths["base"], paths["rec_dir"]
    base.mkdir(parents=True, exist_ok=True)
    rec_dir.mkdir(parents=True, exist_ok=True)

    # Save raw upload
    stamp = time.strftime("%Y%m%d-%H%M%S")
    ext = (Path(video.filename).suffix or ".webm").lower()
    raw_path = rec_dir / f"{stamp}_{uuid4().hex}{ext}"
    raw_path.write_bytes(await video.read())

    # Normalize to MP4 (upright) and publish canonical mp4
    try:
        mp4_path = convert_to_mp4(raw_path, rec_dir)
        canonical = base / "video.mp4"
        shutil.copyfile(mp4_path, canonical)
    except Exception as e:
        return JSONResponse({"ok": False, "req_id": req_id, "error": str(e)}, status_code=400)

    # start deepfake detection in background
    _ensure_deepfake_async(mp4_path, base)

    urls = _result_urls_for_req(req_id, request)
    return JSONResponse({
        "ok": True,
        "req_id": req_id,
        "saved_raw": str(raw_path),
        "saved_mp4": str(mp4_path),
        "canonical_mp4": urls["video_url"],
        "deepfake": _deepfake_state_for_req(base),
        "state": _state_for_req(req_id),
    })

# ------------------------------------------------------------------------------
# Verify: run selection + InsightFace — attach deepfake verdict if ready
# ------------------------------------------------------------------------------
@app.post("/verify-session")
async def verify_session(request: Request):
    req_id = _req_id_from(request)
    paths = _base_paths(req_id)
    base, id_dir, rec_dir, selected_dir = paths["base"], paths["id_dir"], paths["rec_dir"], paths["selected_dir"]

    id_face = id_dir / "cropped_id_face.jpg"
    if not id_face.exists():
        return JSONResponse({"ok": False, "req_id": req_id, "error": "cropped_id_face.jpg not found. Re-do ID step."}, status_code=400)

    canonical_mp4 = base / "video.mp4"
    if not (canonical_mp4.exists() and canonical_mp4.stat().st_size > 0):
        latest_vid = _latest_file(rec_dir)
        if not latest_vid:
            return JSONResponse({"ok": False, "req_id": req_id, "error": "No recorded video found."}, status_code=400)
        try:
            norm = convert_to_mp4(latest_vid, rec_dir)
            canonical_mp4 = _publish_canonical_mp4(norm, base)
        except Exception as e:
            return JSONResponse({"ok": False, "req_id": req_id, "error": str(e)}, status_code=400)

    selected_dir.mkdir(parents=True, exist_ok=True)
    try:
        run_full_frame_pipeline(str(canonical_mp4), str(selected_dir))
    except Exception as e:
        return JSONResponse({"ok": False, "req_id": req_id, "error": f"Frame pipeline failed: {e}"}, status_code=400)

    out_img = base / "best_match.png"
    try:
        result = run_verif(
            id_image_path=str(id_face),
            frames_dir=str(selected_dir),
            output_path=str(out_img),
        )
        if "error" in result:
            return JSONResponse({"ok": False, "req_id": req_id, "error": result["error"]}, status_code=400)
    except Exception as e:
        return JSONResponse({"ok": False, "req_id": req_id, "error": f"Verification failed: {e}"}, status_code=400)

    # Attach URLs
    urls = _result_urls_for_req(req_id, request)
    result.update({
        "video_url": urls["video_url"],
        "id_image_url": urls["id_image_url"],
        "id_back_image_url": urls["id_back_image_url"],
        "cropped_face_url": urls["cropped_face_url"],
        "selected_frames": urls["selected_frames"],
        "best_match_url": urls["best_match_url"],
    })

    # Attach deepfake status/verdict
    df_state = _deepfake_state_for_req(base)
    result["deepfake_detected"] = df_state.get("deepfake_detected")
    result["deepfake_status"] = df_state.get("status")

    try:
        (base / "result.json").write_text(json.dumps(result, indent=2))
    except Exception:
        pass

    return JSONResponse({
        "ok": True,
        "req_id": req_id,
        "result": result,
        "result_url": _abs_url(request, f"/result/{req_id}"),
        "state": _state_for_req(req_id),
    })

# ------------------------------------------------------------------------------
# Review bundle / Result image / Manual review
# ------------------------------------------------------------------------------
@app.get("/review/{req_id}")
async def get_review_bundle(req_id: str, request: Request):
    base = Path("temp") / req_id
    if not base.exists():
        raise HTTPException(status_code=404, detail="Request ID not found")
    urls = _result_urls_for_req(req_id, request)
    return JSONResponse({"ok": True, "req_id": req_id, **urls, "deepfake": _deepfake_state_for_req(base)})

@app.get("/result/{req_id}")
def get_result_image(req_id: str):
    base = Path("temp") / req_id
    img = base / "best_match.png"
    if not img.exists():
        raise HTTPException(404, "Result image not found")
    return FileResponse(str(img), media_type="image/png")

@app.post("/manual-review/{req_id}")
async def manual_review(req_id: str, payload: dict):
    decision = payload.get("decision")
    if decision not in ["verified", "unverified"]:
        raise HTTPException(status_code=400, detail="Invalid decision")

    base = Path("temp") / req_id
    if not base.exists():
        raise HTTPException(status_code=404, detail="Request ID not found")

    for item in base.iterdir():
        if item.is_dir():
            shutil.rmtree(item, ignore_errors=True)
        else:
            item.unlink()
    return JSONResponse(content={"message": f"✅ Manual review marked as '{decision}' and data cleaned up."})


id.py:
# id.py — EXACTLY mirrors the standalone new script:
# - Detect ONLY inside guide ROI (letterbox+pad)
# - Apply overlap (in), size (intersection/guide), min area, aspect ratio gates
# - Face-on-ID inside the intersection crop (letterbox+pad)
# - EasyOCR on the intersection crop; return txt_in, hits, mean_conf
# - Return all metrics needed for FE to display the same line as cv2 demo

from __future__ import annotations
from pathlib import Path
from typing import Dict, Optional, Tuple, List
import os, sys, re

import cv2
import numpy as np
import torch
from ultralytics import YOLO
from PIL import Image  # enhancement fallback
from rapidfuzz import fuzz
import easyocr

# ---- Optional GFPGAN import (unchanged) ----
ENHANCER_AVAILABLE = False
try:
    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "GFPGAN")))
    from gfpgan import GFPGANer  # type: ignore
    ENHANCER_AVAILABLE = True
except Exception as _e:
    print("⚠️ GFPGAN not available; will use OpenCV fallback for enhancement.", _e)

# -----------------------------------------------------------------------------
# Device & Models
# -----------------------------------------------------------------------------
def _select_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"

DEVICE: str = _select_device()
print(f"🖥️ Using device: {DEVICE.upper()}")

FACE_MODEL = YOLO("yolov8n-face-lindevs.pt")
ID_MODEL   = YOLO("iddetection.pt")

# -----------------------------------------------------------------------------
# Config — EXACT values from the new script
# -----------------------------------------------------------------------------
CONF, IOU, MAX_DETS = 0.50, 0.45, 3
FACE_CONF = 0.50

EXPECTED_AR: float      = float(os.getenv("ID_EXPECTED_AR", "1.586"))
AR_TOL: float           = float(os.getenv("ID_AR_TOL", "0.18"))
MIN_AREA_FRAC: float    = float(os.getenv("ID_MIN_AREA_FRAC", "0.02"))

OVERLAP_MIN: float           = float(os.getenv("ID_OVERLAP_MIN", "0.60"))
OCR_BOX_KEEP_PCT: float      = float(os.getenv("ID_OCR_KEEP_PCT", "0.90"))
MIN_GUIDE_COVER_FRAC: float  = float(os.getenv("ID_MIN_GUIDE_COVER", "0.30"))

OCR_REQUIRED_HITS: int  = int(os.getenv("ID_OCR_HITS", "2"))
OCR_MIN_CONF: float     = float(os.getenv("ID_OCR_MIN_CONF", "0.55"))
FUZZY: int              = int(os.getenv("ID_OCR_FUZZY", "75"))

KW = [
  "identidad","identificación","cédula","ciudadanía","república","colombia","nacional",
  "autoridad","expedición","vencimiento","sexo","nombre","apellidos","nuip",
  "identity","identification","id card","national","authority","republic","government","passport"
]
RGX = [
  r"\b\d{6,}\b",
  r"\b(19|20)\d{2}[./\- ]\d{1,2}[./\- ]\d{1,2}\b",
  r"\b\d{1,2}\s*(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*(19|20)\d{2}\b",
  r"\b(NUIP|N\.U\.I\.P\.?)\b",
  r"\b\d{1,3}\.\d{3}\.\d{3}\.\d{1,4}\b"
]

ID_IMG_SIZE: int = 640
LB_COLOR = (114,114,114)

# Guide rectangle for FE (match your old overlay ratios;
# FE now renders the backend-provided rect exactly)
RECT_W_RATIO: float = 0.95
RECT_H_RATIO: float = 0.45

# EasyOCR (GPU only for CUDA; MPS uses CPU automatically)
_EASYOCR_USE_GPU = bool(torch.cuda.is_available())
reader = easyocr.Reader(['es','en'], gpu=_EASYOCR_USE_GPU)

# -----------------------------------------------------------------------------
# Helpers — exact building blocks
# -----------------------------------------------------------------------------
def _center_rect_for_image(w: int, h: int, w_ratio: float = RECT_W_RATIO, h_ratio: float = RECT_H_RATIO):
    rw = w * float(w_ratio); rh = h * float(h_ratio)
    return (w - rw) / 2.0, (h - rh) / 2.0, rw, rh  # x,y,w,h (float)

def _letterbox_square(img: np.ndarray, size: int = 640, color=(114,114,114)):
    h, w = img.shape[:2]
    r = min(size / w, size / h)
    new_w, new_h = int(round(w * r)), int(round(h * r))
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    dw, dh = size - new_w, size - new_h
    left, right = dw // 2, dw - dw // 2
    top,  bottom = dh // 2, dh - dh // 2
    out = cv2.copyMakeBorder(resized, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color)
    return out, r, (left, top)

def _map_box_back(xyxy, r, pad, orig_w, orig_h):
    left, top = pad
    x1, y1, x2, y2 = xyxy
    x1 = (x1 - left) / r; y1 = (y1 - top) / r
    x2 = (x2 - left) / r; y2 = (y2 - top) / r
    x1 = max(0, min(orig_w - 1, x1)); y1 = max(0, min(orig_h - 1, y1))
    x2 = max(0, min(orig_w - 1, x2)); y2 = max(0, min(orig_h - 1, y2))
    return float(x1), float(y1), float(x2), float(y2)

def _rect_intersect(a_xyxy, b_xyxy):
    ax1, ay1, ax2, ay2 = a_xyxy; bx1, by1, bx2, by2 = b_xyxy
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return None, 0.0, 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    aarea = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    return (ix1, iy1, ix2, iy2), float(inter) / (aarea + 1e-6), float(inter)

def _aspect_ok(w: float, h: float, exp: float = EXPECTED_AR, tol: float = AR_TOL):
    if w <= 0 or h <= 0: return False, 0.0
    ar = w / float(h)
    return (exp*(1-tol) <= ar <= exp*(1+tol)), ar

def _area_frac_ok(x1: float, y1: float, x2: float, y2: float, W: int, H: int, minf: float = MIN_AREA_FRAC):
    return ((x2 - x1) * (y2 - y1)) / (W * H + 1e-6) >= minf

def _detect_id_card_in_roi(frame_bgr: np.ndarray, guide_xyxy: Tuple[int,int,int,int]):
    """Detect ONLY inside the guide ROI (exactly like the new script)."""
    gx1, gy1, gx2, gy2 = guide_xyxy
    roi = frame_bgr[gy1:gy2, gx1:gx2]
    if roi.size == 0:
        return False, None, None
    H_roi, W_roi = roi.shape[:2]
    lb, r, pad = _letterbox_square(roi, size=ID_IMG_SIZE, color=LB_COLOR)
    det = ID_MODEL.predict(source=[lb], imgsz=ID_IMG_SIZE, conf=CONF, iou=IOU,
                           max_det=MAX_DETS, device=DEVICE, verbose=False)[0]
    best = None
    if det and det.boxes is not None and len(det.boxes) > 0:
        # best confidence for the "card" class (index 0 in your weights)
        for b in det.boxes:
            cls = int(b.cls[0]); conf = float(b.conf[0])
            if cls != 0:  # ID card class index
                continue
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            rx1, ry1, rx2, ry2 = _map_box_back((x1, y1, x2, y2), r, pad, W_roi, H_roi)
            fx1, fy1, fx2, fy2 = gx1 + rx1, gy1 + ry1, gx1 + rx2, gy1 + ry2
            if best is None or conf > best[1]:
                best = ((fx1, fy1, fx2, fy2), conf)
    if best is None:
        return False, None, None
    return True, best[0], best[1]

def _detect_face_in_id_crop(id_crop_bgr: np.ndarray, imgsz: int = 320):
    lb, r, pad = _letterbox_square(id_crop_bgr, size=imgsz, color=LB_COLOR)
    det = FACE_MODEL.predict(source=[lb], imgsz=imgsz, conf=FACE_CONF, iou=0.45,
                             max_det=3, device=DEVICE, verbose=False)[0]
    if not det or det.boxes is None or len(det.boxes) == 0:
        return False, None
    (Hc, Wc) = id_crop_bgr.shape[:2]
    crop_area = float(Hc * Wc) + 1e-6
    # highest-conf face with ≥2% area
    candidates = sorted(det.boxes,
                        key=lambda bb: float(bb.conf[0]) if getattr(bb, "conf", None) is not None else 1.0,
                        reverse=True)
    for b in candidates:
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        fx1, fy1, fx2, fy2 = _map_box_back((x1, y1, x2, y2), r, pad, Wc, Hc)
        if ((fx2 - fx1) * (fy2 - fy1) / crop_area) >= 0.02:
            return True, (int(fx1), int(fy1), int(fx2), int(fy2))
    return False, None

def _ocr_verify_crop_inside(crop_bgr: np.ndarray, ix1: int, iy1: int, guide_xyxy):
    res = reader.readtext(crop_bgr, detail=1, paragraph=False)
    if not res:
        return False, 0.0, 0, "", 0.0
    texts, confs, inside = [], [], []
    gx1, gy1, gx2, gy2 = guide_xyxy
    for (pts, txt, conf) in res:
        if not txt:
            continue
        cx = sum(p[0] for p in pts) / 4.0 + ix1
        cy = sum(p[1] for p in pts) / 4.0 + iy1
        inside.append(gx1 <= cx <= gx2 and gy1 <= cy <= gy2)
        texts.append(txt); confs.append(float(conf))
    if not texts:
        return False, 0.0, 0, "", 0.0

    inside_ratio = (sum(inside) / max(1, len(inside)))
    if inside_ratio < OCR_BOX_KEEP_PCT:
        return False, float(np.mean(confs)), 0, " ".join(texts).lower(), inside_ratio

    joined = " ".join(texts).lower()
    hits = 0
    for kw in KW:
        if fuzz.partial_ratio(kw, joined) >= FUZZY:
            hits += 1
    for rx in RGX:
        if re.search(rx, joined):
            hits += 1
    mean_conf = float(np.mean(confs))
    ok = (hits >= OCR_REQUIRED_HITS) and (mean_conf >= OCR_MIN_CONF)
    return ok, mean_conf, hits, joined, inside_ratio

# -----------------------------------------------------------------------------
# Public API (EXACT pipeline + full metrics)
# -----------------------------------------------------------------------------
def analyze_id_frame(
    image_bgr: np.ndarray,
    rect_w_ratio: float = RECT_W_RATIO,
    rect_h_ratio: float = RECT_H_RATIO,
) -> Dict[str, Optional[object]]:
    """
    EXACT pipeline (match the standalone demo):
      - detect ID ONLY inside guide
      - overlap ≥ 0.60, size (intersection/guide) ≥ 0.30
      - min area ≥ 0.02 of full frame, aspect in [EXPECTED_AR ± AR_TOL]
      - detect a face on the ID (inside intersection crop)
      - OCR on crop; require txt_in ≥ 0.90 (implicit) + (hits ≥ 2) + mean_conf ≥ 0.55
    Returns all numeric metrics used by the cv2 overlay line.
    """
    H, W = image_bgr.shape[:2]
    out: Dict[str, Optional[object]] = {
        "rect": None, "roi_xyxy": None,
        "id_card_detected": False, "id_card_bbox": None, "id_card_conf": None,
        "id_frac_in": None, "id_overlap_ok": None,
        "id_size_ratio": None, "id_size_ok": None,
        "id_ar": None,
        "face_on_id": False, "largest_bbox": None,
        "ocr_ok": None, "ocr_inside_ratio": None, "ocr_hits": None, "ocr_mean_conf": None,
        "verified": False,
    }

    # Guide rect (send exact pixels for FE)
    rx, ry, rw, rh = _center_rect_for_image(W, H, rect_w_ratio, rect_h_ratio)
    gx1, gy1 = int(rx), int(ry)
    gx2, gy2 = int(rx + rw), int(ry + rh)
    guide_xyxy = (gx1, gy1, gx2, gy2)
    out["rect"] = [float(rx), float(ry), float(rw), float(rh)]
    out["roi_xyxy"] = [gx1, gy1, gx2, gy2]

    # (1) Detect ID ONLY inside guide
    id_ok, id_bbox, id_conf = _detect_id_card_in_roi(image_bgr, guide_xyxy)
    out["id_card_detected"] = bool(id_ok)
    out["id_card_bbox"] = list(id_bbox) if id_bbox else None
    out["id_card_conf"] = float(id_conf) if id_conf is not None else None
    if not id_ok:
        return out

    # Geometry
    x1, y1, x2, y2 = id_bbox
    ar_ok, ar = _aspect_ok(x2 - x1, y2 - y1)
    out["id_ar"] = float(ar)

    # (2) Overlap with guide
    inter, frac_in, inter_area = _rect_intersect(id_bbox, guide_xyxy)
    out["id_frac_in"] = float(frac_in)
    if inter is None or frac_in < OVERLAP_MIN:
        out["id_overlap_ok"] = False
        return out
    out["id_overlap_ok"] = True

    # (3) Size vs guide
    guide_area = float((gx2 - gx1) * (gy2 - gy1)) + 1e-6
    size_ratio = inter_area / guide_area
    out["id_size_ratio"] = float(size_ratio)
    out["id_size_ok"] = bool(size_ratio >= MIN_GUIDE_COVER_FRAC)
    if not out["id_size_ok"]:
        return out

    # (4) Minimum area fraction (vs full frame) + aspect ratio gate
    if not _area_frac_ok(x1, y1, x2, y2, W, H):
        return out
    if not ar_ok:
        return out

    # Intersection crop
    ix1, iy1, ix2, iy2 = map(int, inter)
    id_crop = image_bgr[iy1:iy2, ix1:ix2]

    # (5) Face-on-ID inside the crop
    f_ok, f_box = _detect_face_in_id_crop(id_crop, imgsz=320)
    out["face_on_id"] = bool(f_ok)
    if f_ok and f_box is not None:
        fx1, fy1, fx2, fy2 = f_box
        out["largest_bbox"] = [ix1 + fx1, iy1 + fy1, ix1 + fx2, iy1 + fy2]

    # (6) OCR on crop (always compute here like the demo)
    ocr_ok, mean_conf, hits, _joined, inside_ratio = _ocr_verify_crop_inside(id_crop, ix1, iy1, guide_xyxy)
    out["ocr_ok"] = bool(ocr_ok)
    out["ocr_inside_ratio"] = float(inside_ratio)
    out["ocr_hits"] = int(hits)
    out["ocr_mean_conf"] = float(mean_conf)

    # Final verdict: must satisfy overlap+size+face+OCR (exact)
    out["verified"] = bool(out["id_overlap_ok"] and out["id_size_ok"] and out["face_on_id"] and out["ocr_ok"])
    return out

# -----------------------------------------------------------------------------
# Enhancement & face-crop-on-still (unchanged)
# -----------------------------------------------------------------------------
def enhance_id_image(input_path: str, output_path: str) -> bool:
    if ENHANCER_AVAILABLE:
        model_path = "GFPGAN/experiments/pretrained_models/GFPGANv1.3.pth"
        try:
            restorer = GFPGANer(
                model_path=model_path, upscale=2, arch="clean",
                channel_multiplier=2, bg_upsampler=None
            )
            img = Image.open(input_path).convert("RGB")
            img_np = np.array(img)
            _, _, restored = restorer.enhance(
                img_np, has_aligned=False, only_center_face=True, paste_back=True
            )
            Image.fromarray(restored).save(output_path)
            print(f"✅ Enhanced (GFPGAN) saved to {output_path}")
            return True
        except Exception as e:
            print(f"⚠️ GFPGAN failed ({e}); using OpenCV fallback.")

    img_bgr = cv2.imread(input_path)
    if img_bgr is None:
        raise FileNotFoundError(f"ID image not found: {input_path}")

    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    L, A, B = cv2.split(lab)
    L2 = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(L)
    img2 = cv2.cvtColor(cv2.merge([L2, A, B]), cv2.COLOR_LAB2BGR)
    blur = cv2.GaussianBlur(img2, (0, 0), 1.0)
    sharpen = cv2.addWeighted(img2, 1.5, blur, -0.5, 0)
    cv2.imwrite(output_path, sharpen)
    print(f"✅ Enhanced (OpenCV) saved to {output_path}")
    return True

def run_id_extraction(input_path: str, output_path: str) -> None:
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    image = cv2.imread(input_path)
    if image is None:
        raise FileNotFoundError(f"ID image not found at path: {input_path}")

    # detect faces on the full upload and choose the largest (letterbox mapping)
    lb, r, pad = _letterbox_square(image, size=320, color=LB_COLOR)
    det = FACE_MODEL.predict(source=[lb], imgsz=320, conf=FACE_CONF,
                             device=DEVICE, verbose=False)[0]
    if not det or det.boxes is None or len(det.boxes) == 0:
        raise Exception("❌ No face detected in ID image.")

    best = None; best_area = -1.0
    for b in det.boxes:
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        bx = _map_box_back((x1, y1, x2, y2), r, pad, image.shape[1], image.shape[0])
        area = max(0.0, (bx[2]-bx[0])) * max(0.0, (bx[3]-bx[1]))
        if area > best_area:
            best_area = area; best = bx

    x1_f, y1_f, x2_f, y2_f = map(int, best)
    CROP_PAD_X, CROP_PAD_Y = 0.20, 0.20
    h, w = image.shape[:2]
    pad_x = int((x2_f - x1_f) * CROP_PAD_X)
    pad_y = int((y2_f - y1_f) * CROP_PAD_Y)
    x1 = max(x1_f - pad_x, 0)
    y1 = max(y1_f - pad_y, 0)
    x2 = min(x2_f + pad_x, w - 1)
    y2 = min(y2_f + pad_y, h - 1)

    cropped_face = image[y1:y2, x1:x2]
    cv2.imwrite(str(out_path), cropped_face)
    print(f"✅ Cropped face saved to {output_path}")

__all__ = [
    "analyze_id_frame",
    "run_id_extraction",
    "enhance_id_image",
]

all_video.py:
all_video.py:
# -------------------------------------------------
# Video analysis utilities
# -------------------------------------------------

import os
import sys
import subprocess
import shutil
from pathlib import Path

import cv2
import numpy as np
import torch
from ultralytics import YOLO

# ▼ NEW: MediaPipe for front-facing check
import mediapipe as mp
mp_face_mesh = mp.solutions.face_mesh
# persistent instance (same params as your script)
_FACE_MESH = mp_face_mesh.FaceMesh(
    refine_landmarks=True,
    min_detection_confidence=0.6,
    min_tracking_confidence=0.6
)

# ---- Feature flags (toggle checks) ----
CHECKS = {
    "face":       bool(int(os.getenv("CHECK_FACE", "1"))),
    "ellipse":    bool(int(os.getenv("CHECK_ELLIPSE", "1"))),
    "brightness": bool(int(os.getenv("CHECK_BRIGHTNESS", "1"))),
    # ▼ NEW: front-facing gate (enabled by default)
    "frontal":    bool(int(os.getenv("CHECK_FRONTAL", "1"))),
    "spoof":      bool(int(os.getenv("CHECK_SPOOF", "1"))),
    "glasses":    bool(int(os.getenv("CHECK_GLASSES", "1"))),
}

def get_checks() -> dict:
    return CHECKS.copy()

# ---- Anti-spoofing repo wiring (used only in LIVE analyze_frame) ----
sys.path.append(str(Path(__file__).resolve().parent / "Silent_Face_Anti_Spoofing"))
from src.anti_spoof_predict import AntiSpoofPredict
from src.generate_patches import CropImage
from src.utility import parse_model_name

# ---- Environment paths for anti-spoofing ----
DETECTION_MODEL_PATH = Path(__file__).resolve().parent / "Silent_Face_Anti_Spoofing" / "resources" / "detection_model"
os.environ["DETECTION_MODEL_PATH"] = str(DETECTION_MODEL_PATH)
SPOOF_MODEL_DIR = str(Path(__file__).resolve().parent / "Silent_Face_Anti_Spoofing" / "resources" / "anti_spoof_models")

# ---- Auto device selection ----
DEVICE = "cuda:0" if torch.cuda.is_available() else "cpu"
print(f"🖥️ onlanders.video using device: {DEVICE}")

# ---- Models (loaded once; used by LIVE path) ----
FACE_MODEL = YOLO("yolov8n-face-lindevs.pt").to(DEVICE)

# REPLACED: detection model -> classification model
# Expect names: {0:'with_glasses', 1:'without_glasses'}
GLASSES_CLS_MODEL = YOLO("glass-classification.pt").to(DEVICE)
GLASSES_NAMES = GLASSES_CLS_MODEL.names or {0: "with_glasses", 1: "without_glasses"}
WITH_ID = next((k for k, v in GLASSES_NAMES.items() if v == "with_glasses"), 0)
WITHOUT_ID = next((k for k, v in GLASSES_NAMES.items() if v == "without_glasses"), 1)
GLASSES_CONF_THRESH = float(os.getenv("GLASSES_CONF", "0.60"))

spoof_model = AntiSpoofPredict(0)
image_cropper = CropImage()

# ---- Offline pipeline config ----
NUM_FRAMES_TO_SELECT = 15

# ---- Letterbox / mapping helpers (to avoid aspect distortion) ----
LB_COLOR = (114, 114, 114)
DET_IMG_SIZE = 640
CLS_IMG_SIZE = 224

def _letterbox_square(img: np.ndarray, size: int = 640, color=(114,114,114)):
    h, w = img.shape[:2]
    r = min(size / w, size / h)
    new_w, new_h = int(round(w * r)), int(round(h * r))
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    dw, dh = size - new_w, size - new_h
    left, right = dw // 2, dw - dw // 2
    top, bottom = dh // 2, dh - dh // 2
    out = cv2.copyMakeBorder(resized, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color)
    return out, r, (left, top)

def _map_box_back(xyxy, r, pad, orig_w, orig_h):
    left, top = pad
    x1, y1, x2, y2 = map(float, xyxy)
    x1 = (x1 - left) / r; y1 = (y1 - top) / r
    x2 = (x2 - left) / r; y2 = (y2 - top) / r
    x1 = max(0, min(orig_w - 1, x1)); y1 = max(0, min(orig_h - 1, y1))
    x2 = max(0, min(orig_w - 1, x2)); y2 = max(0, min(orig_h - 1, y2))
    return float(x1), float(y1), float(x2), float(y2)

def _pad_to_square(img: np.ndarray, pad_value=114):
    h, w = img.shape[:2]
    if h == w:
        return img
    if h > w:
        d = h - w; l = d // 2; r = d - l
        return cv2.copyMakeBorder(img, 0, 0, l, r, cv2.BORDER_CONSTANT, value=(pad_value,)*3)
    else:
        d = w - h; t = d // 2; b = d - t
        return cv2.copyMakeBorder(img, t, b, 0, 0, cv2.BORDER_CONSTANT, value=(pad_value,)*3)

# -------------------------------------------------
# Utility: normalize to mp4 (h264/aac) with validation
# -------------------------------------------------
def convert_to_mp4(input_path: str | Path, output_dir: str | Path) -> Path:
    input_path = Path(input_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    out = output_dir / (input_path.stem + ".mp4")

    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH")

    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", str(input_path),
         "-c:v", "libx264", "-preset", "ultrafast",
         "-c:a", "aac", str(out)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
        try:
            if out.exists():
                out.unlink()
        except Exception:
            pass
        raise RuntimeError(f"ffmpeg conversion failed for {input_path.name}: {proc.stderr[:800] if proc.stderr else 'no stderr'}")

    return out


# -------------------------------------------------
# NEW: Face direction (exactly your script)
# -------------------------------------------------
def _lm_to_xy(lm, w, h):
    return {"x": lm.x * w, "y": lm.y * h}

def _check_face_direction(face_landmarks, w, h):
    left_eye  = _lm_to_xy(face_landmarks.landmark[33], w, h)
    right_eye = _lm_to_xy(face_landmarks.landmark[263], w, h)
    nose      = _lm_to_xy(face_landmarks.landmark[1], w, h)

    eye_dist = np.linalg.norm(
        np.array([right_eye["x"], right_eye["y"]]) -
        np.array([left_eye["x"],  left_eye["y"]])
    )

    eye_mid_y = (left_eye["y"] + right_eye["y"]) / 2
    adjusted_eye_mid_y = eye_mid_y + eye_dist * 0.3

    nose_midpoint_dist = nose["x"] - (left_eye["x"] + right_eye["x"]) / 2
    vertical_nose_dist = nose["y"] - adjusted_eye_mid_y

    horiz_tol = eye_dist * 0.15
    vert_tol  = eye_dist * 0.2

    guidance = None
    if abs(nose_midpoint_dist) > horiz_tol:
        guidance = "Move LEFT" if nose_midpoint_dist > 0 else "Move RIGHT"
    elif abs(vertical_nose_dist) > vert_tol:
        guidance = "Move UP" if vertical_nose_dist > 0 else "Move DOWN"

    return guidance


# -------------------------------------------------
# LIVE path: per-frame checks for UX gating
# -------------------------------------------------
def analyze_frame(frame, ellipse_params=None) -> dict:
    """
    Returns a dict consumed by the FE. Order:
      1) face detection
      2) inside ellipse
      3) brightness
      4) NEW: front-facing via MediaPipe (before spoof/glasses)
      5) spoof
      6) glasses
    """
    result = {
        "checks": get_checks(),
        "face_detected": False,
        "num_faces": 0,
        "one_face": True,
        "largest_bbox": None,
        "inside_ellipse": False,
        "brightness_status": None,

        # ▼ NEW fields
        "front_facing": None,       # True/False after MediaPipe check
        "front_guidance": None,     # "Move LEFT/RIGHT/UP/DOWN" or "No face detected"

        "glasses_detected": None,
        "glasses_top1": None,
        "glasses_conf": None,
        "spoof_is_real": None,
        "spoof_status": None,
    }

    H, W = frame.shape[:2]

    # 1) Face detection (letterboxed, then map back)
    if CHECKS["face"]:
        lb_img, r, pad = _letterbox_square(frame, size=DET_IMG_SIZE, color=LB_COLOR)
        det = FACE_MODEL.predict(source=[lb_img], imgsz=DET_IMG_SIZE, device=DEVICE, verbose=False)[0]
        if not det or det.boxes is None or len(det.boxes) == 0:
            return result

        boxes_lb = det.boxes.xyxy.detach().cpu().numpy()
        areas = (boxes_lb[:, 2] - boxes_lb[:, 0]) * (boxes_lb[:, 3] - boxes_lb[:, 1])
        bx_lb = boxes_lb[areas.argmax()]
        x1, y1, x2, y2 = _map_box_back(bx_lb.tolist(), r, pad, W, H)

        result["face_detected"] = True
        result["num_faces"] = len(boxes_lb)
        result["one_face"] = (len(boxes_lb) == 1)
        result["largest_bbox"] = [float(x1), float(y1), float(x2), float(y2)]
    else:
        result["face_detected"] = True
        result["num_faces"] = 1
        result["one_face"] = True

    # 2) Inside ellipse
    if CHECKS["ellipse"]:
        if ellipse_params is None or result["largest_bbox"] is None:
            return result
        ex = float(ellipse_params["ellipseCx"])
        ey = float(ellipse_params["ellipseCy"])
        rx = float(ellipse_params["ellipseRx"])
        ry = float(ellipse_params["ellipseRy"])

        x1, y1, x2, y2 = result["largest_bbox"]
        w, h = (x2 - x1), (y2 - y1)
        x1_t = x1 + w * 0.12; x2_t = x2 - w * 0.12
        y1_t = y1;           y2_t = y2

        def inside(px, py):
            nx = (px - ex) / max(1e-6, rx)
            ny = (py - ey) / max(1e-6, ry)
            return (nx * nx + ny * ny) <= 1.0

        corners = [(x1_t, y1_t), (x2_t, y1_t), (x1_t, y2_t), (x2_t, y2_t)]
        result["inside_ellipse"] = all(inside(px, py) for px, py in corners)
        if not result["inside_ellipse"]:
            return result
    else:
        result["inside_ellipse"] = True

    # 3) Brightness
    if CHECKS["brightness"]:
        mean_b = float(np.mean(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)))
        if mean_b < 50:
            result["brightness_status"] = "too_dark"; return result
        if mean_b > 200:
            result["brightness_status"] = "too_bright"; return result
        result["brightness_status"] = "ok"
    else:
        result["brightness_status"] = "ok"

    # 4) NEW: Front-facing (MediaPipe), exact logic from your script
    if CHECKS["frontal"]:
        try:
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_res = _FACE_MESH.process(rgb_frame)
            if mp_res.multi_face_landmarks:
                # take first face landmarks
                face_landmarks = mp_res.multi_face_landmarks[0]
                guidance = _check_face_direction(face_landmarks, W, H)
                result["front_guidance"] = guidance
                result["front_facing"] = (guidance is None)
                if not result["front_facing"]:
                    # gate here (before spoof/glasses)
                    return result
            else:
                result["front_facing"] = False
                result["front_guidance"] = "No face detected"
                return result
        except Exception as e:
            # if MediaPipe errors, leave fields None and continue (non-fatal)
            print("⚠️ Front-facing check error:", e)

    # 5) Anti-spoof
    if CHECKS["spoof"]:
        try:
            image_bbox = spoof_model.get_bbox(frame)
            prediction = np.zeros((1, 3))
            for model_name in os.listdir(SPOOF_MODEL_DIR):
                h_in, w_in, model_type, scale = parse_model_name(model_name)
                param = {
                    "org_img": frame, "bbox": image_bbox, "scale": scale,
                    "out_w": w_in, "out_h": h_in, "crop": scale is not None,
                }
                img = image_cropper.crop(**param)
                prediction += spoof_model.predict(img, os.path.join(SPOOF_MODEL_DIR, model_name))
            label = int(np.argmax(prediction))  # 0=spoof, 1=real
            result["spoof_is_real"] = (label == 1)
            result["spoof_status"] = "ok"
        except Exception as e:
            print("⚠️ Spoof error:", e)
            result["spoof_is_real"] = None
            result["spoof_status"] = "error"
    else:
        result["spoof_is_real"] = None
        result["spoof_status"] = "disabled"

    # 6) Glasses classification
    if CHECKS["glasses"]:
        try:
            if result["largest_bbox"] is not None:
                fx1, fy1, fx2, fy2 = map(int, result["largest_bbox"])
                fx1 = max(0, min(W - 1, fx1)); fy1 = max(0, min(H - 1, fy1))
                fx2 = max(0, min(W - 1, fx2)); fy2 = max(0, min(H - 1, fy2))
                if fx2 > fx1 and fy2 > fy1:
                    face_roi = frame[fy1:fy2, fx1:fx2]
                    if face_roi.size > 0:
                        face_sq = _pad_to_square(face_roi, LB_COLOR[0])
                        face_224 = cv2.resize(face_sq, (CLS_IMG_SIZE, CLS_IMG_SIZE), interpolation=cv2.INTER_AREA)
                        cls_res = GLASSES_CLS_MODEL.predict(
                            source=face_224[:, :, ::-1],
                            imgsz=CLS_IMG_SIZE, device=DEVICE, verbose=False
                        )[0]
                        cls_id = int(cls_res.probs.top1)
                        conf = float(cls_res.probs.top1conf)
                        top1_name = GLASSES_NAMES.get(cls_id, str(cls_id))

                        has_glasses = (cls_id == WITH_ID) and (conf >= GLASSES_CONF_THRESH)
                        result["glasses_detected"] = bool(has_glasses)
                        result["glasses_top1"] = top1_name
                        result["glasses_conf"] = round(conf, 4)
                    else:
                        result["glasses_detected"] = None
                else:
                    result["glasses_detected"] = None
            else:
                result["glasses_detected"] = None
        except Exception as e:
            print("⚠️ Glasses classification error:", e)
            result["glasses_detected"] = None
    else:
        result["glasses_detected"] = False

    return result


# -------------------------------------------------
# OFFLINE pipeline: uniformly sample frames only
# -------------------------------------------------
def run_full_frame_pipeline(video_path: str, output_dir: str):
    video_path = Path(video_path)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Clean previous outputs
    for f in out_dir.iterdir():
        try:
            f.unlink()
        except Exception:
            pass

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"❌ Cannot open video: {video_path}")

    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    duration = frame_count / fps if fps > 0 else 0.0
    print(f"🎞 FPS: {fps} | frames: {frame_count} | duration(s): {duration:.2f}")
    if frame_count <= 0:
        cap.release()
        raise ValueError("❌ Video has zero frames.")

    n = min(NUM_FRAMES_TO_SELECT, frame_count)
    indices = sorted(set(np.linspace(0, frame_count - 1, n, dtype=int)))

    saved = 0
    target_set = set(indices)
    cur_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if cur_idx in target_set:
            out_path = out_dir / f"frame_{saved + 1}.png"
            cv2.imwrite(str(out_path), frame)
            saved += 1
            if saved >= n:
                break

        cur_idx += 1

    cap.release()
    cv2.destroyAllWindows()

    if saved == 0:
        raise ValueError("❌ Failed to sample frames from video.")

    print(f"✅ Saved {saved} uniformly spaced frames to: {out_dir}")