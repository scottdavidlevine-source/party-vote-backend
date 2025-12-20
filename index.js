const BASE_URL = "https://YOUR-BACKEND.onrender.com"; // 🔧 CHANGE THIS
const DOWNVOTE_THRESHOLD = 5;

const songEl = document.getElementById("song");
const artistEl = document.getElementById("artist");
const downvotesEl = document.getElementById("downvotes");
const fillEl = document.getElementById("fill");
const statusEl = document.getElementById("vote-status");
const upBtn = document.getElementById("upBtn");
const downBtn = document.getElementById("downBtn");
const leaderboardEl = document.getElementById("leaderboard");

const deviceId =
  localStorage.device_id ||
  (localStorage.device_id = crypto.randomUUID());

let lastTrackId = null;
let hasVoted = false;

// ---------------- Load Current Song ----------------
async function loadCurrent() {
  const res = await fetch(`${BASE_URL}/current`);
  const data = await res.json();

  if (!data.spotify_track_id) return;

  songEl.textContent = data.track_name;
  artistEl.textContent = data.artist;
  downvotesEl.textContent = `👎 ${data.downvotes} downvotes`;

  fillEl.style.width =
    `${(data.downvotes / DOWNVOTE_THRESHOLD) * 100}%`;

  // New song → reset voting state
  if (lastTrackId !== data.spotify_track_id) {
    hasVoted = false;
    upBtn.disabled = false;
    downBtn.disabled = false;
    statusEl.textContent = "";
    lastTrackId = data.spotify_track_id;
  }
}

// ---------------- Vote ----------------
async function vote(type) {
  if (hasVoted) return;

  statusEl.textContent = "Submitting vote…";

  const res = await fetch(`${BASE_URL}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_id: deviceId,
      vote: type,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    statusEl.textContent = data.error || "Vote failed";
    return;
  }

  hasVoted = true;
  upBtn.disabled = true;
  downBtn.disabled = true;

  downvotesEl.textContent = `👎 ${data.downvotes} downvotes`;
  fillEl.style.width =
    `${((DOWNVOTE_THRESHOLD - data.remaining) / DOWNVOTE_THRESHOLD) * 100}%`;

  statusEl.textContent =
    type === "down" ? "👎 Downvote counted" : "👍 Upvote counted";
}

// ---------------- Leaderboard ----------------
async function loadLeaderboard() {
  const res = await fetch(`${BASE_URL}/analytics/most-downvoted`);
  const data = await res.json();

  leaderboardEl.innerHTML = "";

  if (!data.length) {
    leaderboardEl.innerHTML = "<div>No data yet</div>";
    return;
  }

  data.forEach((song, index) => {
    const div = document.createElement("div");
    div.className = "leaderboard-item";
    div.innerHTML = `
      <span>${index + 1}. ${song.track_name}</span>
      <strong>👎 ${song.total}</strong>
    `;
    leaderboardEl.appendChild(div);
  });
}

// ---------------- Init ----------------
loadCurrent();
loadLeaderboard();

setInterval(loadCurrent, 5000);
setInterval(loadLeaderboard, 20000);
