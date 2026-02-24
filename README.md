# WhatsApp API Server (Pro) 🚀

A production-grade, highly robust WhatsApp API server built with **Node.js**, **Fastify**, **Baileys**, **Redis**, and **Supabase**. This server is designed for high-volume CRM integrations, featuring advanced anti-ban protections, multi-instance session routing, rich media support, and a reliable webhook delivery system.

---

## 🌟 Key Features

### 🛡️ Advanced Anti-Ban System
Our multi-layered protection system reduces ban probability from ~80% to **<5%** when used correctly:
- **Adaptive Rate Limiting**: Dynamic limits based on account age and health.
- **Human Behavior Simulation**: Enforces business hours, sleep patterns, and random breaks.
- **Contact Verification**: Checks if recipients exist and calculates "Conversation Scores" to gate cold outreach.
- **Typing simulation**: Realistic composing/paused status cycles based on message length.
- **Proxy Support**: Sticky geo-matched residential proxy support for all WA traffic.

### 📡 Reliable Webhook Engine (BullMQ)
Never miss an event. Our webhook system uses **BullMQ** with exponential backoff retries:
- **Events**: `message.received`, `message.sent`, `message.delivered`, `message.read`, `message.failed`, `message.revoked`, `message.reaction`, `call.received`, `session.connected/disconnected`, and more.
- **HMAC Signing**: Secure your callbacks with SHA256 signatures.
- **Filtering**: Register webhooks for specific events or sessions.

### 🖼️ Rich Media & Message Types
Full support for modern WhatsApp message formats:
- **Rich Media**: Voice Notes (PTT/OGG), Auto-looping GIFs, Short Round Videos (PTV), Audio, Image, Document, and Sticker.
- **Modern Interactive Messages**: Native Flow buttons, lists, and poll messages (replacing deprecated formats).
- **Extras**: Customizable Link Previews, Live Locations, and Multi-Contact VCFs.

### 💬 Chat & Message Management
Complete control over the WhatsApp experience:
- **Message Actions**: Mark as read (blue ticks), React with emojis, Forward, Delete (for me/everyone), Star, and Pin.
- **Chat Management**: List chats, get metadata, Archive/Unarchive, Delete, Pin, and Mute chats.

### 🏢 Business Management Modules
Advanced routes for comprehensive CRM integration:
- **Groups**: Create groups, manage participants (Promote/Demote), update settings (Announce/Locked), and manage invite links (Generate/Join/Revoke).
- **Contacts**: Bulk phone number verification with a **persistent Supabase cache** to minimize rate limits and speed up checks.
- **Presence**: Set online/offline status, and send real-time "typing..." or "recording..." indicators.
- **Blacklist**: Per-session contact block/unblock with local DB synchronization.
- **Newsletters & Stories**: Create/Follow Channels and post text or media Status updates to `status@broadcast`.

### 🌐 Distributed Architecture
Built for scale:
- **Multi-Instance Routing**: Transparently proxies API requests to the specific server pod holding an active session.
- **Redis Heartbeats**: Real-time ownership tracking for cluster health.
- **State Persistence**: Distributed authentication state in Redis with encrypted session backups in Supabase.

### 🧪 Test Infrastructure
Professional testing foundation:
- **Vitest & Supertest**: High-performance unit and integration testing suite.
- **Service Mocks**: Built-in mocks for Supabase, Redis, and BullMQ to test API routing and validation instantly without needing live connections.

---

## 🚀 Quick Start

### 1. Installation
```bash
git clone https://github.com/your-repo/whatsapp-api-server.git
cd whatsapp-api-server
npm install
```

### 2. Configuration
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```
Key requirements:
- **Supabase**: URL and Service Role Key for database & session storage.
- **Redis**: For job queues and authentication state.
- **API_KEY**: A 32+ character secret for securing your API endpoints (also used as the key derivation source for session encryption).

### 3. Run the Server
```bash
# Development
npm run dev

# Run Tests
npm run test
npm run test:coverage

# Production Build
npm run build
npm run start
```

---

## 📖 API Documentation

The server features a built-in **Swagger UI** for interactive API testing and documentation.
- **Swagger UI**: `http://localhost:3000/docs`

### Example: Register a Webhook
```bash
curl -X POST http://localhost:3000/webhooks \
  -H "x-api-key: YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-crm.com/api/whatsapp/webhook",
    "events": ["message.received", "message.delivered"],
    "secret": "your-hmac-secret-key"
  }'
```

---

## 🛡️ Anti-Ban Best Practices

**For New Accounts (0-30 days):**
1. **Warm up slowly**: Start with 2-5 messages per day to saved contacts.
2. **Respect Timezones**: Set your `DEFAULT_TIMEZONE` in `.env` to ensure messages sent during local business hours.
3. **Avoid Cold Lists**: High report rates are the #1 cause of bans. Message targets with existing history first.

---

## 🏗️ Technical Stack
- **Engine**: [Baileys](https://github.com/WhiskeySockets/Baileys) (Official implementation mirror)
- **Framework**: [Fastify](https://www.fastify.io/) (High performance)
- **Database**: [Supabase](https://supabase.com/) (PostgreSQL)
- **Cache/Queue**: [Redis](https://redis.io/) (BullMQ)
- **Validation**: [Zod](https://zod.dev/)
- **Testing**: [Vitest](https://vitest.dev/) & Supertest

---

## ⚖️ License
ISC License - Feel free to use and modify for your own projects.
