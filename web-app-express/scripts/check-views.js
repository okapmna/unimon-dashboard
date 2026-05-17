// Smoke check: compile every EJS view to catch template syntax errors.
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const viewsDir = path.join(__dirname, '..', 'src', 'views');
const errors = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.ejs')) {
      try {
        ejs.compile(fs.readFileSync(full, 'utf8'), { filename: full });
      } catch (err) {
        errors.push({ file: full, message: err.message });
      }
    }
  }
}

walk(viewsDir);

if (errors.length === 0) {
  console.log('All EJS templates compiled successfully.');
  process.exit(0);
} else {
  console.error('EJS compile errors:');
  for (const e of errors) console.error(`- ${e.file}\n  ${e.message}`);
  process.exit(1);
}
