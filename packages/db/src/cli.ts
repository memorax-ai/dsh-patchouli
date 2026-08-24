#!/usr/bin/env node

import { spawn } from 'node:child_process'
import process from 'node:process'

import { resolvePatchouliDb } from './index.js'

const executable = await resolvePatchouliDb()
const child = spawn(executable, process.argv.slice(2), { stdio: 'inherit' })

child.once('error', error => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
