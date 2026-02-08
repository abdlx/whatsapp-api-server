'use client';

import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { QRCodeSVG } from 'qrcode.react';
import {
  Plus,
  Trash2,
  RefreshCw,
  MessageSquare,
  Settings,
  Smartphone,
  Power,
  CheckCircle2,
  AlertCircle,
  QrCode,
  X,
  Send,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// --- Types ---
interface Session {
  id: string;
  agent_name: string;
  status: string;
  phone_number: string | null;
  last_active: string | null;
  daily_message_count: number;
}

// --- Components ---

const StatusBadge = ({ status }: { status: string }) => {
  if (status === 'active' || status === 'open') {
    return <span className="badge badge-success">Online</span>;
  }
  if (status === 'pairing' || status === 'connecting') {
    return <span className="badge badge-warning">Pairing</span>;
  }
  return <span className="badge badge-error">Offline</span>;
};

export default function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Config
  const [apiUrl, setApiUrl] = useState('http://wapi.idkwihl.space');
  const [apiKey, setApiKey] = useState('');
  const [showConfig, setShowConfig] = useState(false);

  // New Session State
  const [showNewSession, setShowNewSession] = useState(false);
  const [newAgentId, setNewAgentId] = useState('');
  const [newAgentName, setNewAgentName] = useState('');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  // Message State
  const [showMessageModal, setShowMessageModal] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [message, setMessage] = useState('');
  const [sendLoading, setSendLoading] = useState(false);

  // --- API Methods ---

  const getHeaders = useCallback(() => ({
    'x-api-key': apiKey,
    'Content-Type': 'application/json'
  }), [apiKey]);

  const fetchSessions = useCallback(async () => {
    if (!apiKey) return;
    setLoading(true);
    try {
      const response = await axios.get(`${apiUrl}/sessions`, { headers: getHeaders() });
      setSessions(response.data.sessions || []);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to fetch sessions. Check API URL and Key.');
    } finally {
      setLoading(false);
    }
  }, [apiUrl, apiKey, getHeaders]);

  useEffect(() => {
    // Load config from localStorage
    const savedUrl = localStorage.getItem('wapi_url');
    const savedKey = localStorage.getItem('wapi_key');
    if (savedUrl) setApiUrl(savedUrl);
    if (savedKey) setApiKey(savedKey);
  }, []);

  useEffect(() => {
    if (apiKey) fetchSessions();
  }, [apiKey, fetchSessions]);

  const saveConfig = () => {
    localStorage.setItem('wapi_url', apiUrl);
    localStorage.setItem('wapi_key', apiKey);
    setShowConfig(false);
    fetchSessions();
  };

  const createSession = async (e: React.FormEvent) => {
    e.preventDefault();
    setQrLoading(true);
    try {
      const resp = await axios.post(`${apiUrl}/session/create`, {
        agentId: newAgentId,
        agentName: newAgentName
      }, { headers: getHeaders() });

      // If we directly get a QR or wait for it
      pollQR(newAgentId);
    } catch (err: any) {
      alert(err.response?.data?.message || 'Error creating session');
      setQrLoading(false);
    }
  };

  const pollQR = async (id: string) => {
    setQrLoading(true);
    try {
      const resp = await axios.get(`${apiUrl}/session/${id}/qr`, { headers: getHeaders() });
      // The API returns { qr: "data:image/png;base64,..." } or similar
      // But Baileys QR is usually a raw string. 
      // Based on our route: it returns { qr: qrDataUrl }
      setQrCode(resp.data.qr);
    } catch (err) {
      setTimeout(() => pollQR(id), 2000);
    } finally {
      setQrLoading(false);
    }
  };

  const deleteSession = async (id: string) => {
    if (!confirm('Are you sure you want to disconnect and delete this session?')) return;
    try {
      await axios.delete(`${apiUrl}/session/${id}`, { headers: getHeaders() });
      fetchSessions();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Error deleting session');
    }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendLoading(true);
    try {
      await axios.post(`${apiUrl}/message/send`, {
        sessionId: activeSessionId,
        recipient,
        message
      }, { headers: getHeaders() });
      alert('Message queued successfully!');
      setShowMessageModal(false);
      setMessage('');
      setRecipient('');
    } catch (err: any) {
      alert(err.response?.data?.message || 'Error sending message');
    } finally {
      setSendLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-12 max-w-6xl">
      {/* Header */}
      <header className="flex justify-between items-center mb-12 animate-in" style={{ animationDelay: '0.1s' }}>
        <div>
          <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-cyan-400 mb-2">
            WhatsApp API Dashboard
          </h1>
          <p className="text-zinc-400">Manage your unofficial WhatsApp automation</p>
        </div>
        <div className="flex gap-4">
          <button className="btn btn-outline" onClick={() => setShowConfig(!showConfig)}>
            <Settings size={20} />
            Config
          </button>
          <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
            <Plus size={20} />
            New Session
          </button>
        </div>
      </header>

      {/* Config Panel */}
      <AnimatePresence>
        {showConfig && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="glass p-6 mb-8 overflow-hidden"
          >
            <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
              <Settings size={20} className="text-emerald-400" />
              API Settings
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium mb-2">Server URL</label>
                <input
                  className="input"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  placeholder="http://wapi.idkwihl.space"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">API Key</label>
                <input
                  type="password"
                  className="input"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Your super secret key"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <button className="btn btn-primary" onClick={saveConfig}>Save Changes</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main>
        {!apiKey ? (
          <div className="glass p-12 text-center animate-in" style={{ animationDelay: '0.2s' }}>
            <AlertCircle size={48} className="mx-auto mb-4 text-emerald-400" />
            <h2 className="text-2xl font-semibold mb-2">Setup Required</h2>
            <p className="text-zinc-400 mb-6">Please enter your API Key in the Config section to start managing sessions.</p>
            <button className="btn btn-primary mx-auto" onClick={() => setShowConfig(true)}>Open Config</button>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4 animate-in">
            <RefreshCw className="animate-spin text-emerald-400" size={32} />
            <p className="text-zinc-400">Fetching sessions...</p>
          </div>
        ) : sessions.length === 0 ? (
          <div className="glass p-12 text-center animate-in" style={{ animationDelay: '0.2s' }}>
            <Smartphone size={48} className="mx-auto mb-4 text-emerald-400 opacity-20" />
            <h2 className="text-2xl font-semibold mb-2">No Active Sessions</h2>
            <p className="text-zinc-400 mb-6">Create your first session to link your WhatsApp account.</p>
            <button className="btn btn-primary mx-auto" onClick={() => setShowNewSession(true)}>
              <Plus size={20} />
              Setup First Agent
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {sessions.map((session, idx) => (
              <motion.div
                key={session.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.1 }}
                className="glass p-6 group hover:border-emerald-500/50 transition-colors"
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-lg font-bold">{session.agent_name}</h3>
                    <code className="text-xs text-zinc-500">{session.id}</code>
                  </div>
                  <StatusBadge status={session.status} />
                </div>

                <div className="space-y-3 mb-6">
                  <div className="flex items-center gap-2 text-sm text-zinc-400">
                    <Smartphone size={16} />
                    <span>{session.phone_number || 'Not linked'}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-zinc-400">
                    <CheckCircle2 size={16} />
                    <span>{session.daily_message_count} messages today</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-zinc-400">
                    <Loader2 size={16} />
                    <span>Last active: {session.last_active ? new Date(session.last_active).toLocaleString() : 'Never'}</span>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    className="btn btn-outline flex-1 text-sm py-2"
                    onClick={() => {
                      setActiveSessionId(session.id);
                      setShowMessageModal(true);
                    }}
                    disabled={session.status !== 'active' && session.status !== 'open'}
                  >
                    <MessageSquare size={16} />
                    Test
                  </button>
                  <button
                    className="btn btn-outline text-red-400 border-red-400/20 hover:bg-red-400/10 py-2 px-3"
                    onClick={() => deleteSession(session.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      {/* New Session Modal */}
      {showNewSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowNewSession(false)} />
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="glass w-full max-w-md p-8 relative z-10"
          >
            <button className="absolute top-4 right-4 text-zinc-500 hover:text-white" onClick={() => setShowNewSession(false)}>
              <X size={24} />
            </button>

            <h2 className="text-2xl font-bold mb-6">Create New Agent</h2>

            {!qrCode ? (
              <form onSubmit={createSession} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Agent ID (slug)</label>
                  <input
                    className="input"
                    value={newAgentId}
                    onChange={(e) => setNewAgentId(e.target.value)}
                    placeholder="e.g. sales-agent-1"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">Display Name</label>
                  <input
                    className="input"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    placeholder="e.g. John Doe (Sales)"
                    required
                  />
                </div>
                <button className="btn btn-primary w-full mt-4 h-12" disabled={qrLoading}>
                  {qrLoading ? <RefreshCw className="animate-spin" /> : 'Generate QR Code'}
                </button>
              </form>
            ) : (
              <div className="text-center py-4">
                <div className="bg-white p-4 rounded-2xl inline-block mb-6 shadow-2xl shadow-emerald-500/20">
                  <img src={qrCode} alt="WhatsApp QR" className="w-64 h-64" />
                </div>
                <p className="text-zinc-400 text-sm mb-6">Scan this QR code with your WhatsApp app<br />(Linked Devices -{">"} Link a Device)</p>
                <button className="btn btn-primary w-full" onClick={() => {
                  setShowNewSession(false);
                  setQrCode(null);
                  fetchSessions();
                }}>
                  I've Scanned It
                </button>
              </div>
            )}
          </motion.div>
        </div>
      )}

      {/* Message Modal */}
      {showMessageModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowMessageModal(false)} />
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="glass w-full max-w-md p-8 relative z-10"
          >
            <button className="absolute top-4 right-4 text-zinc-500 hover:text-white" onClick={() => setShowMessageModal(false)}>
              <X size={24} />
            </button>
            <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <Send size={24} className="text-emerald-400" />
              Test Message
            </h2>
            <form onSubmit={sendMessage} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Recipient Number</label>
                <input
                  className="input"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="e.g. 15551234567"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Message</label>
                <textarea
                  className="input h-32 resize-none"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type your test message here..."
                  required
                />
              </div>
              <button className="btn btn-primary w-full mt-4 h-12" disabled={sendLoading}>
                {sendLoading ? <RefreshCw className="animate-spin" /> : 'Send Message'}
              </button>
            </form>
          </motion.div>
        </div>
      )}

      {/* Footer */}
      <footer className="mt-24 text-center text-zinc-600 text-sm animate-in" style={{ animationDelay: '0.4s' }}>
        <p>&copy; 2026 WhatsApp API Gateway Dashboard. For internal testing only.</p>
      </footer>

      {/* Add responsive styles / Tailwind equivalents manually or using CSS */}
      <style jsx>{`
        .container { width: 100%; margin: 0 auto; }
        .mx-auto { margin-left: auto; margin-right: auto; }
        .px-4 { padding-left: 1rem; padding-right: 1rem; }
        .py-12 { padding-top: 3rem; padding-bottom: 3rem; }
        .max-w-6xl { max-width: 72rem; }
        .flex { display: flex; }
        .flex-col { flex-direction: column; }
        .justify-between { justify-content: space-between; }
        .items-center { align-items: center; }
        .items-start { align-items: flex-start; }
        .gap-4 { gap: 1rem; }
        .gap-2 { gap: 0.5rem; }
        .mb-12 { margin-bottom: 3rem; }
        .mb-8 { margin-bottom: 2rem; }
        .mb-6 { margin-bottom: 1.5rem; }
        .mb-4 { margin-bottom: 1rem; }
        .mb-2 { margin-bottom: 0.5rem; }
        .mt-6 { margin-top: 1.5rem; }
        .mt-4 { margin-top: 1rem; }
        .mt-24 { margin-top: 6rem; }
        .grid { display: grid; }
        .grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
        .text-4xl { font-size: 2.25rem; line-height: 2.5rem; }
        .text-2xl { font-size: 1.5rem; line-height: 2rem; }
        .text-xl { font-size: 1.25rem; line-height: 1.75rem; }
        .text-lg { font-size: 1.125rem; line-height: 1.75rem; }
        .text-sm { font-size: 0.875rem; line-height: 1.25rem; }
        .text-xs { font-size: 0.75rem; line-height: 1rem; }
        .font-bold { font-weight: 700; }
        .font-semibold { font-weight: 600; }
        .font-medium { font-weight: 500; }
        .text-zinc-400 { color: #a1a1aa; }
        .text-zinc-500 { color: #71717a; }
        .text-zinc-600 { color: #52525b; }
        .text-emerald-400 { color: #34d399; }
        .text-cyan-400 { color: #22d3ee; }
        .w-full { width: 100%; }
        .max-w-md { max-width: 28rem; }
        .h-12 { height: 3rem; }
        .h-32 { height: 8rem; }
        .resize-none { resize: none; }
        .fixed { position: fixed; }
        .inset-0 { top: 0; right: 0; bottom: 0; left: 0; }
        .z-50 { z-index: 50; }
        .absolute { position: absolute; }
        .bg-black\/80 { background-color: rgba(0,0,0,0.8); }
        .backdrop-blur-sm { backdrop-filter: blur(4px); }
        .text-center { text-align: center; }
        .inline-block { display: inline-block; }
        .rounded-2xl { border-radius: 1rem; }
        .shadow-2xl { box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
        .shadow-emerald-500\/20 { box-shadow: 0 0 40px rgba(16, 185, 129, 0.2); }
        .bg-white { background-color: #ffffff; }

        @media (min-width: 768px) {
          .md\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .md\:flex-row { flex-direction: row; }
        }
        @media (min-width: 1024px) {
          .lg\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }

        .bg-clip-text { -webkit-background-clip: text; background-clip: text; }
        .text-transparent { color: transparent; }
        .bg-gradient-to-r { background-image: linear-gradient(to right, var(--tw-gradient-stops)); }
        .from-emerald-400 { --tw-gradient-from: #34d399; --tw-gradient-to: rgb(52 211 153 / 0); --tw-gradient-stops: var(--tw-gradient-from), var(--tw-gradient-to); }
        .to-cyan-400 { --tw-gradient-to: #22d3ee; }

        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
