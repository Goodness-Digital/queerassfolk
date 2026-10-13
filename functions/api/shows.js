// Upcoming QAF shows, read off the public OutSavvy calendar so the site never
// needs a manual date edit. Cached at the edge for an hour.
const CALENDAR = 'https://www.outsavvy.com/calendar/4084';
const TTL = 3600;

// "+01:00" for a London wall-clock date, so 8pm means 8pm in Hastings
function londonOffset(y, m, d, h, min) {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'longOffset' })
    .formatToParts(guess).find(p => p.type === 'timeZoneName').value;
  return name === 'GMT' ? '+00:00' : name.replace('GMT', '');
}

function parse(html) {
  const shows = [];
  const re = /<div id='(\d{4})-(\d{2})-(\d{2})' class='dategroup[\s\S]*?href='([^']+)'[\s\S]*?<h5>[\s\S]*?>([^<]+)<\/a><\/h5><p>[^<]*@ (\d{1,2}):(\d{2}) (AM|PM)<\/p><p[^>]*>([^<]*)<\/p>/g;
  for (const m of html.matchAll(re)) {
    const [, y, mo, d, url, title, hh, mm, ap, venue] = m;
    const h = (+hh % 12) + (ap === 'PM' ? 12 : 0);
    const start = `${y}-${mo}-${d}T${String(h).padStart(2, '0')}:${mm}:00${londonOffset(+y, +mo, +d, h, +mm)}`;
    shows.push({ start, title: title.replace(/^Queer Ass Folk:\s*/i, '').trim(), venue: venue.trim(), url });
  }
  return shows.sort((a, b) => new Date(a.start) - new Date(b.start));
}

export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default, key = new Request(new URL('/api/shows', request.url));
  const hit = await cache.match(key);
  if (hit) return hit;
  let shows = [];
  try {
    const r = await fetch(CALENDAR, { headers: { 'user-agent': 'Mozilla/5.0 (queerassfolk.org shows feed)' } });
    if (r.ok) shows = parse(await r.text());
  } catch {}
  const res = new Response(JSON.stringify({ shows }), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${shows.length ? TTL : 300}` },
  });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
