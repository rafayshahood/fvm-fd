// resultpage.js
import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE } from './api';

const abs = (u) => (u ? (u.startsWith('http') ? u : `${API_BASE}${u}`) : null);

function ResultPage() {
  const { reqId: reqIdFromRoute } = useParams();
  const navigate = useNavigate();

  const effectiveReqId =
    reqIdFromRoute ||
    (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('req_id')) ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('req_id')) ||
    '';

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMsg, setLoadingMsg] = useState('Verifying… Please wait');

  const [decision, setDecision] = useState(null);
  const [backendMessage, setBackendMessage] = useState(null);

  const [idImgSrc, setIdImgSrc] = useState(null);
  const [videoSrc, setVideoSrc] = useState(null);
  const [showVideo, setShowVideo] = useState(true);

  const [deepfake, setDeepfake] = useState(null);
  const [deepfakePolling, setDeepfakePolling] = useState(false);

  const pct = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 10 : x);
  const stopPollingRef = useRef(false);

  const applyAssetUrls = (bundle) => {
    if (!bundle) return;
    const idUrl = abs(bundle.id_image_url) || abs(bundle.cropped_face_url) || null;
    const vidUrl = abs(bundle.video_url) || null;
    setIdImgSrc(idUrl);
    setVideoSrc(vidUrl);
  };

  useEffect(() => {
    if (!effectiveReqId) {
      setError('Missing request id. Please run verification again.');
      return;
    }
    stopPollingRef.current = false;

    const poll = async () => {
      const url = `${API_BASE}/temp/${effectiveReqId}/result.json`;

      let tries = 0;
      const maxTries = 90;
      while (!stopPollingRef.current && tries < maxTries) {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          if (res.ok) {
            const data = await res.json();
            setResult(data);
            setError(null);
            applyAssetUrls({
              id_image_url: data?.id_image_url,
              cropped_face_url: data?.cropped_face_url,
              video_url: data?.video_url,
            });
            const df = {
              status: data?.deepfake_status,
              detected: data?.deepfake_detected,
              is_real: data?.deepfake_is_real,
            };
            if (df.status || typeof df.detected === 'boolean' || typeof df.is_real === 'boolean') {
              setDeepfake(df);
            }
            return;
          }
          setError(null);
        } catch (_) {
          setError(null);
        }
        tries += 1;
        if (tries % 10 === 0) setLoadingMsg('Still verifying… almost there');
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!stopPollingRef.current) {
        setError('Timed out waiting for result. Please try again.');
      }
    };

    poll();
    return () => { stopPollingRef.current = true; };
  }, [effectiveReqId]);

  useEffect(() => {
    if (!effectiveReqId) return;

    const alreadyHaveFinal =
      deepfake && (
        deepfake.completed === true ||
        typeof deepfake.is_deepfake === 'boolean' ||
        typeof deepfake.is_real === 'boolean'
      );

    const shouldStart =
      result && !alreadyHaveFinal &&
      (result.deepfake_status === 'running' || result.deepfake_detected == null);

    if (!shouldStart || deepfakePolling) return;

    let cancelled = false;
    setDeepfakePolling(true);

    (async () => {
      const url = `${API_BASE}/temp/${effectiveReqId}/deepfake.json`;
      let tries = 0;
      const maxTries = 120;

      while (!cancelled && tries < maxTries) {
        const ac = new AbortController();
        try {
          const res = await fetch(url, { cache: 'no-store', signal: ac.signal });
          if (res.ok) {
            const data = await res.json();
            setDeepfake(data);
            if (
              data?.completed === true ||
              typeof data?.is_deepfake === 'boolean' ||
              typeof data?.is_real === 'boolean'
            ) {
              setDeepfakePolling(false);
              return;
            }
          }
        } catch (_) {}
        tries += 1;
        await new Promise((r) => setTimeout(r, 2000));
        ac.abort();
      }
      setDeepfakePolling(false);
    })();

    return () => { cancelled = true; };
  }, [effectiveReqId, result, deepfake, deepfakePolling]);

  useEffect(() => {
    const needsManual =
      result?.status?.includes('Manual Review') || result?.status?.startsWith('🟡');
    const missingAssets = needsManual && (!idImgSrc || !videoSrc);
    if (needsManual && missingAssets && effectiveReqId) {
      (async () => {
        try {
          const res = await fetch(`${API_BASE}/review/${effectiveReqId}`, { cache: 'no-store' });
          if (res.ok) applyAssetUrls(await res.json());
        } catch (_) {}
      })();
    }
  }, [result, idImgSrc, videoSrc, effectiveReqId]);

  const handleManualDecision = async (status) => {
    try {
      const res = await fetch(`${API_BASE}/manual-review/${effectiveReqId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: status }),
      });
      if (!res.ok) throw new Error('Failed to submit decision');
      const data = await res.json();
      setDecision(status);
      setBackendMessage(data.message || `Marked as ${status}.`);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const resetAndGoHome = async () => {
    try { sessionStorage.removeItem('req_id'); } catch {}
    try { localStorage.removeItem('req_id'); } catch {}
    navigate('/');
  };

  const needsManual =
    result?.status?.includes('Manual Review') || result?.status?.startsWith('🟡');

  const normalizedScores = (() => {
    if (Array.isArray(result?.all_scores)) return result.all_scores;
    if (Array.isArray(result?.all_scores_percent)) {
      return result.all_scores_percent.map(([f, s]) => [f, s / 100]);
    }
    return [];
  })();

  const onIdImgError = () => {
    const fallback = `${API_BASE}/temp/${effectiveReqId}/id/cropped_id_face.jpg`;
    if (idImgSrc !== fallback) setIdImgSrc(fallback);
  };
  const onVideoError = () => setShowVideo(false);

  const renderDeepfakeBlock = () => {
    const dfCompleted = deepfake?.completed === true;
    const dfIsDeepfake =
      typeof deepfake?.is_deepfake === 'boolean'
        ? deepfake.is_deepfake
        : (typeof deepfake?.is_real === 'boolean' ? !deepfake.is_real : undefined);

    const resultDetected =
      (typeof result?.deepfake_detected === 'boolean') ? result.deepfake_detected : undefined;

    const finalDetected =
      (typeof dfIsDeepfake === 'boolean') ? dfIsDeepfake
        : (typeof resultDetected === 'boolean' ? resultDetected : undefined);

    const status = dfCompleted
      ? 'done'
      : (deepfake?.status ?? result?.deepfake_status);

    const isRunning = !dfCompleted
      && (typeof finalDetected !== 'boolean')
      && (status === 'running' || status === undefined);

    if (isRunning) {
      return (
        <div className="alert alert-info d-flex align-items-center" role="status" style={{ gap: 12 }}>
          <span className="spinner-border spinner-border-sm" aria-hidden="true" />
          <span><strong>Deepfake check:</strong> still running…</span>
        </div>
      );
    }

    if (deepfake?.error || status === 'error') {
      return (
        <div className="alert alert-warning">
          <strong>Deepfake check:</strong> an error occurred.
        </div>
      );
    }

    if (finalDetected === true) {
      return (
        <div className="alert alert-danger">
          <strong>Deepfake detected:</strong> The uploaded video appears to be a deepfake.
        </div>
      );
    }

    if (finalDetected === false || dfCompleted) {
      return (
        <div className="alert alert-success">
          <strong>Deepfake not detected.</strong>
        </div>
      );
    }

    return null;
  };

  if (!result && !error) {
    return (
      <div className="container-fluid bg-light min-vh-100 d-flex align-items-center justify-content-center">
        <div className="text-center">
          <div className="spinner-border mb-3" role="status" aria-hidden="true" />
          <h4 className="fw-semibold">{loadingMsg}</h4>
          <p className="text-muted mb-0">This can take a moment.</p>
        </div>
      </div>
    );
  }

  if (error && !result) {
    return (
      <div className="container-fluid bg-light min-vh-100 d-flex align-items-center justify-content-center">
        <div className="text-center">
          <h4 className="text-danger mb-3">Error</h4>
          <p className="mb-4">{error}</p>
          <button className="btn btn-secondary" onClick={resetAndGoHome}>
            Run Another Verification
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid bg-light min-vh-100">
      <div className="text-center py-4">
        <h1 className="fw-bold" style={{ marginTop: '4%' }}>
          Face Verification Result
        </h1>
      </div>

      <div className="d-flex justify-content-center" style={{ marginTop: '3%' }}>
        <div className="card shadow p-4 text-center" style={{ width: '100%', maxWidth: '750px' }}>
          {needsManual ? (
            <>
              <h4 className="mb-3">Manual Review Required</h4>
              {result?.error && <div className="alert alert-warning">{result.error}</div>}
              {renderDeepfakeBlock()}
              <div className="row mt-3">
                <div className="col-md-6 mb-3">
                  <h6>ID Image</h6>
                  {idImgSrc ? (
                    <img src={idImgSrc} alt="ID / Cropped Face" className="img-fluid border" onError={onIdImgError}/>
                  ) : (<div className="text-muted small">(ID image unavailable)</div>)}
                </div>
                <div className="col-md-6 mb-3">
                  <h6>Uploaded Video</h6>
                  {showVideo && videoSrc ? (
                    <video controls className="img-fluid border" src={videoSrc} onError={onVideoError}/>
                  ) : (<div className="text-muted small mt-2">(Video preview unavailable)</div>)}
                </div>
              </div>
              <div className="d-flex justify-content-center gap-3 mt-4">
                <button className="btn btn-success" onClick={() => handleManualDecision('verified')}>
                  Mark as Verified
                </button>
                <button className="btn btn-danger" onClick={() => handleManualDecision('unverified')}>
                  Mark as Unverified
                </button>
              </div>
              {decision && <div className="alert alert-success mt-3">✅ {backendMessage}</div>}
            </>
          ) : result?.error ? (
            <>
              <h4 className="text-danger mb-3">Verification Failed</h4>
              <p><strong>Reason:</strong> {result.error}</p>
              {renderDeepfakeBlock()}
            </>
          ) : (
            <>
              <h4 className="mb-3">Best Match</h4>
              {renderDeepfakeBlock()}
              {normalizedScores.length > 0 && (
                <table className="table table-bordered table-sm mt-2">
                  <thead>
                    <tr><th>Frame</th><th>Similarity</th></tr>
                  </thead>
                  <tbody>
                    {normalizedScores.map(([f, s], i) => (
                      <tr key={i}><td>{f}</td><td>{pct(s)}%</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p><strong>File:</strong> {result.best_match}</p>
              <p><strong>Score:</strong> {pct(result.score)}%</p>
              <p><strong>Average Score:</strong> {pct(result.average_score)}%</p>
              <p><strong>Status:</strong> {result.status}</p>
              <img
                src={abs(result?.best_match_url) || `${API_BASE}/temp/${effectiveReqId}/best_match.png`}
                alt="Side by side match"
                className="img-fluid mt-3"
                onError={(e) => { e.currentTarget.src = `${API_BASE}/temp/${effectiveReqId}/best_match.png`; }}
              />
              {Array.isArray(result?.selected_frames) && result.selected_frames.length > 0 && (
                <>
                  <h6 className="mt-4">Selected frames</h6>
                  <div className="d-flex flex-wrap justify-content-center gap-2 mt-2">
                    {result.selected_frames.slice(0, 12).map((u, i) => (
                      <img key={i} src={abs(u)} alt={`frame-${i}`} style={{ height: 72, borderRadius: 6 }} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          <div className="mt-4 d-flex justify-content-center">
            <button className="btn btn-secondary" onClick={resetAndGoHome}>
              Run Another Verification
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ResultPage;