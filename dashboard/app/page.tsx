'use client';

import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  Plus,
  Trash2,
  RefreshCw,
  MessageSquare,
  Settings,
  Smartphone,
  CheckCircle2,
  AlertCircle,
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
      const msg = err.response?.data?.message || 'Failed to fetch sessions. Check API URL and Key.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, apiKey, getHeaders]);

  useEffect(() => {
    // Load config from localStorage
    if (typeof window !== 'undefined') {
      const savedUrl = localStorage.getItem('wapi_url');
      const savedKey = localStorage.getItem('wapi_key');
      if (savedUrl) setApiUrl(savedUrl);
      if (savedKey) setApiKey(savedKey);
    }
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
      await axios.post(`${apiUrl}/session/create`, {
        agentId: newAgentId,
        agentName: newAgentName
      }, { headers: getHeaders() });

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
      setQrCode(resp.data.qr);
      setQrLoading(false);
    } catch (err) {
      // Keep polling until QR is available
      setTimeout(() => pollQR(id), 2000);
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
    <div className="container py-12">
      {/* Header */}
      <header className="flex justify-between items-center mb-12 animate-in">
        <div>
          <h1 className="bg-clip-text text-transparent bg-gradient-to-r mb-2">
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
            className="glass p-6 mb-8"
            style={{ overflow: 'hidden' }}
          >
            <h2 className="mb-6 flex items-center gap-2">
              <Settings size={20} className="text-emerald-400" />
              API Settings
            </h2>
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium mb-2">Server URL</label>
                <input
                  className="input"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  placeholder="https://wapi.example.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">API Key</label>
                <input
                  type="password"
                  className="input"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Your secret key"
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
        {error && (
          <div className="glass p-4 mb-8 border-red-400/20 bg-red-400/5 flex items-center gap-3">
            <AlertCircle size={20} className="text-red-400" />
            <span className="text-sm text-red-400">{error}</span>
          </div>
        )}

        {!apiKey ? (
          <div className="glass p-12 text-center animate-in">
            <AlertCircle size={48} className="mx-auto mb-4 text-emerald-400" />
            <h2 className="mb-2">Setup Required</h2>
            <p className="text-zinc-400 mb-6">Please enter your API Key in the Config section to start managing sessions.</p>
            <button className="btn btn-primary" style={{ margin: '0 auto' }} onClick={() => setShowConfig(true)}>Open Config</button>
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4 animate-in">
            <RefreshCw className="animate-spin text-emerald-400" size={32} />
            <p className="text-zinc-400">Fetching sessions...</p>
          </div>
        ) : sessions.length === 0 ? (
          <div className="glass p-12 text-center animate-in">
            <Smartphone size={48} className="mx-auto mb-4 text-emerald-400" style={{ opacity: 0.2 }} />
            <h2 className="mb-2">No Active Sessions</h2>
            <p className="text-zinc-400 mb-6">Create your first session to link your WhatsApp account.</p>
            <button className="btn btn-primary" style={{ margin: '0 auto' }} onClick={() => setShowNewSession(true)}>
              <Plus size={20} />
              Setup First Agent
            </button>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {sessions.map((session) => (
              <motion.div
                key={session.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="glass p-6 flex flex-col"
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-lg font-bold">{session.agent_name}</h3>
                    <code className="text-xs text-zinc-500">{session.id}</code>
                  </div>
                  <StatusBadge status={session.status} />
                </div>

                <div className="flex-col gap-3 mb-6" style={{ display: 'flex', flex: 1 }}>
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
                    className="btn btn-outline"
                    style={{ flex: 1 }}
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
                    className="btn btn-outline"
                    style={{ color: '#f87171', borderColor: 'rgba(248, 113, 113, 0.2)' }}
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
        <div className="modal-container">
          <div className="modal-backdrop" onClick={() => setShowNewSession(false)} />
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="modal-content p-8"
          >
            <button className="absolute" style={{ top: '1rem', right: '1rem', background: 'none', border: 'none', cursor: 'pointer', color: '#71717a' }} onClick={() => setShowNewSession(false)}>
              <X size={24} />
            </button>

            <h2 className="mb-6 text-center">Create New Agent</h2>

            {!qrCode ? (
              <form onSubmit={createSession} className="flex flex-col gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2 text-zinc-300">Agent ID (slug)</label>
                  <input
                    className="input"
                    value={newAgentId}
                    onChange={(e) => setNewAgentId(e.target.value)}
                    placeholder="e.g. sales-agent-1"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-zinc-300">Display Name</label>
                  <input
                    className="input"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    placeholder="e.g. John Doe (Sales)"
                    required
                  />
                </div>
                <button className="btn btn-primary w-full mt-4" style={{ height: '3rem' }} disabled={qrLoading}>
                  {qrLoading ? <RefreshCw className="animate-spin" /> : 'Generate QR Code'}
                </button>
              </form>
            ) : (
              <div className="text-center">
                <div className="bg-white p-4 rounded-2xl" style={{ display: 'inline-block', marginBottom: '1.5rem' }}>
                  <img src={qrCode} alt="WhatsApp QR" style={{ width: '256px', height: '256px' }} />
                </div>
                <p className="text-zinc-400 text-sm mb-6">Scan this QR code with your WhatsApp app</p>
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
        <div className="modal-container">
          <div className="modal-backdrop" onClick={() => setShowMessageModal(false)} />
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="modal-content p-8"
          >
            <button className="absolute" style={{ top: '1rem', right: '1rem', background: 'none', border: 'none', cursor: 'pointer', color: '#71717a' }} onClick={() => setShowMessageModal(false)}>
              <X size={24} />
            </button>
            <h2 className="mb-6 flex items-center gap-2 justify-center">
              <Send size={24} className="text-emerald-400" />
              Test Message
            </h2>
            <form onSubmit={sendMessage} className="flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium mb-2 text-zinc-300">Recipient Number</label>
                <input
                  className="input"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="e.g. 15551234567"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2 text-zinc-300">Message</label>
                <textarea
                  className="input"
                  style={{ height: '8rem', resize: 'none' }}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type your test message here..."
                  required
                />
              </div>
              <button className="btn btn-primary w-full mt-4" style={{ height: '3rem' }} disabled={sendLoading}>
                {sendLoading ? <RefreshCw className="animate-spin" /> : 'Send Message'}
              </button>
            </form>
          </motion.div>
        </div>
      )}

      {/* Footer */}
      <footer className="mt-24 text-center text-zinc-600 text-sm animate-in">
        <p>&copy; 2026 WhatsApp API Gateway Dashboard. For internal testing only.</p>
      </footer>
    </div>
  );
}
