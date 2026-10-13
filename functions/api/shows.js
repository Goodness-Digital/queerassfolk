// Upcoming QAF shows, read off OutSavvy so the site never needs a manual edit.
// The public calendar lists the events; each event page carries schema.org
// MusicEvent data with the venue, town and start time. Cached at the edge for an hour.
const CALENDAR = 'https://www.outsavvy.com/calendar/4084';
const UA = { 'user-agent': 'Mozilla/5.0 (queerassfolk.org shows feed)' };
const TTL = 3600;
const MAX = 12;

const text = s => String(s || '').replace(/&amp;/g, '&').replace(/&#39;/g, '’').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const cleanTitle = s => text(s).replace(/^Queer Ass Folk:\s*/i, '');

// "+01:00" for a London wall-clock date, so 8pm means 8pm in Hastings
function londonOffset(y, m, d, h, min) {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'longOffset' })
    .formatToParts(new Date(Date.UTC(y, m - 1, d, h, min))).find(p => p.type === 'timeZoneName').value;
  return name === 'GMT' ? '+00:00' : name.replace('GMT', '');
}

// What the calendar itself says, used when an event page can't be read
function parseCalendar(html) {
  const out = [];
  const re = /<div id='(\d{4})-(\d{2})-(\d{2})' class='dategroup[\s\S]*?href='([^']+)'[\s\S]*?<h5>[\s\S]*?>([^<]+)<\/a><\/h5><p>[^<]*@ (\d{1,2}):(\d{2}) (AM|PM)<\/p><p[^>]*>([^<]*)<\/p>/g;
  for (const [, y, mo, d, url, title, hh, mm, ap, venue] of html.matchAll(re)) {
    const h = (+hh % 12) + (ap === 'PM' ? 12 : 0);
    out.push({
      url, title: cleanTitle(title), venue: text(venue), town: '',
      start: `${y}-${mo}-${d}T${String(h).padStart(2, '0')}:${mm}:00${londonOffset(+y, +mo, +d, h, +mm)}`,
    });
  }
  return out;
}

// Falls back to the calendar's own fields, flagged so the health check can see it
async function eventDetail(base) {
  const fallback = { ...base, detail: false };
  try {
    const r = await fetch(base.url, { headers: UA });
    if (!r.ok) return fallback;
    const html = await r.text();
    for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      let data; try { data = JSON.parse(json); } catch { continue; }
      const ev = [].concat(data).find(e => /Event$/.test(e && e['@type'] || ''));
      if (!ev) continue;
      const loc = ev.location || {}, offers = ev.offers || {};
      const avail = [].concat(offers.offers || offers).map(o => o && o.availability || '');
      return {
        ...base,
        title: cleanTitle(ev.name) || base.title,
        start: ev.startDate || base.start,
        venue: text(loc.name) || base.venue,
        town: text(loc.address && loc.address.addressLocality),
        soldOut: avail.length > 0 && avail.every(a => /SoldOut/i.test(a)),
        cancelled: /Cancelled/i.test(ev.eventStatus || ''),
        detail: true,
      };
    }
  } catch {}
  return fallback;
}

async function load() {
  const r = await fetch(CALENDAR, { headers: UA });
  if (!r.ok) throw new Error('calendar returned ' + r.status);
  const html = await r.text();
  const parsed = parseCalendar(html), seen = new Set();
  const base = parsed.filter(s => !seen.has(s.url) && seen.add(s.url)).slice(0, MAX);
  // Dates on the calendar that the regex didn't pick up mean OutSavvy changed its markup
  const listed = (html.match(/class='dategroup/g) || []).length;
  const shows = await Promise.all(base.map(eventDetail));
  const errors = [];
  if (listed > parsed.length) errors.push(`calendar lists ${listed} dates, parsed ${parsed.length}`);
  for (const s of shows) if (!s.detail) errors.push(`no event data on ${s.url}`);
  for (const s of shows) delete s.detail;
  return {
    shows: shows.filter(s => !s.cancelled).sort((a, b) => new Date(a.start) - new Date(b.start)),
    errors,
  };
}

export async function onRequestGet({ request, waitUntil }) {
  const cache = caches.default, key = new Request(new URL('/api/shows?v=3', request.url));
  const hit = await cache.match(key);
  if (hit) return hit;
  let shows = [], errors = [], ok = true;
  try { ({ shows, errors } = await load()); } catch (e) { ok = false; errors = [String(e && e.message || e)]; }
  // errors is read by the flatf health check (qaf_shows_check.sh), not the page
  const res = new Response(JSON.stringify({ ok, shows, errors }), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ok ? TTL : 300}` },
  });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
