# Unity Serve

[![Unity Serve](https://img.shields.io/npm/v/unity-serve)](https://www.npmjs.com/package/unity-serve)

<img src="Assets/Screenshot.png" alt="Screenshot" width="500px" />

A blazing fast, dependency-free server that host Unity WebGL builds with correct headers, supporting Gzip and Brotli.

## Installation

```bash
# Globally install the package
npm install -g unity-serve
unity-serve $Path

# Or one time use
npx unity-serve $Path
```

The server requires Node.js 20 or later and starts at http://localhost:8080. It scans `$Path` for WebGL builds. If `$Path` is itself one Unity build, `/` opens that build; otherwise `/` shows the build list. The list is also available at `/__builds/`.

## Play the builds

1. Open the corresponding link with your browser. (preferably Chrome)
2. If used correct, you'll see a list of your WebGL builds.
3. Click on any build's name to launch it.

> If the game doesn't load, try Ctrl+Shift+R to force reload.

## Development Options

Configure the server with environment variables:

- `HOST`: `localhost` by default. Binding to `0.0.0.0` exposes the server on network interfaces; use that only for a trusted local network and serve a directory containing only files you intend to share.
- `PORT`: `8080` by default.
- `ENABLE_CORS`: Set to `true` only when cross-origin requests are needed. Disabled by default.
- `ENABLE_WASM_MULTITHREADING`: Set to `false` to omit cross-origin isolation headers. Enabled by default.

This is a local development server, not a production hosting service. It has no authentication or HTTPS configuration. Use a production web server or static host for internet-facing deployments.

## References
- [Unity WebGL Documentation](https://docs.unity3d.com/Manual/webgl-building.html)
- [Unity Server Config Documentation](https://docs.unity3d.com/6000.0/Documentation/Manual/webgl-server-configuration-code-samples.html)
