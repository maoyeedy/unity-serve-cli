import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../index.js', import.meta.url))

function withPort(env) {
    const merged = { ...process.env, PORT: String(randomPort()), ...env }
    if (env.PORT === null) delete merged.PORT
    return merged
}

export function randomPort() {
    return 20000 + Math.floor(Math.random() * 20000)
}

// Starts the CLI and resolves once it logs the port it actually bound.
export function startServer(dir, env = {}) {
    const child = spawn(process.execPath, [entry, dir], {
        env: withPort(env),
        stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 8000)
        child.stdout.on('data', chunk => {
            output += chunk
            const match = /serving at http:\/\/([^:]+):(\d+)/.exec(output)
            if (match) {
                clearTimeout(timer)
                resolve({ base: `http://localhost:${match[2]}`, port: Number(match[2]), output: () => output, stop: () => child.kill() })
            }
        })
        child.stderr.on('data', chunk => { output += chunk })
        child.on('exit', code => {
            clearTimeout(timer)
            reject(new Error(`server exited early (${code}): ${output}`))
        })
    })
}

export function runToExit(dir, env = {}) {
    const child = spawn(process.execPath, [entry, dir], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    return new Promise(resolve => child.on('exit', code => resolve({ code, output })))
}

export async function makeBuild(dir, wasmName = 'a.wasm') {
    await mkdir(join(dir, 'TemplateData'), { recursive: true })
    await mkdir(join(dir, 'Build'), { recursive: true })
    await writeFile(join(dir, 'index.html'), '<html>BUILD-INDEX</html>')
    await writeFile(join(dir, 'Build', wasmName), 'wasm-bytes')
}

// fetch() normalises dot segments, so traversal probes need a raw request.
export function rawGet(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = request({ host: 'localhost', port, path, method: 'GET', headers }, res => {
            let body = ''
            res.on('data', chunk => { body += chunk })
            res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
        })
        req.on('error', reject)
        req.end()
    })
}
