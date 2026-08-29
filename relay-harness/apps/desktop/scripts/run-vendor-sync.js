'use strict';

const { syncVendorInstalls } = require('./vendor-installs.js');

const installed = syncVendorInstalls({ log: (message) => console.log(message) });
if (installed.length === 0) {
  console.log('vendored plugin installs already match their lockfiles');
}
