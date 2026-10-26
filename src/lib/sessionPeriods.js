// @module lib/sessionPeriods — bucket sessions by when they were last active.
//
// Recent Sessions used to show only the 30 most recent Claude sessions; older
// ungrouped ones were not listed at all. Split by period, every session can be
// listed while each bucket stays short: Today, Yesterday, Previous 7 days,
// Previous 30 days, then one bucket per month, and per year past twelve months.
//
// Pure functions (no `vscode`): `now` and the locale are passed in so the
// day boundaries are testable.

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Local midnight `daysBack` calendar days before `now`. Calendar arithmetic,
// not `- n * 24h`, so a daylight-saving change inside the window does not
// shift the boundary by an hour (and so a day).
function midnightDaysBack(now, daysBack) {
  const n = new Date(now);
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysBack).getTime();
}

/**
 * The bucket a timestamp falls in, in local time.
 * @returns {{key:string, kind:'today'|'yesterday'|'last7'|'last30'|'month'|'year'|'unknown', year?:number, month?:number}}
 */
function periodOf(mtime, now) {
  // No timestamp (e.g. a Kiro session without updatedAt) is not "today".
  if (!(mtime > 0)) return { key: 'unknown', kind: 'unknown' };
  // A clock skew or a future mtime still counts as today.
  if (mtime >= midnightDaysBack(now, 0)) return { key: 'today', kind: 'today' };
  if (mtime >= midnightDaysBack(now, 1)) return { key: 'yesterday', kind: 'yesterday' };
  if (mtime >= midnightDaysBack(now, 7)) return { key: 'last7', kind: 'last7' };
  if (mtime >= midnightDaysBack(now, 30)) return { key: 'last30', kind: 'last30' };
  const d = new Date(mtime);
  const n = new Date(now);
  const monthsAgo = (n.getFullYear() - d.getFullYear()) * 12 + (n.getMonth() - d.getMonth());
  if (monthsAgo < 12) {
    const month = d.getMonth() + 1;
    return { key: `m:${d.getFullYear()}-${String(month).padStart(2, '0')}`, kind: 'month', year: d.getFullYear(), month };
  }
  return { key: `y:${d.getFullYear()}`, kind: 'year', year: d.getFullYear() };
}

/**
 * Group entries into period buckets, newest bucket first. Entry order inside a
 * bucket is kept (sort them before or after as you need).
 * @template T
 * @param {T[]} entries
 * @param {(e:T)=>number} mtimeOf
 * @param {number} now
 * @returns {{key:string, kind:string, year?:number, month?:number, newest:number, entries:T[]}[]}
 */
function bucketByPeriod(entries, mtimeOf, now) {
  const byKey = new Map();
  for (const e of entries) {
    const mtime = mtimeOf(e) || 0;
    const p = periodOf(mtime, now);
    let bucket = byKey.get(p.key);
    if (!bucket) {
      bucket = { ...p, newest: 0, entries: [] };
      byKey.set(p.key, bucket);
    }
    bucket.entries.push(e);
    // Today's bucket also holds future mtimes — rank it first regardless; the
    // no-date bucket goes last.
    bucket.newest = p.kind === 'today' ? Infinity
      : p.kind === 'unknown' ? -Infinity
        : Math.max(bucket.newest, mtime);
  }
  return [...byKey.values()].sort((a, b) => b.newest - a.newest);
}

/**
 * Display label for a bucket.
 * @param {{kind:string, year?:number, month?:number}} bucket
 * @param {{today:string, yesterday:string, last7:string, last30:string, unknown?:string}} names fixed labels (localized)
 * @param {string} [locale] BCP 47 tag for month names, e.g. 'en-US', 'ko-KR'
 */
function periodLabel(bucket, names, locale) {
  switch (bucket.kind) {
    case 'unknown': return names.unknown || 'No date';
    case 'today': return names.today;
    case 'yesterday': return names.yesterday;
    case 'last7': return names.last7;
    case 'last30': return names.last30;
    case 'month':
      try {
        return new Intl.DateTimeFormat(locale || 'en-US', { year: 'numeric', month: 'long' })
          .format(new Date(bucket.year, bucket.month - 1, 1));
      } catch (_) {
        return `${bucket.year}-${String(bucket.month).padStart(2, '0')}`;
      }
    default:
      return String(bucket.year);
  }
}

module.exports = { periodOf, bucketByPeriod, periodLabel, startOfDay };
