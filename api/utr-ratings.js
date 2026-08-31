// Fetches UTR rankings from Sofascore's own (unauthenticated, publicly used
// by their own frontend) JSON API — a much simpler and more robust source
// than UTR Sports' own gated client-side app, which requires login and
// exposes nothing to a plain server-side fetch (checked directly).
//
// Endpoint confirmed against a real fetch: GET
// https://www.sofascore.com/api/v1/rankings/{id} returns clean structured
// JSON, not HTML — no regex/markup parsing needed at all, just field
// extraction. id=34 is "UTR Men" (confirmed); the id for "UTR Women" is
// passed in by the caller rather than hardcoded here, since it wasn't
// independently confirmed the same way.
//
// Response shape (verified against a real response):
// { rankingType: { name, gender, id, ... },
//   rankingRows: [ { name, position, points, team: { country: { alpha3 } } }, ... ] }
// "points" IS the UTR rating itself (e.g. 16.42 for Sinner).
module.exports = async (req, res) => {
  try {
    const query = req.query || {};
    const rankingId = (query.id || '').toString().trim();
    if (!rankingId || !/^\d+$/.test(rankingId)) {
      res.status(400).json({ error: 'Missing or invalid id parameter (numeric Sofascore ranking type id, e.g. 34 for UTR Men)' });
      return;
    }

    const upstream = await fetch(`https://www.sofascore.com/api/v1/rankings/${rankingId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DrawClashChecker/1.0)' },
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `Source unavailable (${upstream.status})`, id: rankingId });
      return;
    }
    const data = await upstream.json();
    const rows = Array.isArray(data.rankingRows) ? data.rankingRows : [];
    const players = rows
      .map(r => ({
        name: r && r.name ? String(r.name).trim() : null,
        utr: r && typeof r.points === 'number' ? r.points : null,
        position: r && typeof r.position === 'number' ? r.position : null,
        country: r && r.team && r.team.country ? r.team.country.alpha3 || null : null,
      }))
      .filter(p => p.name && p.utr !== null);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
    res.status(200).json({
      source: `sofascore rankings/${rankingId}`,
      category: data.rankingType ? data.rankingType.name : null,
      updatedAt: new Date().toISOString(),
      count: players.length,
      players,
      warning: players.length ? null : 'No rows with both name and points found — Sofascore\'s response shape may have changed. Send the response to Lea to fix this.',
    });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
