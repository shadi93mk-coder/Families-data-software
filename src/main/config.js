'use strict';
// Small plain-text settings file (no personal data) that must be readable before login:
// interface language, organization name, backup options.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  lang: 'ar',
  org_name: '',
  auto_lock_minutes: 15,
  backup_keep: 30,
  backup_extra_dir: '',
  last_backup: '',
};

class Config {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      if (fs.existsSync(file)) this.data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (_) { /* corrupted config: fall back to defaults */ }
  }

  get(key) { return this.data[key]; }

  set(values) {
    Object.assign(this.data, values);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  all() { return { ...this.data }; }
}

module.exports = { Config, DEFAULTS };
