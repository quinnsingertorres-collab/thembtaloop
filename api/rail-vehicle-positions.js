// Vercel serverless function — proxies MBTA's enhanced GTFS-realtime rail
// vehicle-positions feed from its S3 mirror (a separate hosting path from
// cdn.mbta.com). The client combines this with the primary
// api-v3.mbta.com /vehicles call on every poll — not just when that call
// fails — taking whichever source last observed each vehicle more
// recently, so a lag or gap on either path alone doesn't show up as
// stale or missing data. See mergeVehicleFeeds in index.html.
//
// This S3 bucket doesn't send an Access-Control-Allow-Origin header either
// (confirmed by request), so — same rationale as enhanced-vehicle-positions.js
// — this fetches it server-side and hands the JSON back same-origin.
//
// No API key required; this feed is public. Covers Red, Orange, Blue,
// Green-B/C/D/E, and Mattapan in one response (route_id values match
// MBTA v3's route ids exactly), with position (lat/lon), current_status,
// stop_id, direction_id, and per-carriage occupancy — full parity with
// what this app already gets from api-v3.mbta.com for those lines.
module.exports = async function handler(req, res) {
  try {
    const upstream = await fetch('https://mbta-gtfs-s3.s3.amazonaws.com/rtr/VehiclePositions_enhanced.json');
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    // Checked by hand against the live S3 object: its Last-Modified header
    // actually advances about once per second, much faster than the ~10s
    // cadence assumed elsewhere in this app for MBTA's v3 REST API. s-maxage
    // controls how often Vercel's edge re-invokes this function at all
    // (every request within the window is served the cached copy for free,
    // regardless of how many clients are polling) — so this is the one
    // knob that actually controls freshness here, not the client's own
    // poll interval.
    //
    // Was 10s, then 5s, then 3s; confirmed against real Vercel usage (37k
    // invocations account-wide after a full month at 10s — nowhere near
    // the Hobby plan's shared 1M/mo budget across all three /api proxies
    // in this directory) that there was plenty of room to keep going
    // lower. Now at 1s, matching the S3 object's own actual update
    // cadence exactly — this is the real floor; setting it any lower
    // couldn't produce fresher data since the source itself doesn't
    // change any faster than this. Even a pessimistic worst-case-scaling
    // estimate (invocations scaling a full 10x from the 10s baseline)
    // lands this endpoint under half the account's monthly budget on its
    // own. Re-check the Vercel dashboard's Usage tab after this runs for
    // a while to confirm real-world numbers stay comfortable.
    res.setHeader('Cache-Control', 's-maxage=1, stale-while-revalidate=3');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch upstream rail vehicle-positions feed' });
  }
};
