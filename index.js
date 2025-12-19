import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---------------- Supabase ----------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PARTY_ID = process.env.PARTY_ID;
const DOWNVOTE_THRESHOLD = parseInt(process.env.DOWNVOTE_THRESHOLD || "5");

// ---------------- Spotify Tokens ----------------
let spotifyTokens = {
  access_token: process.env.SPOTIFY_ACCESS_TOKEN,
  refresh_token: process.env.SPOTIFY_REFRESH_TOKEN,
};

// ---------------- Spotify API Helper ----------------
async function spotifyRequest(method, url, config = {}) {
  return axios({
    method,
    url,
    headers: {
      Authorization: `Bearer ${spotifyTokens.access_token}`,
    },
    ...config,
  });
}

// ---------------- Refresh Spotify Token ----------------
async function refreshSpotifyToken() {
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", spotifyTokens.refresh_token);

  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  try {
    const res = await axios.post(
      "https://accounts.spotify.com/api/token",
      params,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    spotifyTokens.access_token = res.data.access_token;
    console.log("Spotify token refreshed");
  } catch (err) {
    console.error(
      "Error refreshing Spotify token:",
      err.response?.data || err.message
    );
  }
}

// Refresh every 50 minutes
setInterval(refreshSpotifyToken, 50 * 60 * 1000);

// ---------------- Poll Spotify ----------------
setInterval(async () => {
  try {
    console.log("Polling Spotify…");

    const res = await spotifyRequest(
      "get",
      "https://api.spotify.com/v1/me/player/currently-playing"
    );

    if (!res.data || !res.data.item) return;

    const track = res.data.item;
    console.log("Currently playing:", track.name, "-", track.artists[0].name);

    const playlistId = process.env.SPOTIFY_PLAYLIST_ID;
    let addedBy = "Auto / Queue";

    // Attempt to resolve added_by only if from playlist
    if (
      playlistId &&
      res.data.context?.type === "playlist" &&
      res.data.context?.uri?.includes(playlistId)
    ) {
      let offset = 0;
      const limit = 100;
      let total = 1;
      let allTracks = [];

      while (allTracks.length < total) {
        const playlistRes = await spotifyRequest(
          "get",
          `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
          {
            params: {
              limit,
              offset,
              fields: "items(track(id),added_by.display_name),total",
            },
          }
        );

        const items = playlistRes.data.items || [];
        allTracks.push(...items);
        total = playlistRes.data.total;
        offset += limit;
      }

      const match = allTracks.find(
        (i) => i.track?.id === track.id
      );

      if (match?.added_by?.display_name) {
        addedBy = match.added_by.display_name;
      }
    }

    const payload = {
      party_id: PARTY_ID,
      spotify_track_id: track.id,
      track_name: track.name,
      artist: track.artists[0].name,
      upvotes: 0,
      downvotes: 0,
      added_by: addedBy,
    };

    const { data, error } = await supabase
      .from("current_song")
      .upsert(payload, { onConflict: "party_id" })
      .select();

    if (error) {
      console.error("Supabase upsert error:", error);
    } else {
      console.log("Upserted row:", data);
    }
  } catch (err) {
    console.error(
      "Polling error:",
      err.response?.data || err.message
    );
  }
}, 5000);

// ---------------- Current Song Endpoint ----------------
app.get("/current", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("current_song")
      .select("*")
      .eq("party_id", PARTY_ID)
      .order("updated_at", { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) {
      return res.json({});
    }

    res.json(data[0]);
  } catch (err) {
    console.error("Current endpoint error:", err);
    res.status(500).json({});
  }
});

// ---------------- Voting Endpoint ----------------
app.post("/vote", async (req, res) => {
  const { device_id, vote } = req.body;

  if (!device_id || !["up", "down"].includes(vote)) {
    return res.status(400).json({ error: "Invalid vote" });
  }

  try {
    const { data } = await supabase
      .from("current_song")
      .select("*")
      .eq("party_id", PARTY_ID)
      .limit(1);

    if (!data || data.length === 0) {
      return res.status(404).json({ error: "No current song" });
    }

    const song = data[0];

    let upvotes = song.upvotes;
    let downvotes = song.downvotes;

    if (vote === "up") upvotes++;
    else downvotes++;

    await supabase
      .from("current_song")
      .update({ upvotes, downvotes })
      .eq("party_id", PARTY_ID);

    if (downvotes >= DOWNVOTE_THRESHOLD) {
      console.log("Downvote threshold hit — skipping song");

      try {
        await spotifyRequest(
          "post",
          "https://api.spotify.com/v1/me/player/next"
        );
      } catch (err) {
        console.error("Spotify skip error:", err.response?.data || err.message);
      }

      await supabase
        .from("current_song")
        .update({ upvotes: 0, downvotes: 0 })
        .eq("party_id", PARTY_ID);
    }

    res.json({ success: true, upvotes, downvotes });
  } catch (err) {
    console.error("Vote error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ---------------- Start Server ----------------
async function start() {
  await refreshSpotifyToken();

  app.listen(PORT, () => {
    console.log(`Party-vote backend running on port ${PORT}`);
  });
}

start();
