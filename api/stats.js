module.exports = async (req, res) => {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch (loadErr) {
    res.status(500).json({
      error: 'xlsx module failed to load',
      detail: String((loadErr && loadErr.message) || loadErr),
    });
    return;
  }

  try {
    const query = req.query || {};
    const tourRaw = (query.tour || 'atp').toString().toLowerCase();
    const tour = tourRaw === 'wta' ? 'wta' : 'atp';
    const now = new Date();
    const year = parseInt(query.year, 10) || now.getFullYear();

    const url = tour === 'wta'
      ? `http://www.tennis-data.co.uk/${year}w/${year}.xlsx`
      : `http://www.tennis-data.co.uk/${year}/${year}.xlsx`;

    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(502).json({
        error: `Source unavailable (${upstream.status})`,
        url,
        hint: 'The archive file for this year/tour may not exist yet or the naming convention has changed.'
      });
      return;
    }

    const arrayBuf = await upstream.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

    const matches = rows
      .map((r) => ({
        date: r.Date instanceof Date ? r.Date.toISOString().slice(0, 10) : (r.Date || null),
        tournament: r.Tournament || null,
        tier: r.Series || null,
        surface: r.Surface || null,
        round: r.Round || null,
        winner: r.Winner || null,
        loser: r.Loser || null,
        wrank: (r.WRank !== undefined && r.WRank !== null && !isNaN(+r.WRank)) ? +r.WRank : null,
        lrank: (r.LRank !== undefined && r.LRank !== null && !isNaN(+r.LRank)) ? +r.LRank : null,
      }))
      .filter((m) => m.winner && m.loser);

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({
      tour,
      year,
      source: url,
      updatedAt: new Date().toISOString(),
      count: matches.length,
      matches,
    });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err), stack: (err && err.stack) ? String(err.stack).split('\n').slice(0,5) : null });
  }
};
