import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanBuilds, generateHomepage } from '../homepage.js'
import { makeBuild } from './helpers.js'

let root
let external

before(async () => {
    root = await mkdtemp(join(tmpdir(), 'unity-scan-'))
    external = await mkdtemp(join(tmpdir(), 'unity-ext-'))
    await makeBuild(join(root, 'brotli'), 'g.wasm.br')
    await makeBuild(join(root, 'gzip'), 'g.wasm.gz')
    await makeBuild(join(root, 'plain'), 'g.wasm')
    await makeBuild(join(root, 'fallback'), 'g.wasm.unityweb')
    await makeBuild(join(root, 'has space'), 'g.wasm')
    await makeBuild(join(root, "a&b'c"), 'g.wasm')
    await makeBuild(join(root, 'node_modules', 'ignored'), 'g.wasm')
    await makeBuild(join(root, 'Library', 'ignored2'), 'g.wasm')
    await makeBuild(join(root, 'Temp', 'ignored3'), 'g.wasm')
    await makeBuild(join(root, 'Obj', 'ignored4'), 'g.wasm')
    await makeBuild(join(root, '.git', 'ignored5'), 'g.wasm')
    // wasm only in a nested folder under Build
    await makeBuild(join(root, 'deepwasm'), 'ignore.txt')
    await mkdir(join(root, 'deepwasm', 'Build', 'sub'), { recursive: true })
    await writeFile(join(root, 'deepwasm', 'Build', 'sub', 'n.wasm.gz'), 'x')
    // a symlinked build must not be followed during the scan
    await makeBuild(join(external, 'real'), 'g.wasm')
    try { await symlink(join(external, 'real'), join(root, 'linked'), 'junction') } catch {}
    // TemplateData and Build exist but there is no wasm: not a build
    await mkdir(join(root, 'nowasm', 'TemplateData'), { recursive: true })
    await mkdir(join(root, 'nowasm', 'Build'), { recursive: true })
    await writeFile(join(root, 'nowasm', 'Build', 'x.txt'), 'x')
    // Build is a regular file: not a build
    await mkdir(join(root, 'filebuild', 'TemplateData'), { recursive: true })
    await writeFile(join(root, 'filebuild', 'Build'), 'x')
    // exact size check: 10 bytes (wasm-bytes) + 24 (index.html) + 5
    await writeFile(join(root, 'plain', 'extra.bin'), '12345')
})

after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
})

test('scanBuilds finds exactly the valid builds with their compression types', async () => {
    const builds = await scanBuilds(root)
    const byName = Object.fromEntries(builds.map(b => [b.name, b]))
    assert.deepEqual(Object.keys(byName).sort(), ["a&b'c", 'brotli', 'deepwasm', 'fallback', 'gzip', 'has space', 'plain'])
    assert.equal(byName.brotli.compressionType, 'Brotli')
    assert.equal(byName.gzip.compressionType, 'Gzip')
    assert.equal(byName.plain.compressionType, 'Uncompressed')
    assert.equal(byName.fallback.compressionType, 'Decompression fallback')
})

test('scanBuilds returns URL-encoded paths and recursive sizes', async () => {
    const builds = await scanBuilds(root)
    const byName = Object.fromEntries(builds.map(b => [b.name, b]))
    assert.equal(byName.brotli.path, '/brotli/')
    assert.equal(byName['has space'].path, '/has%20space/')
    assert.equal(byName["a&b'c"].path, "/a%26b'c/")
    // 'wasm-bytes' (10) + '<html>BUILD-INDEX</html>' (24) + extra.bin (5)
    assert.equal(byName.plain.size, 39)
})

test('a build directory scanned directly has path /', async () => {
    const builds = await scanBuilds(join(root, 'plain'))
    assert.deepEqual(builds.map(b => b.path), ['/'])
})

test('scanBuilds follows a symlinked target directory', async (t) => {
    const link = join(tmpdir(), `unity-link-${process.pid}`)
    try {
        await symlink(root, link, 'junction')
    } catch {
        t.skip('cannot create symlink here')
        return
    }
    try {
        assert.equal((await scanBuilds(link)).length, 7)
    } finally {
        await rm(link, { recursive: true, force: true })
    }
})

test('homepage lists builds sorted by name with size, escaped', async () => {
    const html = await generateHomepage(root)
    const names = [...html.matchAll(/build-name">([^<]*)</g)].map(m => m[1])
    assert.deepEqual(names, ["a&amp;b&#39;c", 'brotli', 'deepwasm', 'fallback', 'gzip', 'has space', 'plain'])
    assert.match(html, /href="\/a%26b&#39;c\/"/)
    assert.match(html, /Uncompressed 0\.00MB/)
    assert.doesNotMatch(html, /a&b'c</)
})

test('homepage renders the builds it is given, escaping every HTML metacharacter', async () => {
    const html = await generateHomepage(root, [
        { name: '<script>"x"</script>&\'', path: '/a"b<c>/', size: 1048576, compressionType: '<i>Brotli</i>' }
    ])
    assert.match(html, /href="\/a&quot;b&lt;c&gt;\/"/)
    assert.match(html, /build-name">&lt;script&gt;&quot;x&quot;&lt;\/script&gt;&amp;&#39;</)
    assert.match(html, /&lt;i&gt;Brotli&lt;\/i&gt; 1\.00MB/)
    assert.doesNotMatch(html, /<script>|<i>/)
    assert.doesNotMatch(html, /build-name">(brotli|plain)</)
})

test('a Build directory that is a symlink still counts as a build', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'unity-bl-'))
    const real = await mkdtemp(join(tmpdir(), 'unity-bl-real-'))
    try {
        await mkdir(join(dir, 'app', 'TemplateData'), { recursive: true })
        await writeFile(join(real, 'g.wasm.br'), 'x')
        try {
            await symlink(real, join(dir, 'app', 'Build'), 'junction')
        } catch {
            t.skip('cannot create symlink here')
            return
        }
        const builds = await scanBuilds(dir)
        assert.deepEqual(builds.map(b => [b.name, b.compressionType]), [['app', 'Brotli']])
    } finally {
        await rm(dir, { recursive: true, force: true })
        await rm(real, { recursive: true, force: true })
    }
})
