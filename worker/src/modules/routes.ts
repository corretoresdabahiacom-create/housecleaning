// Route organization. Honest scope:
//  - Geocoding uses the free US Census Bureau Geocoder (no key, US addresses only).
//  - Ordering is a nearest-neighbor heuristic over STRAIGHT-LINE distance. It does not know roads,
//    traffic, or travel time, and never invents them. Real driving directions are delegated to Google Maps
//    via a directions link built from the ordered stops.
import { HttpError, Router, json, todayIn } from '../lib/core';
import { owned, requirePerm } from '../lib/security';

export const haversineMiles = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const R = 3958.8, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** Nearest-neighbor ordering starting from the first stop (earliest appointment). */
export function nearestNeighbor<T extends { lat: number; lon: number }>(stops: T[]) {
  if (stops.length < 3) return stops.slice();
  const left = stops.slice(1), order = [stops[0]];
  while (left.length) {
    const cur = order[order.length - 1];
    let bi = 0, bd = Infinity;
    left.forEach((s, i) => { const d = haversineMiles(cur, s); if (d < bd) { bd = d; bi = i; } });
    order.push(left.splice(bi, 1)[0]);
  }
  return order;
}
const totalMiles = (s: { lat: number; lon: number }[]) => s.slice(1).reduce((t, x, i) => t + haversineMiles(s[i], x), 0);

export function routeRoutes(r: Router) {
  r.post('/api/properties/:id/geocode', async (c) => {
    const s = await requirePerm(c.env, c.session, 'properties.write');
    const p: any = await owned(c.env, 'residential_properties', c.params.id, s.companyId);
    const address = `${p.street}, ${p.city}, ${p.state} ${p.zip}`;
    const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?' + new URLSearchParams({ address, benchmark: 'Public_AR_Current', format: 'json' });
    let match: any;
    try { match = ((await (await fetch(url)).json()) as any)?.result?.addressMatches?.[0]; }
    catch { throw new HttpError(502, 'geocoding_failed'); }
    if (!match?.coordinates) throw new HttpError(404, 'address_not_found');
    const lat = Number(match.coordinates.y), lon = Number(match.coordinates.x);
    await c.env.DB.prepare('UPDATE residential_properties SET latitude=?, longitude=? WHERE id=? AND company_id=?').bind(lat, lon, p.id, s.companyId).run();
    return json({ latitude: lat, longitude: lon, matched_address: match.matchedAddress, source: 'US Census Bureau Geocoder' });
  });

  r.get('/api/routes/day', async (c) => {
    const s = await requirePerm(c.env, c.session, 'schedule.read');
    const date = c.query.get('date') || todayIn(s.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(422, 'validation_error', { date: 'date' });
    const helper = c.query.get('helper_id');
    const { results } = await c.env.DB.prepare(`SELECT a.id, a.start_time, a.duration_minutes, p.name AS property_name, p.street, p.unit, p.city, p.state, p.zip, p.latitude, p.longitude
        FROM cleaning_appointments a JOIN residential_properties p ON p.id=a.property_id
       WHERE a.company_id=? AND a.date=? AND a.status NOT IN ('canceled','rescheduled')
       ${helper ? 'AND EXISTS (SELECT 1 FROM appointment_helpers x WHERE x.appointment_id=a.id AND x.helper_id=?)' : ''}
       ORDER BY a.start_time`).bind(...(helper ? [s.companyId, date, helper] : [s.companyId, date])).all<any>();
    const located = results.filter((x) => x.latitude !== null && x.longitude !== null).map((x) => ({ ...x, lat: x.latitude, lon: x.longitude }));
    const missing = results.filter((x) => x.latitude === null || x.longitude === null);
    const scheduled = located;                 // current order = appointment times
    const suggested = nearestNeighbor(located);
    const addr = (x: any) => [x.street, x.city, x.state, x.zip].join(', ');
    const link = (stops: any[]) => stops.length < 2 ? null : 'https://www.google.com/maps/dir/?api=1&' + new URLSearchParams({
      origin: addr(stops[0]), destination: addr(stops[stops.length - 1]), travelmode: 'driving',
      ...(stops.length > 2 ? { waypoints: stops.slice(1, -1).slice(0, 9).map(addr).join('|') } : {}),
    }).toString();
    const r1 = (n: number) => Math.round(n * 10) / 10;
    return json({
      date,
      method: 'Nearest-neighbor ordering by straight-line distance. Not driving distance or travel time.',
      scheduled_order: scheduled.map((x) => x.id), suggested_order: suggested.map((x) => x.id),
      straight_line_miles: { scheduled: r1(totalMiles(scheduled)), suggested: r1(totalMiles(suggested)) },
      stops: results.map((x) => ({ id: x.id, start_time: x.start_time, property_name: x.property_name, address: addr(x), has_coordinates: x.latitude !== null })),
      missing_coordinates: missing.map((x) => x.id),
      google_maps_directions: link(suggested),
    });
  });
}
