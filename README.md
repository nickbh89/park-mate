# ParkMate

Detects when you park in a **privately enforced (PCN) car park** and warns you
before your free or paid time runs out — the private-parking companion to
[Toll Mate](https://github.com/nickbh89/Toll-mate), sharing its
detect-and-remind architecture.

React Native / Expo SDK 54, Android-first.

## How it works

1. A seed database (`src/data/parkingSites.json`) holds enforced sites:
   coordinates, geofence radius, operator, site type, and max-stay terms.
2. `geofence.js` watches GPS fixes with **2-fix entry confirmation** (no
   drive-past false positives) and a **1.5× hysteresis band** on exit (no
   GPS-jitter phantom exits).
3. On confirmed entry, `stayTimer.js` builds a session plan for the site type:
   - `free-max-stay` — entry alert → "15 min left" → "max stay reached, grace
     period (10 min) — leave now" → overstay warning
   - `pay-and-display` — entry alert prompting the user to log their ticket
     expiry (`planPaidExpiry`)
   - `pay-on-exit` — reminder to pay before leaving (hospitals etc.)
4. `notifications.js` schedules the alerts on a MAX-importance Android channel;
   confirmed exit cancels everything outstanding.
5. `siteSync.js` is a policySync-style effective-dated loader — point
   `REMOTE_SITES_URL` at this repo's raw JSON to ship database updates without
   an app release.

## Database

- `operators.json` — 10 major UK operators (ParkingEye, Euro Car Parks, APCOA,
  Smart Parking, UKPC, Horizon, GroupNexus, NPE, Premier Park, Civil
  Enforcement) with accreditation (BPA/IPC), appeal routes, and the single
  Code of Practice parameters (5-min consideration period, 10-min grace
  period, £50/£80 charge caps outside London).
- `parkingSites.json` — 27 seed sites across the North West (Frodsham,
  Chester, Warrington, Runcorn, Widnes, Liverpool, Manchester, M6/M56/M62
  services).

**Every seed entry is `verified: false`.** Coordinates are approximate
centroids and operator/max-stay values are researched, not surveyed. Signage
on site is the legal record — field-verify (drive the entrances, photograph
the signs, tighten lat/lng/radius) before flipping `verified: true`, and
before any public release. The Settings screen has an "include unverified
sites" toggle so testing can start immediately.

## Running

```bash
npm install
npx expo start        # dev client / Expo Go
npm test              # pure-logic unit tests (node, no emulator needed)
```

## Play Store notes (lessons from Toll Mate)

- Background location is **disabled by default** (`isAndroidBackgroundLocationEnabled: false`
  in app.json). Foreground-only detection avoids the ACCESS_BACKGROUND_LOCATION
  declaration + demo-video review. When you enable it: the disclosure screen
  already exists and shows before the system prompt — record the demo video on
  a **fresh install of the exact build under review**.
- Closed testing: 12+ testers for 14 continuous days before production access
  (your existing Tollmate tester list can be reused).
- Version codes are single-use — bump `android.versionCode` every upload.

## Roadmap

- [ ] Field-verify the seed sites (entrance-anchored geofences, like the
      airport forecourt approach in Toll Mate)
- [ ] National coverage via OSM import (`amenity=parking` + operator tags) with
      a review queue
- [ ] Pay-and-display expiry logging UI (logic already in `planPaidExpiry`)
- [ ] PCN appeal helper (grace period / signage / charge-cap grounds under the
      single Code of Practice)
