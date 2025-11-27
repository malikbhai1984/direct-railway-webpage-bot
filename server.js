// server.js
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 8080;

// In-memory store
let messages = [];    // { id, sender, text, ts }
let clients = [];     // SSE response objects

// -------------------------
// Helper: broadcast message
// -------------------------
function sendMessage(sender, text) {
  const msg = {
    id: Date.now(),
    sender,
    text,
    ts: new Date().toISOString()
  };

  messages.push(msg);

  // keep messages limited to last 200 (avoid memory bloat)
  if (messages.length > 200) messages = messages.slice(-200);

  // send to SSE clients
  clients.forEach(res => {
    try {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    } catch (err) {
      // ignore broken clients; they'll be removed on close
    }
  });

  console.log("Sent:", msg.sender, msg.text);
  return msg;
}

// -------------------------
// Simple fallback generator
// -------------------------
function randomFootballPrediction() {
  const teams = [
    "Barcelona", "Real Madrid", "Chelsea", "Manchester United",
    "Manchester City", "Liverpool", "Arsenal", "PSG", "Bayern", "Juventus",
    "Inter", "AC Milan", "Tottenham", "Atletico Madrid"
  ];
  const patterns = [
    "will win today",
    "may score 2+ goals",
    "will keep a clean sheet",
    "might concede first goal",
    "could dominate possession",
    "likely to score late",
    "may struggle in first half",
    "will create more chances",
    "likely to win by 1 goal",
    "may surprise with strong attack"
  ];

  const t = teams[Math.floor(Math.random() * teams.length)];
  const p = patterns[Math.floor(Math.random() * patterns.length)];
  return `${t} ${p}.`;
}

// -------------------------
// Optionally fetch from real API (if API_KEY set)
// -------------------------
async function getFootballPredictionFromAPI() {
  // Example using RapidAPI api-football (you must set API_KEY in Railway variables)
  const key = process.env.API_KEY;
  if (!key) return null;

  try {
    const res = await axios.get(
      "https://api-football-v1.p.rapidapi.com/v3/fixtures?live=all",
      {
        headers: {
          "x-rapidapi-key": key,
          "x-rapidapi-host": "api-football-v1.p.rapidapi.com"
        },
        timeout: 8000
      }
    );

    // Parse a simple human-friendly message from response if matches exist
    const data = res.data;
    if (data && data.response && data.response.length > 0) {
      // pick first live fixture and craft a short prediction-like message
      const f = data.response[0];
      const home = f.teams.home.name || "Home";
      const away = f.teams.away.name || "Away";
      return `Live: ${home} vs ${away} — watch for goals (auto update).`;
    }

    // no live fixtures → return null to fallback
    return null;
  } catch (err) {
    console.log("API fetch failed:", err.message);
    return null;
  }
}

// -------------------------
// Cron job: every 5 minutes
// -------------------------
cron.schedule("*/5 * * * *", async () => {
  console.log("⏳ Running prediction job at", new Date().toLocaleString());

  // try API first
  const apiMsg = await getFootballPredictionFromAPI();
  const text = apiMsg || randomFootballPrediction();
  sendMessage("FOOTBALL-BOT", text);
});

// -------------------------
// SSE endpoint for frontend
// -------------------------
app.get("/events", (req, res) => {
  res.set({
    "Cache-Control": "no-cache",
    "Content-Type": "text/event-stream",
    Connection: "keep-alive"
  });
  res.flushHeaders && res.flushHeaders();

  // send existing recent messages first
  messages.forEach(m => {
    res.write(`data: ${JSON.stringify(m)}\n\n`);
  });

  // add to clients
  clients.push(res);
  console.log("SSE client connected. Clients:", clients.length);

  // remove on close
  req.on("close", () => {
    clients = clients.filter(c => c !== res);
    console.log("SSE client disconnected. Clients:", clients.length);
  });
});

// -------------------------
// Manual message POST (optional admin)
// -------------------------
app.post("/message", (req, res) => {
  const { sender = "USER", text } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ ok: false, error: "text is required" });
  }
  const m = sendMessage(sender, text);
  res.json({ ok: true, message: m });
});

// -------------------------
// Simple home & prediction endpoints
// -------------------------
app.get("/", (req, res) => {
  res.send("Football Auto Prediction Server is Running Successfully!");
});

app.get("/prediction", async (req, res) => {
  // return last 10 messages
  const last = messages.slice(-10).reverse();
  res.json({ ok: true, last });
});

// -------------------------
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
