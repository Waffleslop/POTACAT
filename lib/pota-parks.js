// POTA Parks Worked CSV parser
// Parses CSV exported from pota.app -> My Stats -> Parks Worked -> Download CSV
// Columns: "DX Entity","Location","HASC","Reference","Park Name","First QSO Date","QSOs"

const fs = require('fs');

/**
 * Parse a single CSV line handling quoted fields.
 * Returns an array of field values.
 */
function parseCsvLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      let end = i + 1;
      while (end < line.length) {
        if (line[end] === '"') {
          if (end + 1 < line.length && line[end + 1] === '"') {
            end += 2; // escaped quote
          } else {
            break;
          }
        } else {
          end++;
        }
      }
      fields.push(line.slice(i + 1, end).replace(/""/g, '"'));
      i = end + 1; // past closing quote
      if (i < line.length && line[i] === ',') i++; // skip comma
    } else {
      // Unquoted field
      const comma = line.indexOf(',', i);
      if (comma === -1) {
        fields.push(line.slice(i));
        break;
      } else {
        fields.push(line.slice(i, comma));
        i = comma + 1;
      }
    }
  }
  return fields;
}

/**
 * Parse POTA parks worked CSV file.
 * @param {string} filePath - Path to the CSV file
 * @returns {Map<string, {parkName: string, location: string, entity: string, firstQsoDate: string, qsoCount: number}>}
 */
function parsePotaParksCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter(l => l.trim());
  const parks = new Map();

  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 7) continue;

    const entity = fields[0].trim();
    const location = fields[1].trim();
    const reference = fields[3].trim();
    const parkName = fields[4].trim();
    const firstQsoDate = fields[5].trim();
    const qsoCount = parseInt(fields[6], 10) || 0;

    if (!reference) continue;

    parks.set(reference, {
      parkName,
      location,
      entity,
      firstQsoDate,
      qsoCount,
    });
  }

  return parks;
}

/**
 * Parse a pota.app ACTIVATIONS export (My Stats → Activations → Export CSV)
 * into Map<reference, {date, qsoCount, parkName}>, one entry per park with
 * the earliest date and the summed QSOs. The column order of that export is
 * not pinned anywhere we control, so columns are found by HEADER NAME and
 * the reference column is confirmed by its shape (US-1234, VE-0001, K-1234):
 * a file whose first data row carries no reference anywhere is empty, not
 * an error. (An activator in AZ, 2026-10-20: two new parks "didn't stand
 * out" — the activator park picker now marks never-activated parks.)
 */
function parsePotaActivationsCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const parks = new Map();
  if (!lines.length) return parks;
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const find = (...names) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const REF_RE = /^[A-Z0-9]{1,4}-\d{4,5}$/;
  let refCol = find('reference', 'park reference', 'park ref', 'park');
  const dateCol = find('date', 'first', 'activation date', 'qso date');
  const qsoCol = find('qsos', 'total', 'contacts', 'count');
  const nameCol = find('park name', 'name');
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]).map((x) => x.trim());
    if (!f.length) continue;
    // Confirm (or discover) the reference column from the data itself.
    let ref = refCol >= 0 ? String(f[refCol] || '').toUpperCase() : '';
    if (!REF_RE.test(ref)) {
      const j = f.findIndex((x) => REF_RE.test(String(x).toUpperCase()));
      if (j === -1) continue;
      refCol = j;
      ref = String(f[j]).toUpperCase();
    }
    const date = dateCol >= 0 ? String(f[dateCol] || '') : '';
    const qsos = qsoCol >= 0 ? (parseInt(f[qsoCol], 10) || 0) : 0;
    const parkName = nameCol >= 0 && nameCol !== refCol ? String(f[nameCol] || '') : '';
    const prev = parks.get(ref);
    if (!prev) parks.set(ref, { date, qsoCount: qsos, parkName });
    else {
      prev.qsoCount += qsos;
      if (date && (!prev.date || date < prev.date)) prev.date = date;
      if (!prev.parkName && parkName) prev.parkName = parkName;
    }
  }
  return parks;
}

module.exports = { parsePotaParksCSV, parsePotaActivationsCSV };
