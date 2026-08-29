// Fetches a tournament page from tennisfantasy.cc and extracts the entry
// list (player name, price, seed, country). The site is Next.js
// server-rendered, so the full entry list is present in the initial HTML —
// no headless browser needed.
//
// Two parsing strategies, tried in order:
//  1. __NEXT_DATA__ — Next.js embeds the page's props as JSON in a
//     <script id="__NEXT_DATA__"> tag. If present, this is far more
//     reliable than scraping visible text. We search it recursively for
//     any array of player-shaped objects rather than hardcoding an exact
//     path, since the exact prop structure wasn't verified against the
//     live site from this environment.
//  2. Regex over the rendered <a href="/players/...?tournament=..."> links
//     — verified against a real page fetch during development. Pattern
//     per entry: optional "[seed]" + a one-word display key (surname or
//     initials, discarded) + full name + 2-3 letter country code + price
//     ending in "M". Example: "[3] Aliassime Felix Auger Aliassime CAN 14.0M".
//
// If both strategies find zero players, the response says so explicitly
// (rather than returning an empty array silently) so a real structural
// mismatch is visible instead of looking like "no data for this tournament".
module.exports = async (req, res) => {
  try {
    const query = req.query || {};
    const pageUrl = (query.url || '').toString().trim();
    if (!pageUrl) {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }
    let parsed;
    try { parsed = new URL(pageUrl); } catch (e) {
      res.status(400).json({ error: 'Invalid url' });
      return;
    }
    if (parsed.hostname !== 'tennisfantasy.cc' && !parsed.hostname.endsWith('.tennisfantasy.cc')) {
      res.status(400).json({ error: 'Only tennisfantasy.cc URLs are allowed' });
      return;
    }

    const upstream = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DrawClashChecker/1.0)' } });
    if (!upstream.ok) {
      res.status(502).json({ error: `Source unavailable (${upstream.status})`, url: pageUrl });
      return;
    }
    const html = await upstream.text();

    let players = [];
    let strategy = null;

    // Strategy 1: __NEXT_DATA__
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const data = JSON.parse(nextDataMatch[1]);
        const found = findPlayerArray(data);
        if (found && found.length) {
          players = found.map(normalizeNextDataPlayer).filter(Boolean);
          strategy = 'next_data';
        }
      } catch (e) { /* fall through to regex strategy */ }
    }

    // Strategy 2: regex over rendered player links
    if (!players.length) {
      players = parseFromLinks(html);
      if (players.length) strategy = 'link_regex';
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
    res.status(200).json({
      source: pageUrl,
      updatedAt: new Date().toISOString(),
      strategy,
      count: players.length,
      players,
      warning: players.length ? null : 'Could not find any player entries on this page — the site\'s markup may have changed. Send this response to Lea to fix the parser.',
    });
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err), stack: (err && err.stack) ? String(err.stack).split('\n').slice(0, 5) : null });
  }
};

function findPlayerArray(node, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 8 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    if (node.length && node.every(item => item && typeof item === 'object' && looksLikePlayer(item))) {
      return node;
    }
    for (const item of node) {
      const found = findPlayerArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(node)) {
    const found = findPlayerArray(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}
function looksLikePlayer(obj) {
  const keys = Object.keys(obj).map(k => k.toLowerCase());
  const hasName = keys.some(k => k.includes('name'));
  const hasPrice = keys.some(k => k.includes('price') || k.includes('cost') || k.includes('value'));
  return hasName && hasPrice;
}
function normalizeNextDataPlayer(obj) {
  const keys = Object.keys(obj);
  const get = (pred) => { const k = keys.find(pred); return k ? obj[k] : null; };
  const name = get(k => /full.?name/i.test(k)) || get(k => /^name$/i.test(k)) || get(k => /name/i.test(k));
  let price = get(k => /price/i.test(k)) ?? get(k => /cost/i.test(k)) ?? get(k => /value/i.test(k));
  if (typeof price === 'string') price = parseFloat(price.replace(/[^0-9.]/g, ''));
  const seed = get(k => /seed/i.test(k));
  const country = get(k => /country/i.test(k)) || get(k => /nationality/i.test(k));
  if (!name || price === null || price === undefined || isNaN(price)) return null;
  return { name: String(name).trim(), price: +price, seed: seed ? +seed || null : null, country: country ? String(country).trim() : null };
}
function parseFromLinks(html) {
  // href pattern confirmed against the real page:
  // /players/aryna-sabalenka-wta?tournament=u-s-open-2026-wta
  const players = [];
  const linkRe = /<a[^>]+href="\/players\/[a-z0-9-]+\?tournament=[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const parsed = parseEntryBlock(m[1]);
    if (parsed) players.push(parsed);
  }
  return players;
}
function cleanText(s) {
  // React SSR inserts <!-- --> hydration markers between text fragments
  // (e.g. "Aryna<!-- --> <!-- -->Sabalenka", "15.0<!-- -->M") -- strip
  // those and any other nested tags before reading the text.
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function parseEntryBlock(block) {
  // Confirmed structure from a real fetch (2026-08-29):
  //   <span class="text-text-muted w-8 text-center text-sm">[1]</span>   -- seed, optional
  //   <div>...<img alt="Sabalenka" .../></div>                          -- NOT the name; earlier
  //     markdown-only testing mistook this alt text for a separate
  //     "display key" token, which is what broke the original regex
  //   <span class="text-white font-medium ...">Aryna<!-- --> <!-- -->Sabalenka</span>
  //   <span class="text-text-muted text-xs mr-4">BLR</span>             -- country
  //   <span class="text-accent font-bold text-sm">15.0<!-- -->M</span>  -- price
  const seedMatch = block.match(/\[(\d+)\]/);
  const nameMatch = block.match(/class="text-white font-medium[^"]*">([\s\S]*?)<\/span>/);
  if (!nameMatch) return null;
  const name = cleanText(nameMatch[1]);
  if (!name) return null;
  // Country: whatever <span> comes right after the name span closes --
  // matched positionally rather than by exact class string, since that's
  // more tolerant of minor class-name changes than the name/price spans.
  const afterName = block.slice(nameMatch.index + nameMatch[0].length);
  const countryMatch = afterName.match(/<span[^>]*>([\s\S]*?)<\/span>/);
  const country = countryMatch ? cleanText(countryMatch[1]) || null : null;
  const priceMatch = block.match(/class="text-accent font-bold[^"]*">([\s\S]*?)<\/span>/);
  if (!priceMatch) return null;
  const priceNum = parseFloat(cleanText(priceMatch[1]).replace(/[^0-9.]/g, ''));
  if (isNaN(priceNum)) return null;
  return { name, price: priceNum, seed: seedMatch ? +seedMatch[1] : null, country };
}
