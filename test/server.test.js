import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeBuild, startServer, runToExit, rawGet } from './helpers.js'

let outer
let root
let srv

before(async () => {
    outer = await mkdtemp(join(tmpdir(), 'unity-serve-'))
    root = join(outer, 'site')
    await makeBuild(join(root, 'b1'), 'a.wasm.br')
    for (const name of ['a.wasm', 'a.wasm.gz', 'a.framework.js', 'a.framework.js.br', 'a.framework.js.gz',
        'a.data', 'a.data.br', 'a.data.gz', 'a.bundle', 'a.unityweb', 'a.symbols.json.gz', 'a.symbols.json.br',
        'a.json', 'A.WASM.BR', 'a.txt']) {
        await writeFile(join(root, 'b1', 'Build', name), 'x')
    }
    srv = await startServer(root)
})

after(async () => {
    srv.stop()
    await rm(outer, { recursive: true, force: true })
})

test('Unity content type and Content-Encoding per file suffix', async () => {
    // [file, content-type, content-encoding] per Unity's Node.js server config
    const cases = [
        ['a.wasm', 'application/wasm', null],
        ['a.wasm.br', 'application/wasm', 'br'],
        ['a.wasm.gz', 'application/wasm', 'gzip'],
        ['a.framework.js', 'application/javascript', null],
        ['a.framework.js.br', 'application/javascript', 'br'],
        ['a.framework.js.gz', 'application/javascript', 'gzip'],
        ['a.data', 'application/octet-stream', null],
        ['a.data.br', 'application/octet-stream', 'br'],
        ['a.data.gz', 'application/octet-stream', 'gzip'],
        ['a.bundle', 'application/octet-stream', null],
        ['a.unityweb', 'application/octet-stream', null],
        ['a.symbols.json.gz', 'application/octet-stream', 'gzip'],
        ['a.symbols.json.br', 'application/octet-stream', 'br'],
        ['a.json', 'application/json', null],
        ['A.WASM.BR', 'application/wasm', 'br']
    ]
    for (const [file, type, encoding] of cases) {
        const res = await fetch(`${srv.base}/b1/Build/${file}`)
        assert.equal(res.status, 200, file)
        assert.match(res.headers.get('content-type'), new RegExp(`^${type.replace('/', '\\/')}`), file)
        assert.equal(res.headers.get('content-encoding'), encoding, file)
    }
})

test('percent-encoded suffix is classified like the decoded one', async () => {
    const res = await fetch(`${srv.base}/b1/Build/a%2Ewasm.br`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /^application\/wasm/)
    assert.equal(res.headers.get('content-encoding'), 'br')
})

test('404 for a missing compressed file has no Content-Encoding and keeps its JSON type', async () => {
    const res = await fetch(`${srv.base}/b1/Build/missing.wasm.br`)
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('content-encoding'), null)
    assert.match(res.headers.get('content-type'), /^application\/json/)
})

test('range and conditional responses keep the Unity headers', async () => {
    const path = '/b1/Build/a.wasm.br'
    const first = await rawGet(srv.port, path)
    const ranged = await rawGet(srv.port, path, { Range: 'bytes=0-0' })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers['content-encoding'], 'br')
    assert.match(ranged.headers['content-type'], /^application\/wasm/)
    const notModified = await rawGet(srv.port, path, { 'If-None-Match': first.headers.etag })
    assert.equal(notModified.status, 304)
    assert.equal(notModified.headers['content-encoding'], 'br')
    assert.match(notModified.headers['content-type'], /^application\/wasm/)
})

test('isolation headers on HTML and scripts only', async () => {
    const expected = {
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'cross-origin'
    }
    for (const path of ['/b1/', '/b1/index.html', '/', '/__builds/', '/b1/Build/a.framework.js',
        '/b1/Build/a.framework.js.gz', '/b1/Build/a.framework.js.br']) {
        const res = await fetch(srv.base + path)
        for (const [header, value] of Object.entries(expected)) {
            assert.equal(res.headers.get(header), value, `${path} ${header}`)
        }
    }
    for (const path of ['/b1/Build/a.wasm.br', '/b1/Build/a.data', '/b1/Build/missing.wasm']) {
        const res = await fetch(srv.base + path)
        assert.equal(res.headers.get('cross-origin-embedder-policy'), null, path)
    }
})

test('CORS is off by default', async () => {
    const res = await fetch(`${srv.base}/b1/Build/a.wasm`)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
})

test('ENABLE_CORS=true adds Access-Control-Allow-Origin', async () => {
    const s = await startServer(root, { ENABLE_CORS: 'true' })
    try {
        for (const path of ['/b1/Build/a.wasm', '/', '/b1/Build/missing.wasm']) {
            assert.equal((await fetch(s.base + path)).headers.get('access-control-allow-origin'), '*', path)
        }
    } finally {
        s.stop()
    }
})

test('ENABLE_WASM_MULTITHREADING=false omits isolation headers', async () => {
    const s = await startServer(root, { ENABLE_WASM_MULTITHREADING: 'false' })
    try {
        for (const path of ['/', '/b1/', '/b1/Build/a.framework.js']) {
            const res = await fetch(s.base + path)
            for (const header of ['cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy']) {
                assert.equal(res.headers.get(header), null, `${path} ${header}`)
            }
        }
    } finally {
        s.stop()
    }
})

test('builds added after startup appear on / and /__builds/', async () => {
    assert.doesNotMatch(await (await fetch(srv.base + '/')).text(), /build-name">late</)
    await makeBuild(join(root, 'late'), 'z.wasm')
    for (const path of ['/', '/__builds/']) {
        assert.match(await (await fetch(srv.base + path)).text(), /build-name">late</, path)
    }
})

test('a target directory that is itself a build serves it at / and lists it at /__builds/', async () => {
    const single = join(outer, 'single')
    await makeBuild(single, 'a.wasm')
    await makeBuild(join(single, 'nested'), 'n.wasm')
    const s = await startServer(single)
    try {
        assert.match(await (await fetch(s.base + '/')).text(), /BUILD-INDEX/)
        const list = await fetch(s.base + '/__builds/')
        assert.equal(list.status, 200)
        const html = await list.text()
        assert.match(html, /build-name">nested</)
        assert.match(html, /href="\/nested\/"/)
    } finally {
        s.stop()
    }
})

test('server moves to the next port when the requested one is busy', async () => {
    const blocker = createServer()
    await new Promise(resolve => blocker.listen(0, 'localhost', resolve))
    const busy = blocker.address().port
    let s
    try {
        s = await startServer(root, { PORT: String(busy) })
        assert.equal(s.port, busy + 1)
        assert.match(s.output(), new RegExp(`Port ${busy} is in use, trying ${busy + 1}`))
        assert.equal((await fetch(s.base + '/__builds/')).status, 200)
    } finally {
        s?.stop()
        blocker.close()
    }
})

test('invalid PORT values exit non-zero with a clear message', async () => {
    for (const port of ['abc', '-1', '65536', '']) {
        const { code, output } = await runToExit(root, { PORT: port })
        assert.notEqual(code, 0, `PORT=${port}`)
        assert.match(output, /Invalid PORT/, `PORT=${port}`)
    }
})
