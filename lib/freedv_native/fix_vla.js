/**
 * Automatically fix C99 VLAs in codec2 source for MSVC compatibility.
 * Wraps VLA declarations with #ifdef _MSC_VER using _alloca.
 *
 * Run: node fix_vla.js
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'codec2_src');
const cFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.c'));

// Regex to match common VLA patterns:
// type name[expr]; where expr contains a non-literal (variable, field access, function call)
// Excludes: array initializers (= {...}), string literals, preprocessor
const VLA_RE = /^(\s+)((?:float|double|int|short|unsigned\s+char|unsigned\s+int|unsigned|uint8_t|uint16_t|int16_t|int32_t|uint32_t|size_t|COMP|cf_complex|char)\s*\*?\s*)(\w+)\s*\[([^\]]+)\]\s*;/;

function isConstExpr(expr) {
  expr = expr.trim();
  // Pure numeric literal
  if (/^\d+$/.test(expr)) return true;
  // Macro constant (ALL_CAPS)
  if (/^[A-Z_][A-Z0-9_]*$/.test(expr)) return true;
  // Simple arithmetic with only constants/macros
  if (/^[A-Z0-9_\s+\-*/()]+$/.test(expr) && !/[a-z]/.test(expr)) return true;
  // sizeof expressions
  if (/^sizeof/.test(expr)) return true;
  return false;
}

let totalFixed = 0;
let filesFixed = 0;

for (const file of cFiles) {
  const filePath = path.join(srcDir, file);
  const original = fs.readFileSync(filePath, 'utf8');
  const lines = original.split('\n');
  let modified = false;
  let needsInclude = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip preprocessor, comments, extern
    if (line.trim().startsWith('#') || line.trim().startsWith('//') || line.trim().startsWith('/*') || line.trim().startsWith('extern')) continue;

    const m = line.match(VLA_RE);
    if (!m) continue;

    const [, indent, typeDecl, varName, sizeExpr] = m;
    if (isConstExpr(sizeExpr)) continue;

    // This is a VLA — replace with _alloca on MSVC
    const baseType = typeDecl.trim().replace(/\s*\*\s*$/, '');
    const isPointer = typeDecl.trim().endsWith('*');

    if (isPointer) continue; // pointer VLAs are rare and complex

    const replacement =
      `${indent}#ifdef _MSC_VER\n` +
      `${indent}${baseType} *${varName} = (${baseType} *)_alloca((${sizeExpr}) * sizeof(${baseType}));\n` +
      `${indent}#else\n` +
      `${indent}${typeDecl}${varName}[${sizeExpr}];\n` +
      `${indent}#endif`;

    lines[i] = replacement;
    modified = true;
    needsInclude = true;
    totalFixed++;
  }

  if (modified) {
    // Add malloc.h include for _alloca if not already present
    if (needsInclude && !original.includes('<malloc.h>') && !original.includes('_alloca')) {
      // Find first #include and add after it
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('#include')) {
          lines.splice(i + 1, 0, '#ifdef _MSC_VER\n#include <malloc.h>\n#endif');
          break;
        }
      }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    filesFixed++;
    console.log(`Fixed VLAs in ${file}`);
  }
}

console.log(`\nTotal: ${totalFixed} VLAs fixed in ${filesFixed} files`);
