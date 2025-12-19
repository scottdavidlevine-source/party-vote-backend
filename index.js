import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PARTY_ID = process.env.PARTY_ID;
const DOWNVOTE_THRESHOLD = parseInt(process.env.DOWNVOTE_THRESHOLD || "5");

// Spotify tokens (refreshable)
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

// ---------------- Token Refresh ----------------
async function refreshSpotifyToken() {
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", spotifyTokens.refresh_token);
  const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64");

  try {
    const res = await axios.post("https://accounts.spotify.com/api/token", params, {
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    spotifyTokens.access_token = res.data.access_token;
    console.log("Spotify token refreshed");
  } catch (err) {
    console.error("Error refreshing Spotify token", err.response?.data || err.message);
  }
}

// Refresh token every 50 minutes
setInterval(refreshSpotifyToken, 50 * 60 * 1000);

// ---------------- Poll Spotify ----------------
setInterval(async () => {
  try {
    // 1️⃣ Currently playing track
    const res = await spotifyRequest("get", "https://api.spotify.com/v1/me/player/currently-playing");
    if (!res.data || !res.data.item) return;

    const track = res.data.item;
    console.log("Currently playing:", track.name, track.artists[0].name);

    // 2️⃣ Fetch playlist to get added_by
    const playlistId = process.env.SPOTIFY_PLAYLIST_ID;
    let addedBy = "Unknown";

    if (playlistId) {
      let allTracks = [];
      let offset = 0;
      const limit = 100;
      let total = 1;

      while (allTracks.length < total) {
        const playlistRes = await spotifyRequest(
          "get",
          `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
          {
            params: {
              limit,
              offset,
              fields: "items(track(id,name,artists),added_by.display_name),total",
            },
          }
        );

        const items = playlistRes.data.items;
        if (!items) break;

        allTracks.push(...items);
        total = playlistRes.data.total;
        offset += limit;
      }

      const item = allTracks.find(i => i.track.id === track.id);
      if (item && item.added_by) addedBy = item.added_by.display_name || "Unknown";
    }

    // 3️⃣ Upsert into Supabase
    const { data, error } = await supabase.from("current_song").upsert({
      party_id: PARTY_ID,
      spotify_track_id: track.id,
      track_name: track.name,
      artist: track.artists[0].name,
      upvotes: 0,
      downvotes: 0,
      added_by: addedBy,
    }).select();

    if (error) console.error("Supabase upsert error:", error);
    else console.log("Upserted:", data);

  } catch (err) {
    console.error("Polling error:", err.response?.data || err.message);
  }
}, 5000);

// ---------------- Voting Endpoint ----------------
app.post("/vote", async (req, res) => {
  const { device_id, vote } = req.body;
  if (!device_id || !["up", "down"].includes(vote)) return res.status(400).send({ error: "Invalid vote" });

  try {
    // Fetch current song
    const { data: songs } = await supabase
      .from("current_song")
      .select("*")
      .eq("party_id", PARTY_ID)
      .limit(1);

    if (!songs || songs.length === 0) return res.status(404).send({ error: "No current song" });
    const song = songs[0];

    // Update votes
    let upvotes = song.upvotes;
    let downvotes = song.downvotes;
    if (vote === "up") upvotes++;
    else downvotes++;

    await supabase.from("current_song").update({ upvotes, downvotes }).eq("spotify_track_id", song.spotify_track_id);

    // Check downvote threshold
    if (downvotes >= DOWNVOTE_THRESHOLD) {
      console.log("Downvote threshold hit, skipping song...");

      try {
        await spotifyRequest("post", `https://api.spotify.com/v1/me/player/next`);
      } catch (skipErr) {
        console.error("Spotify skip error:", skipErr.response?.data || skipErr.message);
      }

      // Reset votes in Supabase
      await supabase.from("current_song").update({ upvotes: 0, downvotes: 0 }).eq("spotify_track_id", song.spotify_track_id);
    }

    res.send({ success: true, upvotes, downvotes });
  } catch (err) {
    console.error("Vote error:", err.response?.data || err.message);
    res.status(500).send({ error: "Internal error" });
  }
});

app.listen(PORT, () => console.log(`Party-vote backend running on port ${PORT}`));
