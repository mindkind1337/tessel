// Entry of out/main/cli.js (the tessel command; see tessel.js).
import { run } from './tessel'

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`${(err && err.message) || err}\n`)
    process.exitCode = 1
  }
)
