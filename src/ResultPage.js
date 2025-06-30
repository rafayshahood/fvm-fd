import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';

function ResultPage() {
  const { reqId } = useParams();
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState(null);
  const [backendMessage, setBackendMessage] = useState(null);
  

  useEffect(() => {
    // fetch(`http://localhost:8888/temp/${reqId}/result.json`)
    fetch(`https://h1edrlkvetkm3j-8888.proxy.runpod.net/temp/${reqId}/result.json`)

      .then(res => {
        if (!res.ok) throw new Error('Result not ready yet');
        return res.json();
      })
      .then(data => setResult(data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [reqId]);

  const handleManualDecision = async (status) => {
    try {
      // const res = await fetch(`http://localhost:8888/manual-review/${reqId}`, {

      const res = await fetch(`https://h1edrlkvetkm3j-8888.proxy.runpod.net/manual-review/${reqId}`, {
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

  if (loading) return <div className="text-center mt-5">Loading result...</div>;
  if (error) return <div className="text-center mt-5 text-danger">Error: {error}</div>;

  return (
    <div className="container-fluid bg-light min-vh-100">
      <div className="text-center py-4">
        <h1 className="fw-bold" style={{ marginTop: '4%' }}>Face Verification Result</h1>
      </div>
      <div className="d-flex justify-content-center" style={{ marginTop: '3%' }}>
        <div className="card shadow p-4 text-center" style={{ width: '100%', maxWidth: '700px' }}>
          {result?.status === 'Needs Manual Review' ? (
            <>
              <h4 className="mb-3">Manual Review Required</h4>

              {result.error && (
                <div className="alert alert-warning">{result.error}</div>
              )}

              <div className="row mt-3">
                <div className="col-md-6 mb-3">
                  <h6>ID Image</h6>
                  <img
                    // src={`http://localhost:8888/temp/${reqId}/cropped_face.png`}
                    src={`https://h1edrlkvetkm3j-8888.proxy.runpod.net/temp/${reqId}/cropped_face.png`}

                    alt="Cropped Face"
                    className="img-fluid border"
                  />
                </div>
                <div className="col-md-6 mb-3">
                  <h6>Uploaded Video</h6>
                  <video
                    controls
                    // src={`http://localhost:8888/temp/${reqId}/video.mp4`}
                    src={`https://h1edrlkvetkm3j-8888.proxy.runpod.net/temp/${reqId}/video.mp4`}

                    className="img-fluid border"
                  />
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

              {result.all_scores_percent?.length > 0 && (
                <table className="table table-bordered table-sm mt-2">
                  <thead>
                    <tr><th>Frame</th><th>Similarity Score</th></tr>
                  </thead>
                  <tbody>
                    {result.all_scores_percent.map(([f, s], i) => (
                      <tr key={i}><td>{f}</td><td>{s}%</td></tr>
                    ))}
                  </tbody>
                </table>
              )}

              <p><strong>File:</strong> {result.best_match}</p>
              <p><strong>Score:</strong> {result.score_percent}%</p>
              <p><strong>Average Score:</strong> {result.average_score_percent}%</p>
              <p><strong>Status:</strong> {result.status}</p>

              <img
                // src={`http://localhost:8888/temp/${reqId}/best_match.png`}
                src={`https://h1edrlkvetkm3j-8888.proxy.runpod.net/temp/${reqId}/best_match.png`}
                
                alt="Side by side match"
                className="img-fluid mt-3"
              />
            </>
          )}

          <div className="mt-4">
            <Link to="/" className="btn btn-secondary">Run Another Verification</Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ResultPage;
