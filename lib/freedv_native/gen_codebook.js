/**
 * Generate codec2 codebook C files from .txt data tables.
 * Replicates the functionality of codec2's generate_codebook.c
 *
 * Usage: node gen_codebook.js
 */
const fs = require('fs');
const path = require('path');

const cbDir = path.join(__dirname, 'codec2_src', 'codebook');

function readCodebook(filename) {
  const data = fs.readFileSync(path.join(cbDir, filename), 'utf8');
  const nums = data.split(/\s+/).filter(s => s.length > 0).map(Number);
  const k = nums[0]; // vector dimension
  const m = nums[1]; // codebook size
  const cb = nums.slice(2, 2 + k * m);
  if (cb.length !== k * m) {
    console.warn(`Warning: ${filename} expected ${k*m} values, got ${cb.length}`);
  }
  return { k, m, log2m: Math.round(Math.log2(m)), cb };
}

function generateC(arrayName, codebooks) {
  let out = '/* THIS IS A GENERATED FILE. Edit gen_codebook.js and its input */\n\n';
  out += '#include "defines.h"\n\n';

  for (let i = 0; i < codebooks.length; i++) {
    const b = codebooks[i];
    out += '#ifdef __EMBEDDED__\n';
    out += `static const float codes${i}[] = {\n`;
    out += '#else\n';
    out += `static float codes${i}[] = {\n`;
    out += '#endif\n';
    for (let j = 0; j < b.cb.length; j++) {
      out += `  ${b.cb[j]}`;
      if (j < b.cb.length - 1) out += ',';
      if ((j + 1) % b.k === 0) out += '\n';
    }
    out += '};\n\n';
  }

  out += `const struct lsp_codebook ${arrayName}[] = {\n`;
  for (let i = 0; i < codebooks.length; i++) {
    const b = codebooks[i];
    out += `  {\n    ${b.k},\n    ${b.log2m},\n    ${b.m},\n    codes${i}\n  },\n`;
  }
  out += `  { 0, 0, 0, 0 }\n};\n`;

  return out;
}

// Codebook definitions from CMakeLists.txt
const configs = [
  {
    output: 'codebook.c',
    arrayName: 'lsp_cb',
    files: ['lsp1.txt','lsp2.txt','lsp3.txt','lsp4.txt','lsp5.txt','lsp6.txt','lsp7.txt','lsp8.txt','lsp9.txt','lsp10.txt']
  },
  {
    output: 'codebookd.c',
    arrayName: 'lsp_cbd',
    files: ['dlsp1.txt','dlsp2.txt','dlsp3.txt','dlsp4.txt','dlsp5.txt','dlsp6.txt','dlsp7.txt','dlsp8.txt','dlsp9.txt','dlsp10.txt']
  },
  {
    output: 'codebookjmv.c',
    arrayName: 'lsp_cbjmv',
    files: ['lspjmv1.txt','lspjmv2.txt','lspjmv3.txt']
  },
  {
    output: 'codebookge.c',
    arrayName: 'ge_cb',
    files: ['gecb.txt']
  },
  {
    output: 'codebooknewamp1.c',
    arrayName: 'newamp1vq_cb',
    files: ['train_120_1.txt','train_120_2.txt']
  },
  {
    output: 'codebooknewamp1_energy.c',
    arrayName: 'newamp1_energy_cb',
    files: ['newamp1_energy_q.txt']
  },
  {
    output: 'codebooknewamp2.c',
    arrayName: 'newamp2vq_cb',
    files: ['codes_450.txt']
  },
  {
    output: 'codebooknewamp2_energy.c',
    arrayName: 'newamp2_energy_cb',
    files: ['newamp2_energy_q.txt']
  },
];

for (const cfg of configs) {
  try {
    const codebooks = cfg.files.map(f => readCodebook(f));
    const code = generateC(cfg.arrayName, codebooks);
    const outPath = path.join(__dirname, 'codec2_src', cfg.output);
    fs.writeFileSync(outPath, code);
    console.log(`Generated ${cfg.output} (${codebooks.length} codebooks)`);
  } catch (e) {
    console.error(`Error generating ${cfg.output}: ${e.message}`);
  }
}
