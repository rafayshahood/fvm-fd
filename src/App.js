import React from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import HomePage from './HomePage';
import ResultPage from './ResultPage';
import LiveVerification from './LiveVerification';
import LiveIDVerification from './LiveIDVerification'; // NEW
import LiveIDBackVerification from './LiveIDBackVerification'

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/result/:reqId" element={<ResultPage />} />
        <Route path="/live" element={<LiveVerification />} />
        <Route path="/live-id" element={<LiveIDVerification />} /> {/* NEW */}
        <Route path="/live-id-back" element={<LiveIDBackVerification />} />

      </Routes>
    </Router>
  );
}

export default App;