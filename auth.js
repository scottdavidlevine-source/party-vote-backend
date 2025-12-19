import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = 3000; // matches your redirect URI

app.get("/callback", async (req, res) => {
  const code = req.query.code || null;
  if (!code) return res.send("No code provided");

  const params = new URLSearchParams();
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", `http://localhost:${PORT}/callback`);

  const authHeader = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  try {
    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      params,
      {
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("✅ Access Token:", response.data.access_token);
    console.log("✅ Refresh Token:", response.data.refresh_token);
    res.send(
      "Tokens received! Check your console. Copy the refresh token to your .env file."
    );
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("Error getting tokens. Check console.");
  }
});

app.listen(PORT, () =>
  console.log(
    `Auth server running on port ${PORT}. Open your Spotify auth URL now.`
  )
);
