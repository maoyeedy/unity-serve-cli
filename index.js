#!/usr/bin/env node
import { resolve } from 'node:path'
import { stat } from 'node:fs/promises'

import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { generateHomepage, scanBuilds } from './homepage.js'

const fastify = Fastify()
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

function requestPathname(request) {
    try {
        return decodeURIComponent(new URL(request.raw.url, 'http://localhost').pathname)
    } catch {
        return request.raw.url ?? '/'
    }
}

function setUnityContentType(reply, pathname) {
    const lowerPath = pathname.toLowerCase()
    if (/\.symbols\.json\.(gz|br)$/.test(lowerPath)) {
        reply.header('Content-Type', 'application/octet-stream')
    } else if (/\.wasm(\.(gz|br))?$/.test(lowerPath)) {
        reply.header('Content-Type', 'application/wasm')
    } else if (/\.js(\.(gz|br))?$/.test(lowerPath)) {
        reply.header('Content-Type', 'application/javascript')
    } else if (/\.(json|symbols\.json)$/.test(lowerPath)) {
        reply.header('Content-Type', 'application/json')
    } else if (/\.(data|bundle)(\.(gz|br))?$/.test(lowerPath) || lowerPath.endsWith('.unityweb')) {
        reply.header('Content-Type', 'application/octet-stream')
    }
}

fastify.addHook('onSend', (request, reply, payload, done) => {
    const pathname = requestPathname(request)
    const lowerPath = pathname.toLowerCase()

    if (enableCORS) reply.header('Access-Control-Allow-Origin', '*')

    // Only label successful static responses; errors carry plain JSON bodies.
    const isFileResponse = reply.statusCode === 200 || reply.statusCode === 206 || reply.statusCode === 304
    if (isFileResponse) {
        for (const [suffix, encoding] of compressionHeaders) {
            if (lowerPath.endsWith(suffix)) {
                reply.header('Content-Encoding', encoding)
                break
            }
        }
        setUnityContentType(reply, pathname)
    }

    // Isolation headers belong on HTML documents (including index.html served
    // through a directory URL such as /MyBuild/) and on scripts, so pthread
    // workers can start under require-corp. Checked after the Unity content
    // type is applied so precompressed .js.gz/.js.br files match.
    const contentType = String(reply.getHeader('content-type') ?? '').toLowerCase()
    if (enableWasmMultithreading && /text\/html|javascript/.test(contentType)) {
        reply.header('Cross-Origin-Opener-Policy', 'same-origin')
        reply.header('Cross-Origin-Embedder-Policy', 'require-corp')
        reply.header('Cross-Origin-Resource-Policy', 'cross-origin')
    }

    if (request.headers['cache-control'] === 'no-cache' &&
        (request.headers['if-modified-since'] || request.headers['if-none-match'])) {
        delete request.headers['cache-control']
    }

    done()
})

const start = async () => {
    try {
        const targetStats = await stat(targetDir)
        if (!targetStats.isDirectory()) throw new Error(`Target is not a directory: ${targetDir}`)

        // Builds are rescanned per request so new ones appear without a restart.
        // A directory that is itself a Unity build launches directly at /;
        // the picker is always available at /__builds/.
        fastify.get('/', async (request, reply) => {
            const builds = await scanBuilds(targetDir)
            if (builds.some(build => build.path === '/')) return reply.sendFile('index.html')
            return reply.type('text/html').send(await generateHomepage(targetDir, builds))
        })
        fastify.get('/__builds/', async (request, reply) => reply.type('text/html').send(await generateHomepage(targetDir)))

        await fastify.register(fastifyStatic, {
            root: targetDir,
            prefix: '/',
            immutable: true
        })
        let port = configuredPort
        while (true) {
            try {
                await fastify.listen({ port, host: hostname })
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
    process.on(signal, async () => {
        await fastify.close()
        console.log('Server stopped.')
        process.exit(0)
    })
}
