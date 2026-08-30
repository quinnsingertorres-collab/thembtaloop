// Vercel serverless function — proxies Swiftly's real-time Vehicles API.
//
// This exists for two reasons: (1) Swiftly's API key is a real secret tied
// to a paid dashboard account (unlike MBTA's v3 key, which is safe to ship
// client-side), so it must never appear in index.html or in chat — it's
// read here from a server-side environment variable. (2) it lets the
// client call a same-origin path instead of managing CORS against
// api.goswift.ly directly.
//
// Required environment variables (set in the Vercel project dashboard —
// Project Settings -> Environment Variables — not in any committed file):
//   SWIFTLY_API_KEY    the Swiftly API key from the Swiftly dashboard
//                       ("API Guide" page). Required — the function returns
//                       a clear "not configured" response if it's missing,
//                       rather than failing confusingly downstream.
//   SWIFTLY_AGENCY_KEY  optional, defaults to "mbta". This is the agency
//                       key from the Swiftly dashboard URL
//                       (dashboard.goswift.ly/<agencyKey>). Only override
//                       this if MBTA's actual Swiftly agency key differs.
//
// Swiftly API reference: https://docs.goswift.ly/docs/realtime-standalone/d08fc97489edb-swiftly-api-reference
//   GET https://api.goswift.ly/real-time/{agencyKey}/vehicles
//   Auth header: Authorization: <key>   (no "Bearer" prefix)
//
// Known limitation (confirmed via research, not a bug): MBTA's Swiftly
// deployment covers bus and commuter rail only, not subway/light rail.
// Calls filtered to Green/Red/Orange/Blue/Mattapan route ids will
// therefore return an empty vehicle list today. This proxy and the
// client-side fallback/merge logic that calls it are still fully wired up
// so that if MBTA ever extends Swiftly coverage to the subway, the app
// picks it up automatically with no further code changes.
module.exports = async function handler(req, res) {
  const apiKey = process.env.SWIFTLY_API_KEY;
  if (!apiKey) {
    res.status(501).json({ error: 'Swiftly integration not configured (SWIFTLY_API_KEY missing)' });
    return;
  }
  const agencyKey = process.env.SWIFTLY_AGENCY_KEY || 'mbta';
  const route = typeof req.query.route === 'string' ? req.query.route : '';

  let url = `https://api.goswift.ly/real-time/${encodeURIComponent(agencyKey)}/vehicles?unassigned=true`;
  if (route) url += `&route=${encodeURIComponent(route)}`;

  try {
    const upstream = await fetch(url, {
      headers: { Authorization: apiKey, Accept: 'application/json' }
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    // Short edge cache, same rationale as enhanced-vehicle-positions.js —
    // avoids a 1:1 hit on Swiftly's API for every client poll.
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch upstream Swiftly feed' });
  }
};
