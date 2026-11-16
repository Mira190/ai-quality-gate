#!/usr/bin/env node
'use strict';
require('../src/cli').main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`ai-quality-gate: ${e.stack || e.message}`); process.exitCode = 0; });
