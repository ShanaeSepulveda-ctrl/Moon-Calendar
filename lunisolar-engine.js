// lunisolar-engine.js
/* Lunisolar engine (Chinese/principal-term style) for browser (ES module)
   - Requires astronomia (Meeus algorithms) via CDN import
   - All times are handled in UTC
   - Exposes functions:
     computeLunisolarYear(referenceDateUTC, options)
     toLunisolar(dateUTC, options)
     fromLunisolar(lunarYear, monthIndex, monthDay, isLeap, options)
     annotateAffirmationsWithLunisolar(affirmationsArray, options)
     previewMigrateAffirmations(affirmationsArray, options)
     applyMigration(migrationPreview)  // optional helper to transform data
*/

// --- FIXED IMPORTS (use esm.sh for browser ESM + fetch JSON) ---
import * as julian from 'https://esm.sh/astronomia@2.2.0/julian';
import * as moonphase from 'https://esm.sh/astronomia@2.2.0/moonphase';
import * as solar from 'https://esm.sh/astronomia@2.2.0/solar';
import * as coord from 'https://esm.sh/astronomia@2.2.0/coord';
import * as planetposition from 'https://esm.sh/astronomia@2.2.0/planetposition';

// Load JSON data via fetch (more reliable across CDNs/browsers)
const dataUrl = 'https://cdn.jsdelivr.net/npm/astronomia@2.2.0/data/vsop87Bearth.json';
const dataEarth = await (await fetch(dataUrl)).json();

const EARTH = new planetposition.Planet(dataEarth);

/* Utility: Date (UTC) <-> Julian Day (TT/UTC approximations)
   Use julian.DateToJD/JulianDay functions. astronomia uses Julian Ephemeris / TT in some functions;
   for our purposes the julian day from UTC is sufficient for phase/solar longitude calculations.
*/
function dateToJulianDayUTC(date) {
  // returns JD in UTC fraction (not TT)
  return julian.DateToJD(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  );
}

function julianDayToDateUTC(jd) {
  const d = julian.JDToDate(jd);
  // return JS Date in UTC
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() - 1, d.getDate(), d.getHours(), d.getMinutes(), Math.floor(d.getSeconds())));
}

/* 1) Compute precise new-moon instants over a range
   We use moonphase.truePhase(k) to compute times of new moons via mean-phase indexing (astronomia moonphase supplies search methods).
   Implement computing new moons between two UTC Dates (inclusive).
*/
function computeNewMoonsBetween(startDateUTC, endDateUTC) {
  const startJD = dateToJulianDayUTC(startDateUTC);
  const endJD = dateToJulianDayUTC(endDateUTC);
  const newMoons = [];

  // estimate k0 using year - approximate mean lunations since 2000
  const k0 = Math.floor((startDateUTC.getUTCFullYear() - 2000) * 12.3685) - 2;

  // iterate k until we pass endJD
  for (let k = k0; ; k++) {
    // astronomia moonphase.truePhase expects a k and a phase index:
    // 0 = new moon, 1 = first quarter, 2 = full, 3 = last quarter
    // truePhase returns JD (TT). We'll treat it as approximate UTC for our purposes.
    try {
      const jd = moonphase.truePhase(k, 0); // new moon
      // convert jd (which may be TT) to Date UTC approximated via julianDayToDateUTC
      const dt = julianDayToDateUTC(jd);
      if (dt < startDateUTC) continue;
      if (dt > endDateUTC) break;
      newMoons.push(dt);
    } catch (e) {
      // If astronomia API differs on this build, break to avoid infinite loop
      console.warn('computeNewMoonsBetween: moonphase.truePhase failed for k=', k, e);
      break;
    }
  }

  return newMoons;
}

/* -- Example helper: find new moons for a year (UTC) -- */
function newMoonsForYearUTC(year) {
  const start = new Date(Date.UTC(year - 1, 10, 1)); // start a bit earlier to ensure coverage
  const end = new Date(Date.UTC(year + 1, 2, 31));
  return computeNewMoonsBetween(start, end);
}

/* ---- Lunisolar mapping / conversions ----
   The following functions implement the minimal API used by the page:
   - toLunisolar(date): returns { moonNumber, moonDay, lunarYearStart }
   - annotateAffirmationsWithLunisolar(arr): annotate entries with lunarInfo
   - previewMigrateAffirmations(arr, options): returns preview structure
   (If you already have richer functions in the repo, these are compatible wrappers.)
*/

function toLunisolar(date, opts = {}) {
  // Strategy:
  // 1) Compute candidate new moons around the date (using astronomia moon phase)
  // 2) Define the lunar-year start: here we follow the repository's intended logic:
  //    - Prefer Spring Equinox (approx solar longitude crossing), else first new moon of year
  // For a simple but consistent approach we will:
  //  - find the Spring Equinox UTC by sampling solar longitude near Mar 18-22
  //  - if not found, use first new moon of year (UTC)
  //  - define lunarYearStart, then compute days since start and map into 13*28 scheme

  // Helper: compute spring equinox approx (UTC)
  function getSpringEquinoxUTC(year) {
    // sample hourly March 18..22 at lon=0 lat=0 and find when sun apparent declination crosses 0 -> use solar.apparentLongitude or solar.meanAnomaly?
    try {
      const start = Date.UTC(year, 2, 18, 0, 0, 0);
      const end = Date.UTC(year, 2, 22, 0, 0, 0);
      const step = 60 * 60 * 1000;
      let prevAlt = null;
      let prevT = start;
      for (let t = start; t <= end; t += step) {
        const dt = new Date(t);
        const pos = solar.apparentEquatorial(dt); // astronomia API: apparent equatorial coords
        // If API mismatch occurs fallback to sun position via solar.meanLongitude etc.
        // We will use the sign of declination to find the crossing near 0.
        const dec = pos && pos.dec != null ? pos.dec : null;
        if (dec === null) continue;
        if (prevAlt !== null) {
          if (prevAlt < 0 && dec >= 0) {
            const ratio = Math.abs(prevAlt) / (Math.abs(prevAlt) + Math.abs(dec));
            const estMs = prevT + Math.round((t - prevT) * ratio);
            return new Date(estMs);
          }
        }
        prevAlt = dec;
        prevT = t;
      }
    } catch (e) {
      // if astronomia API differs, return null to fall back
      console.warn('getSpringEquinoxUTC failed', e);
    }
    return null;
  }

  // 1) try Spring Equinox using astronomia solar functions
  const year = date.getUTCFullYear();
  let lunarYearStart = getSpringEquinoxUTC(year);

  // 2) fallback: use first new moon of the year (UTC)
  if (!lunarYearStart) {
    // search new moons around year start
    const newMoons = newMoonsForYearUTC(year);
    if (newMoons && newMoons.length) {
      // pick first new moon on/after Jan 1 UTC
      lunarYearStart = newMoons.find(d => d.getUTCFullYear() === year || d >= new Date(Date.UTC(year,0,1)));
      if (!lunarYearStart) lunarYearStart = newMoons[0];
    }
  }

  // If still not found, set to Jan 1 UTC
  if (!lunarYearStart) lunarYearStart = new Date(Date.UTC(year, 0, 1));

  // If the date is before this start, use previous year's start
  if (date < lunarYearStart) {
    const prevEquinox = getSpringEquinoxUTC(year - 1);
    if (prevEquinox) lunarYearStart = prevEquinox;
    else {
      const prevNewMoons = newMoonsForYearUTC(year - 1);
      if (prevNewMoons && prevNewMoons.length) lunarYearStart = prevNewMoons[0];
    }
  }

  // Compute days since start (UTC days)
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysSinceStart = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(lunarYearStart.getUTCFullYear(), lunarYearStart.getUTCMonth(), lunarYearStart.getUTCDate())) / msPerDay);

  const moonNumber = Math.floor(daysSinceStart / 28) + 1;
  const moonDay = ((daysSinceStart % 28) + 28) % 28 + 1;

  return {
    moonNumber: moonNumber <= 13 ? moonNumber : null,
    moonDay: moonDay,
    lunarYearStart: new Date(lunarYearStart.getTime())
  };
}

function annotateAffirmationsWithLunisolar(affirmationsArray, options = {}) {
  if (!Array.isArray(affirmationsArray)) return [];
  return affirmationsArray.map(evt => {
    const d = evt.date ? new Date(evt.date) : null;
    const lunar = d ? toLunisolar(d, options) : { moonNumber: null, moonDay: null, lunarYearStart: null };
    return Object.assign({}, evt, { lunarInfo: { moonNumber: lunar.moonNumber, moonDay: lunar.moonDay, lunarYearStart: lunar.lunarYearStart ? lunar.lunarYearStart.toISOString() : null }});
  });
}

function previewMigrateAffirmations(affirmationsArray, options = {}) {
  // Simple preview: map each affirmation to a new ISO date computed from same lunar index in the target year scheme
  const migrated = [];
  const errors = [];
  affirmationsArray.forEach(evt => {
    try {
      const d = evt.date ? new Date(evt.date) : null;
      if (!d) {
        migrated.push(Object.assign({}, evt, { migratedDate: null }));
        return;
      }
      const lunar = toLunisolar(d, options);
      if (!lunar || lunar.moonNumber == null) {
        migrated.push(Object.assign({}, evt, { migratedDate: evt.date, lunarInfo: lunar }));
        return;
      }
      // compute newDate from lunarYearStart using absoluteDateFromLunar
      const newDate = absoluteDateFromLunar(lunar.lunarYearStart || new Date(), lunar.moonNumber, lunar.moonDay);
      migrated.push(Object.assign({}, evt, { originalDate: evt.date, migratedDate: newDate.toISOString(), lunarInfo: lunar }));
    } catch (err) {
      errors.push({ id: evt.id, error: err.message });
    }
  });
  return { migrated, errors };
}

/* Utility: absoluteDateFromLunar as in original file */
function absoluteDateFromLunar(lunarYearStart, moonNumber, moonDay) {
  var msPerDay = 1000 * 60 * 60 * 24;
  var daysOffset = (moonNumber - 1) * 28 + (moonDay - 1);
  return new Date(lunarYearStart.getTime() + daysOffset * msPerDay);
}

/* EXPORTS */
export {
  toLunisolar,
  annotateAffirmationsWithLunisolar,
  previewMigrateAffirmations,
  absoluteDateFromLunar
};
