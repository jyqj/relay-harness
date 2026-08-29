#!/usr/bin/env node

import { Context } from '@relay-harness/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@relay-harness/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@relay-harness/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
