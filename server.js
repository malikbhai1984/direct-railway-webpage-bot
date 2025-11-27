const express = require("express");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json());

// -------------------------------
// HOME ROUTE (Railway Test)
// -------------------------------
app.get("/", (req, res) => {
  res.send("Football Auto Prediction Server is Running Successfully!");
});

// -------------------------------
// AUTO PREDICTION FUNCTION
// -------------------------------
async function getFootballPrediction() {
  try {
    // Example API (aap apna real API yahan lagayenge)
    const response = await axios.get(
      "https://api-football-v1.p.rapidapi.com/v3/fixtures?live=all",
      {
        headers: {
          "x-rapidapi-key": process.env.API_KEY, // Railway variable
          "x-rapidapi-host": "api-football-v1.p.rapidapi.com",
        },
      }
    );

    console.log("Auto Prediction → New Data Received");
    return response.data;
  } catch (error) {
    console.log("Prediction API Error:", error.message);
    return null;
  }
}

// -------------------------------
// CRON JOB: Run Every 5 Minutes
// -------------------------------
cron.schedule("*/5 * * * *", async () => {
  console.log("⏳ Running Prediction every 5 minutes...");

  const data = await getFootballPrediction();

  if (data) {
    console.log("✔️ Prediction Data:", new Date().toLocaleString());
  }
});

// -------------------------------
// API ENDPOINT — Manually get predictions
// -------------------------------
app.get("/prediction", async (req, res) => {
  const data = await getFootballPrediction();
  res.json({ success: true, data });
});

// -------------------------------
// PORT CONFIG FOR RAILWAY
// -------------------------------
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
