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

module.exports = { parsePotaParksCSV };
