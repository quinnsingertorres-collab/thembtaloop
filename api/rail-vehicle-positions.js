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
    // Same short edge cache as the other proxies in this directory.
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch upstream rail vehicle-positions feed' });
  }
};
