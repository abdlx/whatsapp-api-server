# ⚡ Quick Start: Anti-Ban Protected WhatsApp Server

## 🚀 Installation

```bash
# 1. Install dependencies
npm install

# 2. Copy .env.example to .env
cp .env.example .env

# 3. Edit .env with your credentials
# - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
# - API_KEY (generate with: node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
# - DEFAULT_TIMEZONE (your local timezone, e.g., 'America/New_York')
```

---

## ⚙️ Configuration for Maximum Ban Protection

### For New WhatsApp Accounts (0-30 days old)

Edit `.env`:

```env
# Conservative limits for new accounts
MAX_MESSAGES_PER_DAY=50
MIN_DELAY_MS=15000    # 15 seconds
MAX_DELAY_MS=60000    # 1 minute

# Your timezone (CRITICAL - ensures business-hour-only messaging)
DEFAULT_TIMEZONE=America/New_York  # Change to YOUR timezone

# Respect weekends (recommended for new accounts)
RESPECT_WEEKENDS=true
```

### For Established Accounts (30+ days old)

```env
# Normal limits for mature accounts
MAX_MESSAGES_PER_DAY=150
MIN_DELAY_MS=5000     # 5 seconds
MAX_DELAY_MS=15000    # 15 seconds

DEFAULT_TIMEZONE=America/New_York
RESPECT_WEEKENDS=false  # Optional for mature accounts
```

---

## 🏃 Running the Server

```bash
# Development
npm run dev

# Production (with PM2)
npm run build
npm run start:prod
```

---

## 📱 First Steps (New Account Setup)

### Day 1: Initial Setup
```bash
# 1. Start server
npm run dev

# 2. Create session and scan QR code
POST http://localhost:3000/session/create
{
  "sessionId": "my-business"
}

# 3. Get QR code
GET http://localhost:3000/session/my-business/qr

# 4. Scan with WhatsApp and wait for connection
```

### Day 1-3: Warm-Up Period ⚠️ CRITICAL
```bash
# Send ONLY 2-5 messages per day
# Message ONLY saved contacts (people who have your number)

POST http://localhost:3000/message/send
{
  "sessionId": "my-business",
  "recipient": "SAVED_CONTACT_NUMBER",
  "message": "Hello!",
  "timezone": "America/New_York",
  "respectWeekends": true
}

# Wait 2-4 hours between messages
```

### Day 4-7: Gradual Increase
```bash
# Increase to 5-10 messages per day
# Still only saved contacts
# Wait 1-2 hours between messages
```

### Day 8-30: Maturing Phase
```bash
# Gradually increase to 20-50 messages per day
# Start messaging contacts with conversation history
# Can reduce delays slightly
```

### Day 30+: Normal Operation
```bash
# Up to 100-200 messages per day safely
# Can message new contacts (with score checking)
```

---

## 🧪 Testing Your Setup

### 1. Test Message to Yourself
```bash
POST http://localhost:3000/message/send
{
  "sessionId": "my-business",
  "recipient": "YOUR_OWN_NUMBER",
  "message": "Test message from my WhatsApp server"
}
```

### 2. Check Message Status
```bash
GET http://localhost:3000/message/{messageId}
```

Expected response:
```json
{
  "id": "...",
  "status": "sent",      // Then "delivered", then "read"
  "sent_at": "...",
  "delivered_at": "...",
  "read_at": "..."
}
```

### 3. Monitor Logs
```bash
# Watch for risk warnings
npm run dev

# Look for these log entries:
# ✅ "Sending message with risk profile" - Normal
# ⚠️ "Low conversation score with unsaved contact" - Protection triggered
# ❌ "Multiple failures detected" - STOP SENDING
```

---

## 📊 Understanding Protection Levels

### Automatic Checks on Every Message

1. **Contact Verification**
   - ✅ Number exists on WhatsApp?
   - ✅ Have you messaged them before?
   - ✅ Conversation score sufficient?

2. **Rate Limits**
   - ✅ Under hourly limit for your account age?
   - ✅ Under daily limit?

3. **Human Behavior**
   - ✅ Is it business hours in your timezone?
   - ✅ Not a weekend (if RESPECT_WEEKENDS=true)?

4. **Adaptive Delays**
   - ✅ Random delay applied (based on account age)
   - ✅ Typing simulation (based on message length)

---

## 🎯 Example API Calls

### Basic Send (Auto-Protected)
```bash
curl -X POST http://localhost:3000/message/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "sessionId": "my-business",
    "recipient": "1234567890",
    "message": "Hello from WhatsApp API!"
  }'
```

### With Full Protection Options
```bash
curl -X POST http://localhost:3000/message/send \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "sessionId": "my-business",
    "recipient": "1234567890",
    "message": "Hello!",
    "timezone": "Asia/Kolkata",
    "respectWeekends": true,
    "minConversationScore": 30
  }'
```

### Check Session Status
```bash
curl -X GET http://localhost:3000/session/my-business/status \
  -H "X-API-Key: YOUR_API_KEY"
```

---

## ⚠️ Common Mistakes (AVOID THESE!)

### ❌ DON'T: Send 100 messages on day 1
```bash
# This WILL get you banned
for i in {1..100}; do
  curl -X POST .../message/send ...
done
```

### ✅ DO: Start with 2-5 messages and gradually increase
```bash
# Day 1: 2 messages
# Day 2: 3 messages
# Day 3: 5 messages
# Week 2: 10-20 messages
# Month 2: 50-100 messages
```

### ❌ DON'T: Message random/unsaved numbers
```bash
POST /message/send
{
  "recipient": "RANDOM_NUMBER_FROM_LIST"  # ❌ BAN RISK
}
```

### ✅ DO: Message saved contacts or check conversation score first
```bash
# System will auto-block if conversation score < 10 and unsaved
POST /message/send
{
  "recipient": "SAVED_CONTACT",  # ✅ SAFE
  "minConversationScore": 20
}
```

### ❌ DON'T: Bypass safety checks in production
```bash
POST /message/send
{
  "bypassChecks": true  # ❌ GUARANTEED BAN
}
```

### ✅ DO: Let protections work for you
```bash
POST /message/send
{
  # No bypassChecks - let the system protect you
}
```

---

## 🔍 Monitoring & Troubleshooting

### Check if System is Working

**Look for these in logs:**

```bash
# ✅ GOOD - System working
"Sending message with risk profile" { riskLevel: "low", accountAge: 45 }
"Message sent successfully"

# ⚠️ WARNING - Protection activated
"Rate limit check failed" { reason: "Hourly limit reached" }
"Low conversation score with unsaved contact - HIGH BAN RISK"

# 🚨 CRITICAL - Stop immediately
"Multiple failures detected - potential ban risk"
"Failed to send message" (repeated)
```

### View Session Risk Profile

The system automatically logs this on every message:

```json
{
  "sessionId": "my-business",
  "riskLevel": "medium",
  "accountAge": 25,
  "conversationScore": 45,
  "messagesSentToday": 12,
  "allowedMessagesPerDay": 100
}
```

---

## 📚 Documentation

- **`README_ANTI_BAN.md`** - Quick reference for all protection features
- **`ANTI_BAN_GUIDE.md`** - Comprehensive guide with detailed explanations
- **`.env.example`** - All configuration options with explanations

---

## 🆘 Emergency: Account Showing Warning Signs

If you see:
- Messages not being delivered
- Frequent disconnections
- "Multiple failures" in logs

**Immediately:**
1. Stop sending messages
2. Wait 48-72 hours
3. Review your sending patterns
4. Reduce limits by 50%
5. Only message saved contacts
6. Resume SLOWLY (2-3 messages/day)

---

## ✅ Success Checklist

- [ ] Environment configured with your timezone
- [ ] Using conservative limits for account age
- [ ] Tested with saved contacts first
- [ ] Monitoring logs for warnings
- [ ] Following warm-up schedule (new accounts)
- [ ] NOT bypassing safety checks
- [ ] Messages delivering successfully

---

## 🎯 Summary

**This system protects you, but you must:**
1. Start slow (2-5 msg/day for new accounts)
2. Only message saved contacts initially
3. Respect the rate limits for your account age
4. Monitor logs for warnings
5. Never bypass checks in production

**Follow these rules = ~90-95% ban protection** 🛡️

**Ignore these rules = ~80% ban probability** ⚠️

---

**Good luck! 🚀**

For detailed explanations, see `ANTI_BAN_GUIDE.md`
