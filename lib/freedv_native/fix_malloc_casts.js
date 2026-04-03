/**
 * Fix void* → typed pointer implicit conversions for C++ compilation.
 * Adds explicit casts to MALLOC/CALLOC/malloc/calloc assignments.
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'codec2_src');
const cFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.c'));

// Match: type *name = MALLOC(...); or type *name = calloc(...); etc.
// Also: ptr->field = MALLOC(...);
const RE = /^(\s*)(.+?)(\s*=\s*)(MALLOC|CALLOC|malloc|calloc|realloc)\((.+)\);/;

let totalFixed = 0;

for (const file of cFiles) {
  const filePath = path.join(srcDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(RE);
    if (!m) continue;

    const [, indent, lhs, eq, allocFn, args] = m;

    // Already has a cast?
    if (args.trim().startsWith('(') && /^\(\w+\s*\*\)/.test(args.trim())) continue;
    if (lhs.includes('void *') || lhs.includes('void*')) continue;

    // Determine the target type from LHS
    let targetType = null;
    // Pattern: "type *var" or "struct type *var"
    const typeMatch = lhs.trim().match(/^((?:struct\s+)?[\w]+)\s*\*\s*\w+$/);
    if (typeMatch) {
      targetType = typeMatch[1].trim();
    }
    // Pattern: "ptr->field" — need to look up type, skip for now
    // Pattern: "f->tx_payload_bits" etc — common in codec2, these are uint8_t*
    if (!targetType && (lhs.includes('->tx_payload_bits') || lhs.includes('->rx_payload_bits'))) {
      targetType = 'uint8_t';
    }
    if (!targetType && lhs.includes('->')) {
      // Can't determine type from field access, skip
      continue;
    }
    if (!targetType) continue;

    const cast = `(${targetType} *)`;
    const newLine = `${indent}${lhs}${eq}${cast}${allocFn}(${args});`;
    if (newLine !== lines[i]) {
      lines[i] = newLine;
      modified = true;
      totalFixed++;
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, lines.join('\n'));
    console.log(`Fixed malloc casts in ${file}`);
  }
}

console.log(`\nTotal: ${totalFixed} casts added`);
