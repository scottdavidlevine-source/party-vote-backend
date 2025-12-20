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

// ---------------- Spotify Helper ----------------
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
}

// Refresh every 50 minutes
setInterval(refreshSpotifyToken, 50 * 60 * 1000);

// ---------------- Poll Spotify + Track Song Lifecycle ----------------
let lastTrackId = null;

setInterval(async () => {
  try {
    const res = await spotifyRequest(
      "get",
      "https://api.spotify.com/v1/me/player/currently-playing"
    );

    if (!res.data?.item) return;

    const track = res.data.item;
    const currentTrackId = track.id;

    // 🔁 Detect natural song end
    if (lastTrackId && lastTrackId !== currentTrackId) {
      const { data: previousSong } = await supabase
        .from("current_song")
        .select("*")
        .eq("party_id", PARTY_ID)
        .single();

      if (previousSong) {
        await supabase.from("song_history").insert({
          party_id: PARTY_ID,
          spotify_track_id: previousSong.spotify_track_id,
          track_name: previousSong.track_name,
          artist: previousSong.artist,
          downvotes: previousSong.downvotes,
          skipped: false,
          ended_at: new Date(),
        });

        // Clear votes for previous song
        await supabase
          .from("votes")
          .delete()
          .eq("party_id", PARTY_ID)
          .eq("spotify_track_id", previousSong.spotify_track_id);
      }
    }

    lastTrackId = currentTrackId;

    // 🎶 Upsert current song
    await supabase
      .from("current_song")
      .upsert(
        {
          party_id: PARTY_ID,
          spotify_track_id: track.id,
          track_name: track.name,
          artist: track.artists[0].name,
          upvotes: 0,
          downvotes: 0,
        },
        { onConflict: "party_id" }
      );

  } catch (err) {
    console.error("Polling error:", err.response?.data || err.message);
  }
}, 5000);

// ---------------- Current Song ----------------
app.get("/current", async (req, res) => {
  const { data } = await supabase
    .from("current_song")
    .select("*")
    .eq("party_id", PARTY_ID)
    .single();

  res.json(data || {});
});

// ---------------- Vote Endpoint ----------------
app.post("/vote", async (req, res) => {
  const { device_id, vote } = req.body;

  if (!device_id || !["up", "down"].includes(vote)) {
    return res.status(400).json({ error: "Invalid vote" });
  }

  try {
    const { data: song } = await supabase
      .from("current_song")
      .select("*")
      .eq("party_id", PARTY_ID)
      .single();

    if (!song) {
      return res.status(404).json({ error: "No song playing" });
    }

    // ⛔ Prevent double voting
    const { error: voteError } = await supabase.from("votes").insert({
      party_id: PARTY_ID,
      spotify_track_id: song.spotify_track_id,
      device_id,
      vote,
    });

    if (voteError) {
      return res.status(409).json({ error: "Already voted" });
    }

    let upvotes = song.upvotes;
    let downvotes = song.downvotes;

    if (vote === "up") upvotes++;
    else downvotes++;

    await supabase
      .from("current_song")
      .update({ upvotes, downvotes })
      .eq("party_id", PARTY_ID);

    let skipped = false;

    // ⏭ Skip logic
    if (downvotes >= DOWNVOTE_THRESHOLD) {
      skipped = true;

      await spotifyRequest(
        "post",
        "https://api.spotify.com/v1/me/player/next"
      );

      // 🧾 Write song history
      await supabase.from("song_history").insert({
        party_id: PARTY_ID,
        spotify_track_id: song.spotify_track_id,
        track_name: song.track_name,
        artist: song.artist,
        downvotes,
        skipped: true,
        ended_at: new Date(),
      });

      // Reset current song
      await supabase
        .from("current_song")
        .update({ upvotes: 0, downvotes: 0 })
        .eq("party_id", PARTY_ID);

      // Clear votes
      await supabase
        .from("votes")
        .delete()
        .eq("party_id", PARTY_ID)
        .eq("spotify_track_id", song.spotify_track_id);
    }

    res.json({
      success: true,
      upvotes,
      downvotes,
      remaining_to_skip: Math.max(DOWNVOTE_THRESHOLD - downvotes, 0),
      skipped,
    });
  } catch (err) {
    console.error("Vote error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ---------------- Party Analytics ----------------
app.get("/analytics", async (req, res) => {
  const { data: history } = await supabase
    .from("song_history")
    .select("*")
    .eq("party_id", PARTY_ID)
    .order("ended_at", { ascending: false });

  const totalSongs = history.length;
  const skippedSongs = history.filter(h => h.skipped).length;

  res.json({
    total_songs: totalSongs,
    skipped_songs: skippedSongs,
    skip_rate: totalSongs
      ? Math.round((skippedSongs / totalSongs) * 100)
      : 0,
    history,
  });
});

// ---------------- Start Server ----------------
async function start() {
  await refreshSpotifyToken();
  app.listen(PORT, () =>
    console.log(`Party-vote backend running on port ${PORT}`)
  );
}

start();
