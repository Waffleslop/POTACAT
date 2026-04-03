/**
 * Replace C99 "complex float" with a portable typedef across all codec2 source.
 * Adds a compat header that defines cf_complex as either _Complex float (GCC)
 * or std::complex<float> (MSVC C++).
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'codec2_src');

// Replace "complex float" → "cf_complex" and related patterns
const replacements = [
  [/\bcomplex\s+float\b/g, 'cf_complex'],
  [/\bcomplex\s+double\b/g, 'cf_complexd'],
  // function-like macros from C99 complex.h that we need
];

const cFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.c') || f.endsWith('.h'));
let totalReplacements = 0;

for (const file of cFiles) {
  if (file === 'codec2_complex_compat.h' || file === 'msvc_complex.h' || file === 'codec2_compat.h') continue;
  const filePath = path.join(srcDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  for (const [re, replacement] of replacements) {
    const matches = content.match(re);
    if (matches) {
      content = content.replace(re, replacement);
      totalReplacements += matches.length;
      modified = true;
    }
  }

  // Add the compat include if we made changes and it's a .c file
  if (modified && file.endsWith('.c') && !content.includes('cf_complex_def.h')) {
    // Add after the first #include
    const firstInclude = content.indexOf('#include');
    if (firstInclude >= 0) {
      const lineEnd = content.indexOf('\n', firstInclude);
      content = content.slice(0, lineEnd + 1) +
        '#include "cf_complex_def.h"\n' +
        content.slice(lineEnd + 1);
    }
  }
  // For header files that use complex float, also add include guard
  if (modified && file.endsWith('.h') && !content.includes('cf_complex_def.h')) {
    // Add at the top after any include guards
    const guardEnd = content.indexOf('\n', content.indexOf('#define __'));
    if (guardEnd >= 0) {
      content = content.slice(0, guardEnd + 1) +
        '#include "cf_complex_def.h"\n' +
        content.slice(guardEnd + 1);
    } else {
      // No guard found, add at top
      content = '#include "cf_complex_def.h"\n' + content;
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content);
    console.log(`Fixed complex types in ${file}`);
  }
}

console.log(`\nTotal: ${totalReplacements} replacements`);
