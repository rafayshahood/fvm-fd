// resultpage.js
import React, { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

// const API_ORIGIN = 'http://localhost:8888';
const API_ORIGIN = 'https://zmjdegdfastnee-8888.proxy.runpod.net';


const abs = (u) => (u ? (u.startsWith('http') ? u : `${API_ORIGIN}${u}`) : null);

function ResultPage() {
  const { reqId } = useParams();
  const navigate = useNavigate();

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMsg, setLoadingMsg] = useState('Verifying… Please wait');

  const [decision, setDecision] = useState(null);
  const [backendMessage, setBackendMessage] = useState(null);

  // Media state
  const [idImgSrc, setIdImgSrc] = useState(null);
  const [videoSrc, setVideoSrc] = useState(null);
  const [showVideo, setShowVideo] = useState(true);

  const pct = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 10 : x);
  const stopPollingRef = useRef(false);

  // Helper: apply URLs from result or review bundle
  const applyAssetUrls = (bundle) => {
    if (!bundle) return;
    const idUrl = abs(bundle.id_image_url) || abs(bundle.cropped_face_url) || null;
    const vidUrl = abs(bundle.video_url) || null;
    setIdImgSrc(idUrl);
    setVideoSrc(vidUrl);
  };

  // Poll result.json written by backend
  useEffect(() => {
    stopPollingRef.current = false;

    const poll = async () => {
      const url = `${API_ORIGIN}/temp/${reqId}/result.json`;

      let tries = 0;
      const maxTries = 90; // ~3 minutes @ 2s
      while (!stopPollingRef.current && tries < maxTries) {
        try {
          const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
          if (res.ok) {
            const data = await res.json();
            setResult(data);
            setError(null);

            // Normalize media URLs from result payload
            applyAssetUrls({
              id_image_url: data?.id_image_url,
              cropped_face_url: data?.cropped_face_url,
              video_url: data?.video_url,
            });
            return; // stop polling
          }
          setError(null);
        } catch (e) {
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
    return () => {
      stopPollingRef.current = true;
    };
  }, [reqId]);

  // If manual review and asset URLs are missing, fetch the review bundle
  useEffect(() => {
    const needsManual =
      result?.status?.includes('Manual Review') || result?.status?.startsWith('🟡');

    const missingAssets =
      needsManual && (!idImgSrc || !videoSrc);

    if (needsManual && missingAssets) {
      (async () => {
        try {
          const res = await fetch(`${API_ORIGIN}/review/${reqId}`, {
            credentials: 'include',
            cache: 'no-store',
          });
          if (res.ok) {
            const bundle = await res.json();
            applyAssetUrls(bundle);
          }
        } catch (_) {
          // ignore; UI already has fallbacks
        }
      })();
    }
  }, [result, idImgSrc, videoSrc, reqId]);

  const handleManualDecision = async (status) => {
    try {
      const res = await fetch(`${API_ORIGIN}/manual-review/${reqId}`, {
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

  // Start a fresh session, then go home
  const resetAndGoHome = async () => {
    try {
      await fetch(`${API_ORIGIN}/session/reset`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (_) {}
    navigate('/');
  };

  const needsManual =
    result?.status?.includes('Manual Review') || result?.status?.startsWith('🟡');

  // Normalize scores list
  const normalizedScores = (() => {
    if (Array.isArray(result?.all_scores)) return result.all_scores;
    if (Array.isArray(result?.all_scores_percent)) {
      return result.all_scores_percent.map(([f, s]) => [f, s / 100]);
    }
    return [];
  })();

  // Loading UI (polling)
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

  // Fallback helpers for media errors
  const onIdImgError = () => {
    const fallback = `${API_ORIGIN}/temp/${reqId}/id/cropped_id_face.jpg`;
    if (idImgSrc !== fallback) setIdImgSrc(fallback);
  };

  const onVideoError = () => {
    setShowVideo(false);
  };

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

              {result?.error && (
                <div className="alert alert-warning">{result.error}</div>
              )}

              <div className="row mt-3">
                <div className="col-md-6 mb-3">
                  <h6>ID Image</h6>
                  {idImgSrc ? (
                    <img
                      src={idImgSrc}
                      alt="ID / Cropped Face"
                      className="img-fluid border"
                      onError={onIdImgError}
                    />
                  ) : (
                    <div className="text-muted small">(ID image unavailable)</div>
                  )}
                </div>

                <div className="col-md-6 mb-3">
                  <h6>Uploaded Video</h6>
                  {showVideo && videoSrc ? (
                    <video
                      controls
                      className="img-fluid border"
                      src={videoSrc}
                      onError={onVideoError}
                    />
                  ) : (
                    <div className="text-muted small mt-2">
                      (Video preview unavailable)
                    </div>
                  )}
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

              {decision && (
                <div className="alert alert-success mt-3">
                  ✅ {backendMessage}
                </div>
              )}
            </>
          ) : result?.error ? (
            <>
              <h4 className="text-danger mb-3">Verification Failed</h4>
              <p><strong>Reason:</strong> {result.error}</p>
            </>
          ) : (
            <>
              <h4 className="mb-3">Best Match</h4>

              {normalizedScores.length > 0 && (
                <table className="table table-bordered table-sm mt-2">
                  <thead>
                    <tr>
                      <th>Frame</th>
                      <th>Similarity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {normalizedScores.map(([f, s], i) => (
                      <tr key={i}>
                        <td>{f}</td>
                        <td>{pct(s)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <p><strong>File:</strong> {result.best_match}</p>
              <p><strong>Score:</strong> {pct(result.score)}%</p>
              <p><strong>Average Score:</strong> {pct(result.average_score)}%</p>
              <p><strong>Status:</strong> {result.status}</p>

              <img
                src={abs(result?.best_match_url) || `${API_ORIGIN}/temp/${reqId}/best_match.png`}
                alt="Side by side match"
                className="img-fluid mt-3"
                onError={(e) => { e.currentTarget.src = `${API_ORIGIN}/temp/${reqId}/best_match.png`; }}
              />

              {/* Selected frames grid */}
              {Array.isArray(result?.selected_frames) && result.selected_frames.length > 0 && (
                <>
                  <h6 className="mt-4">Selected frames</h6>
                  <div className="d-flex flex-wrap justify-content-center gap-2 mt-2">
                    {result.selected_frames.slice(0, 12).map((u, i) => (
                      <img
                        key={i}
                        src={abs(u)}
                        alt={`frame-${i}`}
                        style={{ height: 72, borderRadius: 6 }}
                      />
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