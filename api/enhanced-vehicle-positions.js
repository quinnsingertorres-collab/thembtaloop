// Vercel serverless function — proxies MBTA's enhanced GTFS-realtime feed.
//
// cdn.mbta.com doesn't send an Access-Control-Allow-Origin header, so
// browsers refuse to let client-side JS read the response at all (that's
// enforced by the browser itself, not fixable from our own frontend code).
// Server-to-server requests aren't subject to CORS, so this function fetches
// the feed here and hands the JSON back from our own origin — the client
// then just calls /api/enhanced-vehicle-positions same-origin, no CORS
// involved on that hop either.
//
// Deploy location: this file must live at /api/enhanced-vehicle-positions.js
// in the repo root (sibling to index.html) — Vercel auto-detects anything
// under /api as a serverless function with zero extra config.
module.exports = async function handler(req, res) {
  try {
    const upstream = await fetch('https://cdn.mbta.com/realtime/VehiclePositions_enhanced.json');
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    // Short edge cache so a burst of client polls (every 15s per browser tab)
    // doesn't turn into a 1:1 hit on MBTA's feed for every single one.
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch upstream feed' });
  }
};
