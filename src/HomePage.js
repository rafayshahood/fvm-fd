import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

function HomePage() {
  const [documentFile, setDocumentFile] = useState(null);
  const [videoFile, setVideoFile] = useState(null);

  const [verifiedBest, setVerifiedBest] = useState(58);   
  const [verifiedAvg, setVerifiedAvg] = useState(53);    
  const [manualAvgMin, setManualAvgMin] = useState(38);   

  // const [verifiedBest, setVerifiedBest] = useState(0.58);
  // const [verifiedAvg, setVerifiedAvg] = useState(0.53);
  // const [manualAvgMin, setManualAvgMin] = useState(0.38);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!documentFile || !videoFile) {
      alert('Please upload both files');
      return;
    }

    const formData = new FormData();
    formData.append('id_image', documentFile);
    formData.append('video', videoFile);
    formData.append('verified_best', verifiedBest);
    formData.append('verified_avg', verifiedAvg);
    formData.append('manual_avg_min', manualAvgMin);

    try {
      const res = await fetch('http://localhost:8888/run-verification', {
      // const res = await fetch('https://gb0en19dwrvo4t-8888.proxy.runpod.net/run-verification', {
        method: 'POST',
        body: formData,
      });

      const text = await res.text();
      let data;

      try {
        data = JSON.parse(text);
      } catch {
        console.error("Invalid JSON:", text);
        alert("Unexpected server response. Check console.");
        return;
      }

      localStorage.setItem('result', JSON.stringify(data));
      navigate(`/result/${data.req_id}`);
    } catch (error) {
      console.error('Error:', error);
      alert('Something went wrong!');
    }
  };

  return (
    <div className="container-fluid bg-light min-vh-100">
      <div className="text-center py-4">
        <h1 className="fw-bold" style={{ marginTop: '4%' }}>Face Verification System</h1>
      </div>
      <div className="d-flex justify-content-center" style={{ marginTop: '5%' }}>
        <div className="card shadow p-4" style={{ width: '100%', maxWidth: '500px' }}>
          <h4 className="text-center mb-4">Upload Document & Video</h4>
          <form onSubmit={handleSubmit}>
            <div className="mb-3">
              <label className="form-label">Document File</label>
              <input
                type="file"
                className="form-control"
                accept=".pdf,.doc,.docx,image/*"
                onChange={(e) => setDocumentFile(e.target.files[0])}
              />
            </div>
            <div className="mb-4">
              <label className="form-label">Video File</label>
              <input
                type="file"
                className="form-control"
                accept="video/*"
                onChange={(e) => setVideoFile(e.target.files[0])}
              />
            </div>

            <div className="mb-3">
            <label className="form-label">Verified Thresholds</label>
            <div className="row">
              <div className="col">
                <div className="input-group">
                  <input
                    type="number"
                    step="1"
                    className="form-control"
                    value={verifiedBest}
                    onChange={(e) => setVerifiedBest(e.target.value)}
                    placeholder="Best Match (e.g. 58)"
                  />
                  <span className="input-group-text">%</span>
                </div>
              </div>
              <div className="col">
                <div className="input-group">
                  <input
                    type="number"
                    step="1"
                    className="form-control"
                    value={verifiedAvg}
                    onChange={(e) => setVerifiedAvg(e.target.value)}
                    placeholder="Average Score (e.g. 53)"
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
                type="number"
                step="1"
                className="form-control"
                value={manualAvgMin}
                onChange={(e) => setManualAvgMin(e.target.value)}
                placeholder="Min Avg (e.g. 38)"
              />
              <span className="input-group-text">%</span>
            </div>
          </div>
            <button type="submit" className="btn btn-primary w-100">Submit</button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default HomePage;