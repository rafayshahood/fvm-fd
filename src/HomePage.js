import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';

function HomePage() {
  const [verifiedBest, setVerifiedBest] = useState(32);
  const [verifiedAvg, setVerifiedAvg] = useState(32);
  const [manualAvgMin, setManualAvgMin] = useState(24);

  const [idVerified, setIdVerified] = useState(false);
  const [videoVerified, setVideoVerified] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  const navigate = useNavigate();

  async function bootstrapSession() {
    try {
      const res = await fetch('http://localhost:8888/session/start', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      const st = data?.state || {};
      setIdVerified(!!st.id_verified);
      setVideoVerified(!!st.video_verified);
    } catch (e) {
      console.error('Session bootstrap failed', e);
    }
  }

  async function refreshState() {
    try {
      const res = await fetch('http://localhost:8888/session/state', {
        credentials: 'include',
      });
      const data = await res.json();
      const st = data?.state || {};
      setIdVerified(!!st.id_verified);
      setVideoVerified(!!st.video_verified);
    } catch (e) {
      console.error('Session refresh failed', e);
    }
  }

  useEffect(() => {
    bootstrapSession();
  }, []);

  useEffect(() => {
    const onFocus = () => refreshState();
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onFocus);
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!idVerified || !videoVerified) {
      alert('Please complete ID and Video verification first.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('http://localhost:8888/verify-session', {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error || 'Verification failed');
        setSubmitting(false);
        return;
      }
      localStorage.setItem('result', JSON.stringify(data.result));
      navigate(`/result/${data.req_id}`);
    } catch (err) {
      console.error(err);
      alert('Something went wrong!');
      setSubmitting(false);
    }
  };

  const cardDisabled = submitting;

  return (
    <div className="container-fluid bg-light min-vh-100">
      <div className="text-center py-4">
        <h1 className="fw-bold" style={{ marginTop: '4%' }}>Face Verification System</h1>
      </div>

      <div className="d-flex justify-content-center" style={{ marginTop: '5%' }}>
        <div
          className="card shadow p-4"
          style={{ width: '100%', maxWidth: '520px', position: 'relative' }}
          aria-busy={cardDisabled}
        >
          {/* Overlay while submitting */}
          {submitting && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(255,255,255,0.8)',
                zIndex: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
                gap: '12px',
                borderRadius: '0.5rem'
              }}
            >
              <div className="spinner-border" role="status" aria-hidden="true" />
              <div className="fw-semibold">Submitting… Verifying, please wait</div>
            </div>
          )}

          <h4 className="text-center mb-4">Verification</h4>

          {/* Document ID */}
          <fieldset disabled={cardDisabled}>
            <div className="mb-3">
              <div className="d-flex justify-content-between align-items-center mb-2">
                <label className="form-label mb-0">Document ID</label>
                {idVerified && (
                  <span className="badge bg-success px-3 py-2 rounded-pill d-flex align-items-center" style={{ gap: 8 }}>
                    <span>✔</span><span>ID Verified</span>
                  </span>
                )}
              </div>
              <Link to="/live-id" className="btn btn-primary w-100">
                Verify ID
              </Link>
            </div>

            {/* Video */}
            <div className="mb-3">
              <div className="d-flex justify-content-between align-items-center mb-2">
                <label className="form-label mb-0">Video File</label>
                {videoVerified && (
                  <span className="badge bg-success px-3 py-2 rounded-pill d-flex align-items-center" style={{ gap: 8 }}>
                    <span>✔</span><span>Video Verified</span>
                  </span>
                )}
              </div>

              <Link
                to={idVerified ? "/live" : "#"}
                className={`btn w-100 ${idVerified ? "btn-primary" : "btn-secondary disabled"}`}
                onClick={(e) => { if (!idVerified) e.preventDefault(); }}
                aria-disabled={!idVerified}
              >
                Verify Video
              </Link>

              {!idVerified && (
                <div className="form-text mt-1">Complete ID verification first to enable this.</div>
              )}
            </div>

            {/* Thresholds (UI only) */}
            <form onSubmit={handleSubmit}>
              <div className="mb-3">
                <label className="form-label">Verified Thresholds</label>
                <div className="row">
                  <div className="col">
                    <div className="input-group">
                      <input
                        type="number" step="1" className="form-control"
                        value={verifiedBest} onChange={(e) => setVerifiedBest(e.target.value)}
                        placeholder="Best Match (e.g. 58)"
                        disabled={cardDisabled}
                      />
                      <span className="input-group-text">%</span>
                    </div>
                  </div>
                  <div className="col">
                    <div className="input-group">
                      <input
                        type="number" step="1" className="form-control"
                        value={verifiedAvg} onChange={(e) => setVerifiedAvg(e.target.value)}
                        placeholder="Average Score (e.g. 53)"
                        disabled={cardDisabled}
                      />
                      <span className="input-group-text">%</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mb-4">
                <label className="form-label">Manual Review Min Avg</label>
                <div className="input-group">
                  <input
                    type="number" step="1" className="form-control"
                    value={manualAvgMin} onChange={(e) => setManualAvgMin(e.target.value)}
                    placeholder="Min Avg (e.g. 38)"
                    disabled={cardDisabled}
                  />
                  <span className="input-group-text">%</span>
                </div>
              </div>

              <button
                type="submit"
                className={`btn w-100 ${idVerified && videoVerified ? 'btn-primary' : 'btn-secondary'}`}
                disabled={!(idVerified && videoVerified) || cardDisabled}
              >
                {cardDisabled ? 'Submitting…' : 'Submit for Verification'}
              </button>

              {!(idVerified && videoVerified) && !cardDisabled && (
                <div className="form-text mt-2">
                  Complete ID and Video verification to submit.
                </div>
              )}
            </form>
          </fieldset>
        </div>
      </div>
    </div>
  );
}

export default HomePage;