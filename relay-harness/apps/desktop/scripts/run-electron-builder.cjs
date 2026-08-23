const fsPromises = require('fs/promises')
const { syncVendorInstalls } = require('./vendor-installs.js')

// extraResources copies the vendored plugins whole, so their installs have to
// exist before the pack. after-pack.js installs into the packaged tree when
// this cannot reach the registry, and fails the build if that install is short.
try {
  syncVendorInstalls({ log: message => console.log(message) })
} catch (error) {
  console.warn(`vendored plugin install failed, leaving it to after-pack: ${error.message}`)
}

const originalWriteFile = fsPromises.writeFile
const retryableCodes = new Set(['EBUSY', 'EACCES', 'EPERM', 'UNKNOWN'])

fsPromises.writeFile = async (...args) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await originalWriteFile(...args)
    } catch (error) {
      if (!retryableCodes.has(error?.code) || attempt >= 7) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}

require('electron-builder/cli.js')
