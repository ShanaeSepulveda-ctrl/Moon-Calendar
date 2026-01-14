// lunisolar-engine.js
// Simple lunisolar helpers implemented using SunCalc (no external ESM CDNs).
// Designed to work in-browser where index.html already includes SunCalc via:
// <script src="https://unpkg.com/suncalc@1.9.0/suncalc.js"></script>
//
// Exports:
// - toLunisolar(date) => { moonNumber, moonDay, lunarYearStart }
// - annotateAffirmationsWithLunisolar(arr)
// - previewMigrateAffirmations(arr, options)
// - absoluteDateFromLunar(lunarYearStart, moonNumber, moonDay)

function getUTCDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function msPerDay() {
  return 1000 * 60 * 60 * 24;
}

// Approximate Spring Equinox (UTC) by sampling Mar 18..22 hourly at lat=0, lon=0
function getSpringEquinoxUTC(year) {
  if (typeof SunCalc === 'undefined' || typeof SunCalc.getPosition !== 'function') return null;
  const start = Date.UTC(year, 2, 18, 0, 0, 0);
  const end = Date.UTC(year, 2, 22, 0, 0, 0);
  const step = 60 * 60 * 1000; // 1 hour
  let prevDec = null;
  let prevT = start;

  for (let t = start; t <= end; t += step) {
    const dt = new Date(t);
    const pos = SunCalc.getPosition(dt, 0, 0);
    // SunCalc.getPosition returns {altitude, azimuth} — we use altitude (not declination)
    // Crossing of altitude at equator around equinox should be detectable by sign change near 0.
    const alt = typeof pos.altitude === 'number' ? pos.altitude : null;
    if (alt === null) {
      prevDec = null;
      prevT = t;
      continue;
    }
    if (prevDec !== null) {
      if (prevDec < 0 && alt >= 0) {
        const ratio = Math.abs(prevDec) / (Math.abs(prevDec) + Math.abs(alt));
        const estMs = prevT + Math.round((t - prevT) * ratio);
        return new Date(estMs);
      }
    }
    prevDec = alt;
    prevT = t;
  }
  return null;
}

// Approximate first new moon of a year (UTC) by scanning days and finding phase near 0
function getFirstNewMoonOfYearUTC(year) {
  if (typeof SunCalc === 'undefined' || typeof SunCalc.getMoonIllumination !== 'function') return null;
  // Search Jan 1 -> Dec 31 (but return first occurrence)
  for (let month = 0; month < 12; month++) {
    for (let day = 1; day <= 31; day++) {
      try {
        const dt = new Date(Date.UTC(year, month, day));
        if (dt.getUTCMonth() !== month) continue; // invalid date
        const illum = SunCalc.getMoonIllumination(dt);
        if (!illum || typeof illum.phase === 'undefined') continue;
        const phase = illum.phase;
        if (phase < 0.03 || phase > 0.97) {
          // Normalize to that date's UTC midnight
          return getUTCDateOnly(dt);
        }
      } catch (e) {
        continue;
      }
    }
  }
  return null;
}

// Compute lunar-year start candidate using equinox preference then first new moon fallback.
// Returns Date (UTC midnight) if possible.
function computeLunarYearStartUTCForYear(year) {
  let lunarStart = getSpringEquinoxUTC(year);
  if (lunarStart) {
    // normalize to UTC date beginning (we want a Date aligned to UTC day)
    lunarStart = getUTCDateOnly(lunarStart);
  }

  if (!lunarStart) {
    lunarStart = getFirstNewMoonOfYearUTC(year);
  }

  if (!lunarStart) {
    // fallback: Jan 1 UTC
    lunarStart = new Date(Date.UTC(year, 0, 1));
  }
  return lunarStart;
}

// Convert absolute Date -> lunisolar index (moonNumber 1..13, moonDay 1..28).
// Strategy mirrors the logic used in index.html: prefer equinox, fallback to first new moon.
function toLunisolar(date, opts = {}) {
  if (!(date instanceof Date)) date = new Date(date);
  // Work in UTC
  const year = date.getUTCFullYear();
  let lunarYearStart = computeLunarYearStartUTCForYear(year);

  // If date is before this year's start, use previous year's start
  if (date < lunarYearStart) {
    lunarYearStart = computeLunarYearStartUTCForYear(year - 1);
  }

  // If still null, fallback to Jan 1
  if (!lunarYearStart) lunarYearStart = new Date(Date.UTC(year, 0, 1));

  // days since start, counting full UTC days
  const daysSinceStart = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(lunarYearStart.getUTCFullYear(), lunarYearStart.getUTCMonth(), lunarYearStart.getUTCDate())) / msPerDay());

  const moonNumber = Math.floor(daysSinceStart / 28) + 1;
  const moonDay = ((daysSinceStart % 28) + 28) % 28 + 1;

  return {
    moonNumber: moonNumber <= 13 ? moonNumber : null,
    moonDay: moonDay,
    lunarYearStart: new Date(lunarYearStart.getTime())
  };
}

function absoluteDateFromLunar(lunarYearStart, moonNumber, moonDay) {
  const ms = msPerDay();
  const daysOffset = (moonNumber - 1) * 28 + (moonDay - 1);
  return new Date(lunarYearStart.getTime() + daysOffset * ms);
}

function annotateAffirmationsWithLunisolar(affirmationsArray, options = {}) {
  if (!Array.isArray(affirmationsArray)) return [];
  return affirmationsArray.map(evt => {
    const d = evt && evt.date ? new Date(evt.date) : null;
    const lunar = d ? toLunisolar(d, options) : { moonNumber: null, moonDay: null, lunarYearStart: null };
    return Object.assign({}, evt, { lunarInfo: { moonNumber: lunar.moonNumber, moonDay: lunar.moonDay, lunarYearStart: lunar.lunarYearStart ? lunar.lunarYearStart.toISOString() : null }});
  });
}

function previewMigrateAffirmations(affirmationsArray, options = {}) {
  const migrated = [];
  const errors = [];
  affirmationsArray.forEach(evt => {
    try {
      const d = evt && evt.date ? new Date(evt.date) : null;
      if (!d) {
        migrated.push(Object.assign({}, evt, { migratedDate: null }));
        return;
      }
      const lunar = toLunisolar(d, options);
      if (!lunar || lunar.moonNumber == null) {
        migrated.push(Object.assign({}, evt, { migratedDate: evt.date, lunarInfo: lunar }));
        return;
      }
      const newDate = absoluteDateFromLunar(lunar.lunarYearStart || new Date(), lunar.moonNumber, lunar.moonDay);
      migrated.push(Object.assign({}, evt, { originalDate: evt.date, migratedDate: newDate.toISOString(), lunarInfo: lunar }));
    } catch (err) {
      errors.push({ id: evt && evt.id, error: err && err.message });
    }
  });
  return { migrated, errors };
}

export {
  toLunisolar,
  annotateAffirmationsWithLunisolar,
  previewMigrateAffirmations,
  absoluteDateFromLunar
};
