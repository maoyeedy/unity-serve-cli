#!/usr/bin/env node
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream'

import { generateHomepage, scanBuilds } from './homepage.js'

const hostname = process.env.HOST ?? 'localhost'
const configuredPort = Number.parseInt(process.env.PORT ?? '8080', 10)
if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    console.error(`Invalid PORT: ${process.env.PORT}`)
    process.exit(1)
}
const enableCORS = process.env.ENABLE_CORS === 'true'
const enableWasmMultithreading = process.env.ENABLE_WASM_MULTITHREADING !== 'false'
const targetDir = resolve(process.argv[2] ?? '.')

const compressionHeaders = new Map([
    ['.br', 'br'],
    ['.gz', 'gzip']
])

const mimeTypes = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.txt': 'text/plain',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.map': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv', '.md': 'text/markdown',
    '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.ico': 'image/vnd.microsoft.icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf'
}

function mimeFor(file) {
    const type = mimeTypes[extname(file).toLowerCase()] ?? 'application/octet-stream'
    return /^text\/|javascript/.test(type) ? `${type}; charset=utf-8` : type
}

function unityContentType(lowerPath) {
    if (/\.symbols\.json\.(gz|br)$/.test(lowerPath)) return 'application/octet-stream'
    if (/\.wasm(\.(gz|br))?$/.test(lowerPath)) return 'application/wasm'
    if (/\.js(\.(gz|br))?$/.test(lowerPath)) return 'application/javascript'
    if (/\.(json|symbols\.json)$/.test(lowerPath)) return 'application/json'
    if (/\.(data|bundle)(\.(gz|br))?$/.test(lowerPath) || lowerPath.endsWith('.unityweb')) return 'application/octet-stream'
    return null
}

// Applies CORS, Unity content type/encoding and isolation headers, then writes
// the head. Unity headers are only applied to 200/206/304, as errors carry JSON.
function writeHead(res, status, headers, pathname) {
    const out = { ...headers }
    if (enableCORS) out['access-control-allow-origin'] = '*'
    if (status === 200 || status === 206 || status === 304) {
        const lowerPath = pathname.toLowerCase()
        for (const [suffix, encoding] of compressionHeaders) {
            if (lowerPath.endsWith(suffix)) {
                out['content-encoding'] = encoding
                break
            }
        }
        const unityType = unityContentType(lowerPath)
        if (unityType) out['content-type'] = unityType
    }
    // Isolation headers belong on HTML documents and scripts so pthread workers
    // can start under require-corp. Checked after the Unity content type so
    // precompressed .js.gz/.js.br files match.
    if (enableWasmMultithreading && /text\/html|javascript/.test(String(out['content-type'] ?? '').toLowerCase())) {
        out['cross-origin-opener-policy'] = 'same-origin'
        out['cross-origin-embedder-policy'] = 'require-corp'
        out['cross-origin-resource-policy'] = 'cross-origin'
    }
    res.writeHead(status, out)
}

function sendBody(req, res, status, headers, pathname, body, type) {
    const buffer = Buffer.from(body)
    writeHead(res, status, { 'content-type': type, 'content-length': buffer.length, ...headers }, pathname)
    res.end(req.method === 'HEAD' ? undefined : buffer)
}

function sendError(req, res, pathname, status, error, extra = {}) {
    const body = JSON.stringify({ statusCode: status, error, message: error })
    sendBody(req, res, status, extra, pathname, body, 'application/json; charset=utf-8')
}

function sendNotFound(req, res, pathname) {
    const body = JSON.stringify({ message: `Route ${req.method}:${pathname} not found`, error: 'Not Found', statusCode: 404 })
    sendBody(req, res, 404, {}, pathname, body, 'application/json; charset=utf-8')
}

function parseRange(header, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (!match || (match[1] === '' && match[2] === '')) return null // malformed or multi-range: ignore
    let start
    let end
    if (match[1] === '') {
        start = Math.max(size - Number(match[2]), 0)
        end = size - 1
    } else {
        start = Number(match[1])
        end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
    }
    return start > end || start >= size ? -1 : { start, end }
}

// Mirrors the served behavior: a request Cache-Control: no-cache always
// defeats the 304 (the old onSend strip ran too late to matter).
function isFresh(req, etag, mtimeMs) {
    const cacheControl = req.headers['cache-control']
    if (cacheControl && /(?:^|,)\s*?no-cache\s*?(?:,|$)/.test(cacheControl)) return false
    const ifNoneMatch = req.headers['if-none-match']
    const ifModifiedSince = req.headers['if-modified-since']
    if (ifNoneMatch) {
        if (ifNoneMatch.trim() === '*') return true
        const weak = tag => tag.trim().replace(/^W\//, '')
        return ifNoneMatch.split(',').some(tag => weak(tag) === weak(etag))
    }
    if (!ifModifiedSince) return false
    const since = Date.parse(ifModifiedSince)
    return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since
}

async function sendFile(req, res, file, pathname) {
    const stats = await stat(file)
    const mtimeMs = stats.mtime.getTime()
    const etag = `W/"${stats.size.toString(16)}-${mtimeMs.toString(16)}"`
    const headers = {
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=0, immutable',
        'last-modified': stats.mtime.toUTCString(),
        etag,
        'content-type': mimeFor(file)
    }

    if (isFresh(req, etag, mtimeMs)) {
        writeHead(res, 304, headers, pathname)
        res.end()
        return
    }

    let status = 200
    let range = { start: 0, end: stats.size - 1 }
    const ifRange = req.headers['if-range']
    const rangeAllowed = !ifRange || ifRange === etag || Date.parse(ifRange) === Math.floor(mtimeMs / 1000) * 1000
    if (req.headers.range && rangeAllowed) {
        const parsed = parseRange(req.headers.range, stats.size)
        if (parsed === -1) {
            return sendError(req, res, pathname, 416, 'Range Not Satisfiable', { 'content-range': `bytes */${stats.size}` })
        }
        if (parsed) {
            status = 206
            range = parsed
            headers['content-range'] = `bytes ${range.start}-${range.end}/${stats.size}`
        }
    }
    const length = stats.size === 0 ? 0 : range.end - range.start + 1
    headers['content-length'] = length
    writeHead(res, status, headers, pathname)
    if (req.method === 'HEAD' || length === 0) {
        res.end()
        return
    }
    // Client aborts surface as pipeline errors; just make sure the socket is released.
    pipeline(createReadStream(file, range), res, () => res.destroy())
}

async function sendStatic(req, res, pathname) {
    if (pathname.includes('\0')) return sendError(req, res, pathname, 400, 'Bad Request')
    let file = resolve(join(targetDir, pathname))
    if (file !== targetDir && !file.startsWith(targetDir + sep)) {
        return sendError(req, res, pathname, 403, 'Forbidden')
    }
    try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
        return await sendFile(req, res, file, pathname)
    } catch (err) {
        if (!['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG'].includes(err.code)) throw err
        return sendNotFound(req, res, pathname)
    }
}

async function handle(req, res) {
    let pathname
    try {
        pathname = decodeURIComponent(req.url.split(/[?#]/)[0])
    } catch {
        const body = JSON.stringify({ error: 'Bad Request', code: 'FST_ERR_BAD_URL', message: `'${req.url}' is not a valid url component`, statusCode: 400 })
        return sendBody(req, res, 400, {}, '/', body, 'application/json')
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendNotFound(req, res, pathname)

    // Builds are rescanned per request so new ones appear without a restart.
    // A directory that is itself a Unity build launches directly at /;
    // the picker is always available at /__builds/.
    if (pathname === '/') {
        const builds = await scanBuilds(targetDir)
        if (!builds.some(build => build.path === '/')) {
            return sendBody(req, res, 200, {}, pathname, await generateHomepage(targetDir, builds), 'text/html')
        }
    } else if (pathname === '/__builds/') {
        return sendBody(req, res, 200, {}, pathname, await generateHomepage(targetDir), 'text/html')
    }
    return sendStatic(req, res, pathname)
}

const server = createServer((req, res) => {
    handle(req, res).catch(err => {
        console.error(err)
        if (res.headersSent) return res.destroy()
        sendError(req, res, '/', 500, 'Internal Server Error')
    })
})
server.keepAliveTimeout = 72000

const listen = port => new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, hostname, () => {
        server.off('error', reject)
        resolvePromise()
    })
})

const start = async () => {
    try {
        const targetStats = await stat(targetDir)
        if (!targetStats.isDirectory()) throw new Error(`Target is not a directory: ${targetDir}`)

        let port = configuredPort
        while (true) {
            try {
                await listen(port)
                console.log(`Web server serving at http://${hostname}:${port}`)
                break
            } catch (err) {
                if (err.code !== 'EADDRINUSE' || port >= 65535) throw err
                console.log(`Port ${port} is in use, trying ${port + 1}...`)
                port += 1
            }
        }
    } catch (err) {
        console.error(err)
        process.exit(1)
    }
}

start()

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close(() => {
            console.log('Server stopped.')
            process.exit(0)
        })
        server.closeAllConnections()
    })
}
