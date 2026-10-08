import { spawn } from 'node:child_process'

const commands = [
  ['npm', ['run', 'dev', '--prefix', 'frontend']],
  ['python', ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'backend', '--reload', '--port', '8000']],
]

const children = commands.map(([command, args]) => spawn(command, args, {
  shell: process.platform === 'win32',
  stdio: 'inherit',
}))

let stopping = false
function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  setTimeout(() => process.exit(exitCode), 100).unref()
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(error.message)
    stop(1)
  })
  child.on('exit', (code, signal) => {
    if (!stopping) stop(signal ? 1 : (code ?? 0))
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
