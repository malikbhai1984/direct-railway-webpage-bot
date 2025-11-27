const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

// Static serve — your existing index.html will load automatically
app.use(express.static(path.join(__dirname)));

// Prediction API — yahan se frontend har 5 min data lega
app.get("/prediction", async (req, res) => {
  try {
    // Yahan aap apni football API laga sakte ho
    const predictionText = "Auto Football Prediction: Team A vs Team B — Over 2.5 Goals";

    res.json({ prediction: predictionText });
  } catch (err) {
    res.json({ prediction: "Error fetching prediction" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
