// Club Station Mode — CSV user management
// Parses club_users.csv, verifies passwords (plaintext or scrypt-hashed),
// and cross-references radio access columns with settings.rigs[].name

const fs = require('fs');
const crypto = require('crypto');

const FIXED_COLUMNS = ['firstname', 'lastname', 'callsign', 'passwd', 'license', 'admin', 'user'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LICENSE_MAP = {
  'extra': 'us_extra',
  'advanced': 'us_advanced',
  'general': 'us_general',
  'tech': 'us_technician',
  'technician': 'us_technician',
};

/**
 * Parse a club CSV file.
 * @param {string} csvPath — absolute path to club_users.csv
 * @returns {{ members: object[], radioColumns: string[], errors: string[] }}
 */
function loadClubUsers(csvPath) {
  const errors = [];
  if (!csvPath || !fs.existsSync(csvPath)) {
    errors.push('CSV file not found: ' + (csvPath || '(none)'));
    return { members: [], radioColumns: [], errors };
  }

  let raw;
  try {
    raw = fs.readFileSync(csvPath, 'utf8');
  } catch (err) {
    errors.push('Failed to read CSV: ' + err.message);
    return { members: [], radioColumns: [], errors };
  }

  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    errors.push('CSV has no data rows');
    return { members: [], radioColumns: [], errors };
  }

  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine);

  // Validate fixed columns
  for (let i = 0; i < FIXED_COLUMNS.length; i++) {
    if (!headers[i] || headers[i].toLowerCase().trim() !== FIXED_COLUMNS[i]) {
      errors.push(`Expected column ${i} to be "${FIXED_COLUMNS[i]}", got "${headers[i] || '(missing)'}"`);
    }
  }
  if (errors.length > 0) {
    return { members: [], radioColumns: [], errors };
  }

  // Detect optional schedule column (last header = "schedule")
  const trailing = headers.slice(FIXED_COLUMNS.length).map(h => h.trim());
  let radioColumns;
  let scheduleColIdx = -1;
  if (trailing.length > 0 && trailing[trailing.length - 1].toLowerCase() === 'schedule') {
    radioColumns = trailing.slice(0, -1);
    scheduleColIdx = FIXED_COLUMNS.length + radioColumns.length;
  } else {
    radioColumns = trailing;
  }

  const members = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < FIXED_COLUMNS.length) continue;

    const firstname = (cols[0] || '').trim();
    const lastname = (cols[1] || '').trim();
    const callsign = (cols[2] || '').trim().toUpperCase();
    const passwd = (cols[3] || '').trim();
    const license = (cols[4] || '').trim();
    const isAdmin = (cols[5] || '').trim().toLowerCase() === 'x';
    const isUser = (cols[6] || '').trim().toLowerCase() === 'x';

    if (!callsign) {
      errors.push(`Row ${i + 1}: missing callsign, skipped`);
      continue;
    }

    // Radio access map
    const radios = {};
    for (let r = 0; r < radioColumns.length; r++) {
      const val = (cols[FIXED_COLUMNS.length + r] || '').trim().toLowerCase();
      radios[radioColumns[r]] = val === 'x';
    }

    // Schedule
    const scheduleRaw = scheduleColIdx >= 0 ? (cols[scheduleColIdx] || '').trim() : '';
    const schedule = parseSchedule(scheduleRaw);

    const licenseClass = LICENSE_MAP[license.toLowerCase()] || '';

    members.push({
      firstname,
      lastname,
      callsign,
      passwd,
      license,
      licenseClass,
      role: isAdmin ? 'admin' : (isUser ? 'user' : 'user'),
      radios,
      schedule,
    });
  }

  const hasSchedule = scheduleColIdx >= 0;
  return { members, radioColumns, hasSchedule, errors };
}

/**
 * Parse a single CSV line, handling quoted fields.
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * Verify a member's password against input.
 * Supports plaintext and scrypt-hashed ($scrypt$<salt>$<hash>) passwords.
 * @returns {boolean}
 */
function verifyMemberPassword(member, input) {
  if (!member || !member.passwd || !input) return false;
  const stored = member.passwd;

  if (!stored.startsWith('$scrypt$')) return false;

  // Format: $scrypt$<salt_hex>$<hash_hex>
  const parts = stored.split('$');
  // ['', 'scrypt', salt, hash]
  if (parts.length !== 4) return false;
  const salt = Buffer.from(parts[2], 'hex');
  const expectedHash = parts[3];
  const derived = crypto.scryptSync(input, salt, 64).toString('hex');
  return derived === expectedHash;
}

/**
 * Hash all plaintext passwords in the CSV file using scrypt.
 * Creates a .bak backup before rewriting.
 * @param {string} csvPath
 * @returns {{ hashed: number, alreadyHashed: number, error: string|null }}
 */
function hashPasswords(csvPath) {
  let raw;
  try {
    raw = fs.readFileSync(csvPath, 'utf8');
  } catch (err) {
    return { hashed: 0, alreadyHashed: 0, error: 'Failed to read CSV: ' + err.message };
  }

  // Create backup
  try {
    fs.writeFileSync(csvPath + '.bak', raw);
  } catch (err) {
    return { hashed: 0, alreadyHashed: 0, error: 'Failed to create backup: ' + err.message };
  }

  const lines = raw.split(/\r?\n/);
  let hashed = 0;
  let alreadyHashed = 0;
  const newLines = [];

  for (let i = 0; i < lines.length; i++) {
    if (i === 0 || !lines[i].trim()) {
      newLines.push(lines[i]);
      continue;
    }
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 4) {
      newLines.push(lines[i]);
      continue;
    }

    const passwd = cols[3].trim();
    if (passwd.startsWith('$scrypt$')) {
      alreadyHashed++;
      newLines.push(lines[i]);
      continue;
    }

    if (!passwd) {
      newLines.push(lines[i]);
      continue;
    }

    // Hash the password
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(passwd, salt, 64);
    cols[3] = '$scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
    hashed++;

    // Reconstruct line — quote fields that contain commas
    newLines.push(cols.map(c => c.includes(',') ? `"${c}"` : c).join(','));
  }

  try {
    fs.writeFileSync(csvPath, newLines.join('\n'));
  } catch (err) {
    return { hashed: 0, alreadyHashed: 0, error: 'Failed to write hashed CSV: ' + err.message };
  }

  return { hashed, alreadyHashed, error: null };
}

/**
 * Get the list of rigs a member can access.
 * Cross-references CSV radio columns with settings.rigs[].name (case-insensitive).
 * Admins get access to all rigs.
 * @param {object} member — parsed member object
 * @param {object[]} rigs — settings.rigs array
 * @returns {object[]} — filtered rig list [{id, name}]
 */
function getMemberRigAccess(member, rigs) {
  if (!member || !rigs || !rigs.length) return [];

  // Admins get all rigs
  if (member.role === 'admin') {
    return rigs.map(r => ({ id: r.id, name: r.name }));
  }

  return rigs
    .filter(r => {
      if (!r.name) return false;
      // Find matching radio column (case-insensitive)
      const rigNameLower = r.name.toLowerCase();
      for (const [radioCol, hasAccess] of Object.entries(member.radios)) {
        if (radioCol.toLowerCase() === rigNameLower && hasAccess) return true;
      }
      return false;
    })
    .map(r => ({ id: r.id, name: r.name }));
}

/**
 * Check if the CSV has any plaintext (unhashed) passwords.
 * @param {object[]} members — parsed member array
 * @returns {boolean}
 */
function hasPlaintextPasswords(members) {
  return members.some(m => m.passwd && !m.passwd.startsWith('$scrypt$'));
}

/**
 * Parse a schedule string into an array of slot objects.
 * Format: "Day HH:MM-HH:MM RadioName" entries separated by ";"
 * Example: "Mon 14:00-16:00 IC-7300MkII; Wed 09:00-11:00 IC-9700"
 * @param {string} raw
 * @returns {{ day: string, startH: number, startM: number, endH: number, endM: number, radio: string }[]}
 */
function parseSchedule(raw) {
  if (!raw) return [];
  const slots = [];
  const entries = raw.split(';').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    // Match: Day HH:MM-HH:MM RadioName
    const m = entry.match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s+(.+)$/i);
    if (!m) continue;
    const day = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    slots.push({
      day,
      startH: parseInt(m[2], 10),
      startM: parseInt(m[3], 10),
      endH: parseInt(m[4], 10),
      endM: parseInt(m[5], 10),
      radio: m[6].trim(),
    });
  }
  return slots;
}

/**
 * Get all schedule slots for a given day across all members.
 * Returns slots sorted by start time, enriched with member info.
 * @param {object[]} members
 * @param {string} dayName — "Mon", "Tue", etc.
 * @returns {{ callsign: string, firstname: string, day: string, startH: number, startM: number, endH: number, endM: number, radio: string }[]}
 */
function getScheduleForDay(members, dayName) {
  const slots = [];
  for (const m of members) {
    if (!m.schedule) continue;
    for (const s of m.schedule) {
      if (s.day === dayName) {
        slots.push({ callsign: m.callsign, firstname: m.firstname, ...s });
      }
    }
  }
  slots.sort((a, b) => (a.startH * 60 + a.startM) - (b.startH * 60 + b.startM));
  return slots;
}

/**
 * Check who is scheduled for a specific radio right now.
 * @param {object[]} members
 * @param {string} radioName
 * @returns {{ callsign: string, firstname: string, slot: object }|null}
 */
function getScheduledNow(members, radioName) {
  const now = new Date();
  const dayName = DAYS[now.getDay()];
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const m of members) {
    if (!m.schedule) continue;
    for (const s of m.schedule) {
      if (s.day !== dayName) continue;
      if (s.radio.toLowerCase() !== radioName.toLowerCase()) continue;
      const startMin = s.startH * 60 + s.startM;
      const endMin = s.endH * 60 + s.endM;
      if (nowMin >= startMin && nowMin < endMin) {
        return { callsign: m.callsign, firstname: m.firstname, slot: s };
      }
    }
  }
  return null;
}

module.exports = {
  loadClubUsers,
  verifyMemberPassword,
  hashPasswords,
  getMemberRigAccess,
  hasPlaintextPasswords,
  parseSchedule,
  getScheduleForDay,
  getScheduledNow,
};
