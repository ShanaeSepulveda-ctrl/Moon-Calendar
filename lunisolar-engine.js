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
import * as julian from 'https://cdn.jsdelivr.net/npm/astronomia@2.2.0/src/julian/index.js';
import * as moonphase from 'https://cdn.jsdelivr.net/npm/astronomia@2.2.0/src/moonphase/index.js';
import * as solar from 'https://cdn.jsdelivr.net/npm/astronomia@2.2.0/src/solar/index.js';
import * as coord from 'https://cdn.jsdelivr.net/npm/astronomia@2.2.0/src/coord/index.js';
import * as planetposition from 'https://cdn.jsdelivr.net/npm/astronomia@2.2.0/src/planetposition/index.js';
import * as dataEarth from 'https://cdn.jsdelivr.net/npm/astronomia@2.2.0/data/vsop87Bearth.json';

// NOTE: CDN module paths / versions may need updating depending on astronomia packaging. If imports fail, tell me the console error and I'll correct paths.

const EARTH = new planetposition.Planet(dataEarth);

/* Utility: Date (UTC) <-> Julian Day (TT/UTC approximations)
   Use julian.DateToJD/JulianDay functions. astronomia uses Julian Ephemeris / TT in some functions;
   for our purposes the julian day from UTC is sufficient for phase/solar longitude calculations.
*/
function dateToJulianDayUTC(date) {
  // returns JD in UTC fraction (not TT)
  return julian.DateToJD(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours() + date.getUTCMinutes()/60 + date.getUTCSeconds()/3600);
}

function julianDayToDateUTC(jd) {
  const d = julian.JDToDate(jd);
  // return JS Date in UTC
  return new Date(Date.UTC(d.getFullYear(), d.getMonth()-1, d.getDate(), d.getHours(), d.getMinutes(), Math.floor(d.getSeconds())));
}

/* 1) Compute precise new-moon instants over a range
   We use moonphase.truePhase(k) to compute times of new moons via mean-phase indexing (astronomia moonphase supplies search methods).
   Implement computing new moons between two UTC Dates (inclusive).
*/
function computeNewMoonsBetween(startDateUTC, endDateUTC) {
  const startJD = dateToJulianDayUTC(startDateUTC);
  const endJD = dateToJulianDayUTC(endDateUTC);
  // Determine k (lunation number) range by inverting mean new moon approx: k ≈ (year - 2000) * 12.3685; use moonphase.meanPhase to find
  // Simpler: iterate k from approximate lower bound until > endJD
  const newMoons = [];

  // estimate k0 using year
  const startYear = startDateUTC.getUTCFullYear();
  let k = Math.floor((startYear - 2000) * 12.3685) - 2;

  // use moonphase to get new moon JD for each k
  while (true) {
    const ph = moonphase.truePhase(k); // returns object with jde (Julian Ephemeris Day)
    const jd = ph.jde; // JDE (TT) — it's fine as approximate; we convert to UTC Date with small error acceptable for month boundaries
    // convert JDE (TT) to approximate UTC by subtracting 64.184s + deltaT approx; for our calendar purpose, use julianDayToDateUTC on jd
    const d = julianDayToDateUTC(jd);
    if (d >= startDateUTC && d <= endDateUTC) {
      newMoons.push(d);
    }
    if (d > endDateUTC) break;
    k++;
    // guard
    if (k > 1000000) break;
  }

  // Ensure sorted unique
  return newMoons.sort((a,b) => a - b);
}

/* 2) Compute Sun ecliptic longitude (degrees) for a UTC Date.
   Use solar.apparentLongitude or compute from earth heliocentric position.
*/
function sunEclipticLongitudeDegrees(dateUTC) {
  const jd = dateToJulianDayUTC(dateUTC);
  const T = julian.J2000Century(jd);
  // astronomia's solar.apparentLongitude expects Julian Day in TT? We'll use approximate apparent longitude from solar.position
  const lon = solar.apparentLongitude(jd); // returns radians
  let deg = lon * 180 / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return deg;
}

/* 3) Find occurrences of principal terms (multiples of 30°) between two instants.
   We'll sample and then refine with bisection.
*/
function findPrincipalTermBetween(startDateUTC, endDateUTC) {
  const startDeg = sunEclipticLongitudeDegrees(startDateUTC);
  const endDeg = sunEclipticLongitudeDegrees(endDateUTC);

  // function that returns (deg - target) normalized to [-180,180)
  function delta(deg, target) {
    let d = deg - target;
    while (d < -180) d += 360;
    while (d >= 180) d -= 360;
    return d;
  }

  for (let k = 0; k < 12; k++) {
    const target = k * 30; // degrees
    const d1 = delta(startDeg, target);
    const d2 = delta(endDeg, target);
    // If sign change, there's a crossing (principal term)
    if (d1 === 0) return startDateUTC; // exact hit
    if (d1 * d2 < 0) {
      // refine by bisection
      let low = startDateUTC.getTime();
      let high = endDateUTC.getTime();
      for (let i = 0; i < 40; i++) {
        const mid = new Date(Math.round((low + high) / 2));
        const midDeg = sunEclipticLongitudeDegrees(mid);
        const dm = delta(midDeg, target);
        if (Math.abs(dm) < 1e-6) {
          return new Date(mid);
        }
        if (delta(startDeg, target) * dm <= 0) {
          high = mid.getTime();
        } else {
          low = mid.getTime();
        }
      }
      return new Date(Math.round((low + high) / 2));
    }
  }
  return null;
}

/* Determine whether a lunar month (newMoon -> nextNewMoon) contains any principal term.
   Returns true if it contains one (so it's a normal month), false if it contains none (leap candidate).
*/
function monthContainsPrincipalTerm(newMoonDate, nextNewMoonDate) {
  const term = findPrincipalTermBetween(newMoonDate, nextNewMoonDate);
  return term !== null;
}

/* Build lunisolar year anchored to the spring equinox (Chinese-style principal-term)
   Options:
    - anchor: 'equinox' (year anchored to spring equinox); default true
    - yearStartRule: 'monthContainingEquinox' or 'firstNewMoonAfterEquinox' (default 'monthContainingEquinox')
*/
function computeLunisolarYear(referenceDateUTC, options) {
  options = Object.assign({
    anchor: 'equinox',
    yearStartRule: 'monthContainingEquinox' // or 'firstNewMoonAfterEquinox'
  }, options || {});

  const year = referenceDateUTC.getUTCFullYear();

  // Search window: start from previous Dec to next Apr to collect new moons covering the lunar year
  const windowStart = new Date(Date.UTC(year - 1, 11, 1, 0, 0, 0)); // Dec 1 previous year
  const windowEnd = new Date(Date.UTC(year + 1, 3, 30, 0, 0, 0)); // Apr 30 next year

  const newMoons = computeNewMoonsBetween(windowStart, windowEnd);
  if (newMoons.length < 12) {
    throw new Error('Insufficient new moon data computed; expand window or check astronomia imports.');
  }

  // compute spring equinox instant (approx) around March 19-21
  let eqStart = new Date(Date.UTC(year, 2, 18, 0, 0, 0));
  let eqEnd = new Date(Date.UTC(year, 2, 22, 0, 0, 0));
  // refine equinox by bisection: find when sun longitude crosses 0° (or 360->0)
  // We'll search for longitude crossing of 0° (target=0)
  let equinox = findPrincipalTermBetween(eqStart, eqEnd); // principal term 0° is the vernal equinox
  if (!equinox) {
    // fallback: use March 20 UTC
    equinox = new Date(Date.UTC(year, 2, 20, 0, 0, 0));
  }

  // Identify the lunar month that contains the equinox (if any)
  let lunarYearStartIndex = null;
  for (let i = 0; i < newMoons.length - 1; i++) {
    if (newMoons[i] <= equinox && equinox < newMoons[i + 1]) {
      lunarYearStartIndex = i; // month starting at newMoons[i]
      break;
    }
  }

  if (options.yearStartRule === 'firstNewMoonAfterEquinox') {
    // choose the first new moon that occurs at or after the equinox
    for (let i = 0; i < newMoons.length; i++) {
      if (newMoons[i] >= equinox) {
        lunarYearStartIndex = i;
        break;
      }
    }
  } else {
    // default: if no month contains the equinox (edge case), use the first new moon after equinox
    if (lunarYearStartIndex === null) {
      for (let i = 0; i < newMoons.length; i++) {
        if (newMoons[i] >= equinox) {
          lunarYearStartIndex = i;
          break;
        }
      }
    }
  }

  if (lunarYearStartIndex === null) {
    throw new Error('Could not determine lunar year start index.');
  }

  // Build months starting at lunarYearStartIndex and collect up to 13 months (possible leap)
  const months = [];
  // We need to decide the year span: start from lunarYearStartIndex until we reach the next occurrence of the lunar year start after ~354-386 days
  let i = lunarYearStartIndex;
  let accumulatedDays = 0;
  while (i < newMoons.length - 1 && months.length < 15) {
    const start = newMoons[i];
    const end = newMoons[i + 1];
    const lengthDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
    const containsTerm = monthContainsPrincipalTerm(start, end);
    months.push({
      start: start,
      end: end,
      lengthDays: lengthDays,
      containsPrincipalTerm: containsTerm,
      isLeapCandidate: !containsTerm // candidate if contains no principal term
    });
    accumulatedDays += lengthDays;
    // Stop when we've passed ~1 solar year (approx 365 days) and at least 12 months
    if (months.length >= 12 && accumulatedDays >= 354) {
      // check if the next month would be the start of next lunisolar year (i.e., contains the next equinox)
      // we will break after collecting up to one possible leap month
      if (accumulatedDays >= 370) break; // safety
    }
    i++;
  }

  // Identify leap month if any: by Chinese rule it's the first month in the year that does NOT contain a principal term
  let leapIndex = null;
  for (let j = 0; j < months.length; j++) {
    if (!months[j].containsPrincipalTerm) {
      leapIndex = j;
      break;
    }
  }

  // mark isLeap property
  if (leapIndex !== null) {
    months[leapIndex].isLeap = true;
  }
  // assign monthNumber for normal months; leap months get flagged and share previous month's numbering in some conventions.
  let monthNumber = 1;
  for (let j = 0; j < months.length; j++) {
    months[j].monthNumber = monthNumber;
    months[j].displayMonthNumber = monthNumber;
    if (months[j].isLeap) {
      months[j].isLeap = true;
      // by convention leap month repeats the previous month number or follows specific numbering; we keep displayMonthNumber the same and mark isLeap
    } else {
      monthNumber++;
    }
  }

  const lunarYearStart = months[0].start;

  return {
    lunarYearStart: lunarYearStart,
    months: months,
    equinox: equinox,
    leapIndex: leapIndex,
    lunarYear: (new Date(lunarYearStart)).getUTCFullYear() // simple year index; you can choose other numbering
  };
}

/* Convert a UTC Date → lunisolar coordinates using computeLunisolarYear for the relevant year(s).
   Returns lunarYear, monthIndex (0-based in months array), monthNumber(display), monthDay (1..n), isLeap.
*/
function toLunisolar(dateUTC, options) {
  options = options || {};
  // compute candidate lunisolar year for the date's Gregorian year and adjacent years
  const year = dateUTC.getUTCFullYear();
  const candidateYears = [year - 1, year, year + 1];
  for (const y of candidateYears) {
    const ref = new Date(Date.UTC(y, 2, 20, 0, 0, 0)); // March 20 reference
    let ly;
    try {
      ly = computeLunisolarYear(ref, options);
    } catch (err) {
      continue;
    }
    const months = ly.months;
    for (let i = 0; i < months.length; i++) {
      const m = months[i];
      if (dateUTC >= m.start && dateUTC < m.end) {
        const monthDay = Math.floor((dateUTC - m.start) / (1000 * 60 * 60 * 24)) + 1;
        return {
          lunarYear: ly.lunarYear,
          monthIndex: i,
          monthNumber: m.displayMonthNumber,
          monthDay: monthDay,
          isLeap: !!m.isLeap,
          lunarYearStart: ly.lunarYearStart
        };
      }
    }
  }
  // fallback: compute by simple 28-day cycles from spring equinox (very unlikely)
  const ly = computeLunisolarYear(new Date(Date.UTC(year,2,20)), options);
  const daysSinceStart = Math.floor((dateUTC - ly.lunarYearStart) / (1000*60*60*24));
  const moonNumber = Math.floor(daysSinceStart / 28) + 1;
  const moonDay = ((daysSinceStart % 28) + 28) % 28 + 1;
  return {
    lunarYear: ly.lunarYear,
    monthIndex: 0,
    monthNumber: moonNumber,
    monthDay: moonDay,
    isLeap: false,
    lunarYearStart: ly.lunarYearStart
  };
}

/* Convert lunisolar coordinate → Date (start of that lunar month + monthDay-1)
   monthNumber: display month number
   monthIndex and isLeap are preferred, but if not provided, we search months to find matching monthNumber & isLeap
*/
function fromLunisolar(lunarYear, monthNumber, monthDay, isLeap, options) {
  // Build the lunisolar year around March of lunarYear
  const ref = new Date(Date.UTC(lunarYear, 2, 20, 0, 0, 0));
  const ly = computeLunisolarYear(ref, options);
  // find month matching display monthNumber and isLeap flag
  for (let i = 0; i < ly.months.length; i++) {
    const m = ly.months[i];
    if (m.displayMonthNumber === monthNumber && (!!m.isLeap) === (!!isLeap)) {
      const date = new Date(m.start.getTime() + (monthDay - 1) * 24*60*60*1000);
      return date;
    }
  }
  // fallback, clamp
  return ly.months[0].start;
}

/* Annotate affirmations/events with lunisolar metadata without modifying originals.
   Expect affirmationsArray items to have { id?, date: ISOstring or Date, text? }
   Returns a new array with lunarInfo: { lunarYear, monthNumber, monthDay, isLeap, lunarYearStart }
*/
function annotateAffirmationsWithLunisolar(affirmationsArray, options) {
  return affirmationsArray.map(item => {
    const d = (item.date instanceof Date) ? item.date : new Date(item.date);
    const lunar = toLunisolar(d, options);
    const copy = Object.assign({}, item);
    copy.lunarInfo = {
      lunarYear: lunar.lunarYear,
      monthNumber: lunar.monthNumber,
      monthDay: lunar.monthDay,
      isLeap: lunar.isLeap,
      lunarYearStart: lunar.lunarYearStart ? lunar.lunarYearStart.toISOString() : null
    };
    return copy;
  });
}

/* Preview migration: produce proposed migratedDate for each event if you want to remap by lunar index.
   strategy: 'keepAbsolute' | 'remapToSameLunarIndex' (default 'remapToSameLunarIndex')
   Returns { migrated: [...], errors: [...] } where migrated items have originalDate and proposedDate
*/
function previewMigrateAffirmations(affirmationsArray, options) {
  options = options || {};
  const strategy = options.strategy || 'remapToSameLunarIndex';
  const migrated = [];
  const errors = [];

  affirmationsArray.forEach(item => {
    try {
      const originalDate = (item.date instanceof Date) ? item.date : new Date(item.date);
      const oldLunar = toLunisolar(originalDate, options);
      if (strategy === 'keepAbsolute') {
        migrated.push(Object.assign({}, item, { originalDate: originalDate.toISOString(), proposedDate: originalDate.toISOString(), lunarInfo: oldLunar }));
      } else {
        // remap to the same lunar index under new lunisolar computation for that lunar year
        // Determine target lunarYearStart using our computeLunisolarYear rule for the old lunarYear
        const targetYear = oldLunar.lunarYear;
        const newLunarYear = computeLunisolarYear(new Date(Date.UTC(targetYear,2,20)), options);
        // Find month matching display monthNumber and isLeap flag
        let matchedMonth = null;
        for (let i = 0; i < newLunarYear.months.length; i++) {
          const m = newLunarYear.months[i];
          if (m.displayMonthNumber === oldLunar.monthNumber && (!!m.isLeap) === (!!oldLunar.isLeap)) {
            matchedMonth = m;
            break;
          }
        }
        if (!matchedMonth) {
          // if not found, try find by monthNumber only
          for (let i = 0; i < newLunarYear.months.length; i++) {
            const m = newLunarYear.months[i];
            if (m.displayMonthNumber === oldLunar.monthNumber) {
              matchedMonth = m;
              break;
            }
          }
        }
        if (!matchedMonth) {
          // cannot map; keep original
          migrated.push(Object.assign({}, item, { originalDate: originalDate.toISOString(), proposedDate: originalDate.toISOString(), lunarInfo: oldLunar }));
        } else {
          const proposedDate = new Date(matchedMonth.start.getTime() + (oldLunar.monthDay - 1) * 24*60*60*1000);
          migrated.push(Object.assign({}, item, { originalDate: originalDate.toISOString(), proposedDate: proposedDate.toISOString(), lunarInfo: oldLunar }));
        }
      }
    } catch (err) {
      errors.push({ id: item.id || null, error: err.message });
    }
  });

  return { migrated, errors };
}

/* applyMigration: take a migration preview (migr.preview) and produce a new array with replaced dates
   This function does not write to GitHub — it returns a new array for you to commit if you choose.
*/
function applyMigration(migrationPreview) {
  return migrationPreview.migrated.map(item => {
    const copy = Object.assign({}, item);
    // Replace date field (non-destructive alternative: store originalDate and newDate)
    copy.originalDate = copy.originalDate;
    copy.date = copy.proposedDate;
    return copy;
  });
}

export {
  computeLunisolarYear,
  toLunisolar,
  fromLunisolar,
  annotateAffirmationsWithLunisolar,
  previewMigrateAffirmations,
  applyMigration,
  computeNewMoonsBetween
};
