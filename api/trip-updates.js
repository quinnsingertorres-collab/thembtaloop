// Vercel serverless function — proxies MBTA's enhanced GTFS-realtime
// TripUpdates feed (predicted arrival/departure time at every upcoming stop
// for every active trip — a different data type from vehicle positions).
// https://cdn.mbta.com/realtime/TripUpdates_enhanced.json
//
// Same CORS gap as the other two enhanced-feed proxies in this directory
// (confirmed by request: no Access-Control-Allow-Origin header), so this
// fetches it server-side and hands the JSON back same-origin. No API key
// required; this feed is public.
//
// The client uses this to show a real predicted "Next stop" time in the
// train info modal (see tripUpdatesCache/refreshTripUpdates in index.html) —
// something the v3 vehicle feeds don't carry themselves.
module.exports = async function handler(req, res) {
  try {
    const upstream = await fetch('https://cdn.mbta.com/realtime/TripUpdates_enhanced.json');
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
      return;
    }
    const data = await upstream.json();
    // Measured by hand against the live feed (5 requests, 3s apart): its
    // Last-Modified header advanced on 4 of those 5 checks, landing roughly
    // every 3-4 seconds — slower than VehiclePositions_enhanced.json's ~1s
    // cadence (see rail-vehicle-positions.js), which makes sense since this
    // is predictions recomputed from the same underlying trip data rather
    // than raw GPS pings. s-maxage=3 matches that real cadence: any lower
    // wouldn't reliably return fresher data, just more edge-cache misses.
    res.setHeader('Cache-Control', 's-maxage=3, stale-while-revalidate=9');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Failed to fetch upstream trip-updates feed' });
  }
};
