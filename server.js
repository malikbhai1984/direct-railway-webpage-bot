const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

let messages = [];
let clients = [];

const PORT = process.env.PORT || 3000;

// SSE endpoint
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  clients.push(res);

  // send old messages
  messages.forEach(m => res.write(`data: ${JSON.stringify(m)}\n\n`));

  req.on("close", () => {
    clients = clients.filter(c => c !== res);
  });
});

// Send message function
function sendMessage(sender, text) {
  const msg = {
    id: Date.now(),
    sender,
    text,
    ts: new Date().toLocaleString()
  };

  messages.push(msg);

  clients.forEach(c => c.write(`data: ${JSON.stringify(msg)}\n\n`));
}

// FOOTBALL PREDICTION GENERATOR
function generateFootballPrediction() {
  const teams = [
    "Barcelona", "Real Madrid", "Chelsea", "Manchester United", 
    "Manchester City", "Liverpool", "Arsenal", "PSG", "Bayern", "Juventus"
  ];

  const outcomes = [
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

  const t1 = teams[Math.floor(Math.random() * teams.length)];
  const outcome = outcomes[Math.floor(Math.random() * outcomes.length)];

  return `${t1} ${outcome}.`;
}

// AUTO MESSAGE EVERY 5 MINUTES
setInterval(() => {
  const prediction = generateFootballPrediction();
  sendMessage("FOOTBALL-BOT", prediction);
}, 5 * 60 * 1000); // 5 minutes

// Home
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.listen(PORT, () => console.log("Server running on port", PORT));
