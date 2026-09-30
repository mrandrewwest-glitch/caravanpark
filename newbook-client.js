'use strict';

// MOCK NewBook client (Phase 1). Data comes from the build brief.
// The real client (WSSE auth, https://api.au.newbook.cloud/rest/) replaces
// createMockNewBookClient later; it must expose the same two methods.

const MOCK_SITES = [
  { site_id: 12, name: 'Site 12 - Large Family', price: 185, max_guests: 6, pet_friendly: true, amenities: ['power', 'water', 'wifi', 'playground_nearby', 'bbq'], vehicle_max_length: 9.5, available: true },
  { site_id: 15, name: 'Site 15 - Standard', price: 150, max_guests: 4, pet_friendly: false, amenities: ['power', 'water'], vehicle_max_length: 8.0, available: true },
  { site_id: 8, name: 'Site 8 - Powered Only', price: 120, max_guests: 2, pet_friendly: true, amenities: ['power'], vehicle_max_length: 6.5, available: true },
  { site_id: 20, name: 'Site 20 - Unpowered', price: 90, max_guests: 4, pet_friendly: false, amenities: ['water'], vehicle_max_length: 10.0, available: true },
  { site_id: 5, name: 'Site 5 - Deluxe', price: 250, max_guests: 8, pet_friendly: true, amenities: ['power', 'water', 'wifi', 'bbq', 'ensuite', 'air_con'], vehicle_max_length: 12.0, available: true },
];

const MOCK_SITE_DETAILS = {
  12: {
    site_id: 12,
    name: 'Site 12 - Large Family',
    description: 'Spacious family site with level ground, near playground',
    price: 185,
    max_guests: 6,
    pet_friendly: true,
    pet_policy: '2 pets max, no aggressive breeds',
    amenities: ['power', 'water', 'wifi', 'playground_nearby', 'bbq'],
    vehicle_max_length: 9.5,
    power_output: '15A',
    wifi_included: true,
    available: true,
    reviews: [{ rating: 5, comment: 'Perfect for families, kids loved the playground' }],
  },
};

const DETAILS_TTL_MS = 24 * 60 * 60 * 1000; // daily refresh per brief

function createMockNewBookClient({ parkName = 'Friends Caravan Park', latencyMs = 50, failWith = null } = {}) {
  const detailsCache = new Map();
  const calls = [];
  const client = {
    kind: 'mock',
    calls, // recorded so tests can assert "no NewBook query was made"
    failWith, // set to an Error to simulate an outage

    async getAvailability(checkIn, checkOut) {
      calls.push({ method: 'getAvailability', checkIn, checkOut });
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      if (client.failWith) throw client.failWith;
      const sites = structuredClone(MOCK_SITES);
      return { sites, total_available: sites.filter((s) => s.available).length, park_name: parkName, check_in: checkIn, check_out: checkOut };
    },

    // Details rarely change: cached locally with a daily refresh.
    async getSiteDetails(siteId) {
      const hit = detailsCache.get(siteId);
      if (hit && hit.expires > Date.now()) return hit.value;
      calls.push({ method: 'getSiteDetails', siteId });
      if (client.failWith) throw client.failWith;
      const value = MOCK_SITE_DETAILS[siteId];
      if (!value) throw new Error(`Unknown site ${siteId}`);
      detailsCache.set(siteId, { value, expires: Date.now() + DETAILS_TTL_MS });
      return structuredClone(value);
    },
  };
  return client;
}

module.exports = { createMockNewBookClient, MOCK_SITES, MOCK_SITE_DETAILS };
