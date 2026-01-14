// lunisolar-engine.js
// Lunisolar helpers (SunCalc-based).
// Lunar-year start = first NEW MOON ON OR AFTER Spring Equinox (if found), otherwise first new moon of year.
// Special rule: force 2026 lunar new year to 2026-02-17 (Year of the Horse) as requested.
//
// Exports: toLunisolar, annotateAffirmationsWithLunisolar, previewMigrateAffirmations, absoluteDateFromLunar

function msPerDay() { return 1000 * 60 * 60 * 24; }
function utcDateOnly(date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); }

// Find approximate Spring Equinox UTC by sampling Mar 18..22 hourly at lat=0 lon=0 (SunCalc)
function findSpringEquinoxUTC(year) {
  if (typeof SunCalc === 'undefined' || typeof SunCalc.getPosition !== 'function') return null;
  const start = Date.UTC(year, 2, 18, 0, 0, 0);
  const end = Date.UTC(year, 2, 22, 0, 0, 0);
  const step = 60 * 60 * 1000;
  let prevAlt = null, prevT = start;
  for (let t = start; t <= end; t += step) {
    const dt = new Date(t);
    const pos = SunCalc.getPosition(dt, 0, 0);
    const alt = typeof pos.altitude === 'number' ? pos.altitude : null;
    if (prevAlt !== null && alt !== null) {
      if (prevAlt < 0 && alt >= 0) {
        const ratio = Math.abs(prevAlt) / (Math.abs(prevAlt) + Math.abs(alt));
        const estMs = prevT + Math.round((t - prevT) * ratio);
        return new Date(estMs);
      }
    }
    prevAlt = alt;
    prevT = t;
  }
  return null;
}

// Find the first new moon on/after a given UTC Date (search day-by-day, up to maxDays)
function findFirstNewMoonOnOrAfter(startDateUTC, maxDays = 60) {
  if (typeof SunCalc === 'undefined' || typeof SunCalc.getMoonIllumination !== 'function') return null;
  let s = new Date(Date.UTC(startDateUTC.getUTCFullYear(), startDateUTC.getUTCMonth(), startDateUTC.getUTCDate()));
  for (let i = 0; i < maxDays; i++) {
    const dt = new Date(s.getTime() + i * msPerDay());
    const illum = SunCalc.getMoonIllumination(dt);
    if (illum && typeof illum.phase === 'number') {
      const p = illum.phase;
      if (p < 0.03 || p > 0.97) {
        return utcDateOnly(dt);
      }
    }
  }
  return null;
}

// Fallback: first new moon of a given year (search Jan 1..Dec 31)
function findFirstNewMoonOfYearUTC(year) {
  if (typeof SunCalc === 'undefined' || typeof SunCalc.getMoonIllumination !== 'function') return null;
  for (let m = 0; m < 12; m++) {
    for (let d = 1; d <= 31; d++) {
      const dt = new Date(Date.UTC(year, m, d));
      if (dt.getUTCMonth() !== m) continue;
      const illum = SunCalc.getMoonIllumination(dt);
      if (!illum || typeof illum.phase !== 'number') continue;
      const p = illum.phase;
      if (p < 0.03 || p > 0.97) {
        return utcDateOnly(dt);
      }
    }
  }
  return null;
}

function computeLunarYearStartUTCForYear(year) {
  // Special-cased fixed lunar new year: 2026-02-17 (Year of the Horse)
  if (year === 2026) {
    return new Date(Date.UTC(2026, 1, 17)); // Feb 17, 2026 UTC date
  }

  // 1) Try equinox -> first new moon on/after equinox
  const equinox = findSpringEquinoxUTC(year);
  if (equinox) {
    const nm = findFirstNewMoonOnOrAfter(equinox, 90);
    if (nm) return nm;
  }

  // 2) Fallback: first new moon of the year
  const fm = findFirstNewMoonOfYearUTC(year);
  if (fm) return fm;

  // 3) Final fallback: Jan 1 UTC
  return new Date(Date.UTC(year, 0, 1));
}

// Convert a date to lunisolar index (moon number 1..13, moon day 1..28).
function toLunisolar(dateInput) {
  const date = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  const year = date.getUTCFullYear();

  let lunarStart = computeLunarYearStartUTCForYear(year);

  // If date is before this start, use previous year's start
  if (date < lunarStart) {
    lunarStart = computeLunarYearStartUTCForYear(year - 1);
  }

  if (!lunarStart) lunarStart = new Date(Date.UTC(year, 0, 1));

  const daysSinceStart = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(lunarStart.getUTCFullYear(), lunarStart.getUTCMonth(), lunarStart.getUTCDate())) / msPerDay());

  const moonNumber = Math.floor(daysSinceStart / 28) + 1;
  const moonDay = ((daysSinceStart % 28) + 28) % 28 + 1;

  return {
    moonNumber: moonNumber <= 13 ? moonNumber : null,
    moonDay: moonDay,
    lunarYearStart: new Date(lunarStart.getTime())
  };
}

function absoluteDateFromLunar(lunarYearStart, moonNumber, moonDay) {
  const daysOffset = (moonNumber - 1) * 28 + (moonDay - 1);
  return new Date(lunarYearStart.getTime() + daysOffset * msPerDay());
}

function annotateAffirmationsWithLunisolar(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(evt => {
    const d = evt && evt.date ? new Date(evt.date) : null;
    const lunar = d ? toLunisolar(d) : { moonNumber: null, moonDay: null, lunarYearStart: null };
    return Object.assign({}, evt, { lunarInfo: { moonNumber: lunar.moonNumber, moonDay: lunar.moonDay, lunarYearStart: lunar.lunarYearStart ? lunar.lunarYearStart.toISOString() : null }});
  });
}

function previewMigrateAffirmations(arr) {
  const migrated = [];
  const errors = [];
  arr = Array.isArray(arr) ? arr : [];
  arr.forEach(evt => {
    try {
      const d = evt && evt.date ? new Date(evt.date) : null;
      if (!d) { migrated.push(Object.assign({}, evt, { migratedDate: null })); return; }
      const lunar = toLunisolar(d);
      if (!lunar || lunar.moonNumber == null) migrated.push(Object.assign({}, evt, { migratedDate: evt.date, lunarInfo: lunar }));
      else {
        const newDate = absoluteDateFromLunar(lunar.lunarYearStart || new Date(), lunar.moonNumber, lunar.moonDay);
        migrated.push(Object.assign({}, evt, { originalDate: evt.date, migratedDate: newDate.toISOString(), lunarInfo: lunar }));
      }
    } catch (err) {
      errors.push({ id: evt && evt.id, error: err && err.message });
    }
  });
  return { migrated, errors };
}

export { toLunisolar, annotateAffirmationsWithLunisolar, previewMigrateAffirmations, absoluteDateFromLunar };
