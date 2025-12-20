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
const PARTY_ID = process.env.PARTY_ID;
const DOWNVOTE_THRESHOLD = Number(process.env.DOWNVOTE_THRESHOLD || 5);

// ---------- Supabase ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Spotify ----------
let spotify = {
  access_token: process.env.SPOTIFY_ACCESS_TOKEN,
  refresh_token: process.env.SPOTIFY_REFRESH_TOKEN,
};

async function spotifyRequest(method, url) {
  return axios({
    method,
    url,
    headers: { Authorization: `Bearer ${spotify.access_token}` },
  });
}

async function refreshSpotifyToken() {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: spotify.refresh_token,
  });

  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const res = await axios.post(
    "https://accounts.spotify.com/api/token",
    params,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  spotify.access_token = res.data.access_token;
}

setInterval(refreshSpotifyToken, 50 * 60 * 1000);

// ---------- Poll Spotify ----------
let lastTrackId = null;

setInterval(async () => {
  try {
    const res = await spotifyRequest(
      "get",
      "https://api.spotify.com/v1/me/player/currently-playing"
    );

    if (!res.data?.item) return;

    const track = res.data.item;

    // Detect song change (natural end)
    if (lastTrackId && lastTrackId !== track.id) {
      const { data: prev } = await supabase
        .from("current_song")
        .select("*")
        .eq("party_id", PARTY_ID)
        .single();

      if (prev) {
        await supabase.from("song_history").insert({
          party_id: PARTY_ID,
          spotify_track_id: prev.spotify_track_id,
          track_name: prev.track_name,
          artist: prev.artist,
          downvotes: prev.downvotes,
          skipped: false,
        });

        await supabase
          .from("votes")
          .delete()
          .eq("party_id", PARTY_ID)
          .eq("spotify_track_id", prev.spotify_track_id);
      }
    }

    lastTrackId = track.id;

    // Upsert current song
    await supabase.from("current_song").upsert(
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
    console.error("Polling error:", err.message);
  }
}, 5000);

// ---------- Routes ----------
app.get("/current", async (_, res) => {
  const { data } = await supabase
    .from("current_song")
    .select("*")
    .eq("party_id", PARTY_ID)
    .single();

  res.json(data || {});
});

app.post("/vote", async (req, res) => {
  const { device_id, vote } = req.body;
  if (!device_id || !["up", "down"].includes(vote)) {
    return res.status(400).json({ error: "Invalid vote" });
  }

  const { data: song } = await supabase
    .from("current_song")
    .select("*")
    .eq("party_id", PARTY_ID)
    .single();

  if (!song) return res.status(404).json({});

  const { error } = await supabase.from("votes").insert({
    party_id: PARTY_ID,
    spotify_track_id: song.spotify_track_id,
    device_id,
    vote,
  });

  if (error) return res.status(409).json({ error: "Already voted" });

  const upvotes = song.upvotes + (vote === "up" ? 1 : 0);
  const downvotes = song.downvotes + (vote === "down" ? 1 : 0);

  await supabase
    .from("current_song")
    .update({ upvotes, downvotes })
    .eq("party_id", PARTY_ID);

  let skipped = false;

  if (downvotes >= DOWNVOTE_THRESHOLD) {
    skipped = true;

    await spotifyRequest("post", "https://api.spotify.com/v1/me/player/next");

    await supabase.from("song_history").insert({
      party_id: PARTY_ID,
      spotify_track_id: song.spotify_track_id,
      track_name: song.track_name,
      artist: song.artist,
      downvotes,
      skipped: true,
    });

    await supabase
      .from("votes")
      .delete()
      .eq("party_id", PARTY_ID)
      .eq("spotify_track_id", song.spotify_track_id);

    await supabase
      .from("current_song")
      .update({ upvotes: 0, downvotes: 0 })
      .eq("party_id", PARTY_ID);
  }

  res.json({
    downvotes,
    remaining: Math.max(DOWNVOTE_THRESHOLD - downvotes, 0),
    skipped,
  });
});

app.get("/analytics/most-downvoted", async (_, res) => {
  const { data } = await supabase
    .from("song_history")
    .select("track_name, artist, downvotes")
    .eq("party_id", PARTY_ID);

  const map = {};
  data?.forEach(r => {
    const k = `${r.track_name}__${r.artist}`;
    map[k] ||= { track_name: r.track_name, artist: r.artist, total: 0 };
    map[k].total += r.downvotes || 0;
  });

  res.json(Object.values(map).sort((a, b) => b.total - a.total));
});

// ---------- Start ----------
(async () => {
  await refreshSpotifyToken();
  app.listen(PORT, () => console.log("Backend running"));
})();
