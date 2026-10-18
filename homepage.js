import { basename, join, relative, sep } from 'node:path'
import { readdir, lstat, stat } from 'node:fs/promises'

/**
 * Calculates the total size of a directory recursively
 * @param {string} dirPath - Path to the directory
 * @returns {Promise<number>} Total size in bytes
 */
async function calculateDirSize(dirPath) {
  let totalSize = 0;
  try {
    const items = await readdir(dirPath);
    for (const item of items) {
      const itemPath = join(dirPath, item);
      try {
        const stats = await lstat(itemPath);
        if (stats.isDirectory()) {
          totalSize += await calculateDirSize(itemPath);
        } else if (stats.isFile()) {
          totalSize += stats.size;
        }
      } catch (err) {
        // Skip inaccessible files
        continue;
      }
    }
  } catch (err) {
    // Handle errors when directory cannot be read
    return 0;
  }
  return totalSize;
}

async function directoryExists(path) {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

const DEFAULT_IGNORED_DIRS = ['node_modules', '.git', 'Library', 'Temp', 'Obj'];

/**
 * Walks a directory tree without following symlinks or entering hidden or ignored directories
 * @param {string} root - Directory to walk
 * @param {(entry: import('node:fs').Dirent, relPath: string) => boolean} visit - Return true to stop the walk early
 * @param {string[]} ignoredDirs - Directory names to skip
 * @returns {Promise<boolean>} Whether the walk was stopped early
 */
async function walk(root, visit, ignoredDirs = []) {
  async function recurse(relDir) {
    let entries;
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = relDir ? relDir + '/' + entry.name : entry.name;
      if (visit(entry, relPath)) return true;
      if (entry.isDirectory() && !ignoredDirs.includes(entry.name) && await recurse(relPath)) return true;
    }
    return false;
  }
  return recurse('');
}

/**
 * Scans for available Unity WebGL builds by finding TemplateData directories
 * @param {string} targetDir - Root directory to scan
 * @param {string[]} [ignoredDirs] - Directory names to skip (node_modules, .git, Library, Temp, Obj by default)
 * @returns {Promise<Array>} Array of found builds
 */
async function scanBuilds(targetDir, ignoredDirs = DEFAULT_IGNORED_DIRS) {
  const builds = [];

  try {
    // Find all TemplateData directories
    const templateDataPaths = [];
    await walk(targetDir, (entry, relPath) => {
      if (entry.isDirectory() && entry.name === 'TemplateData') templateDataPaths.push(relPath);
      return false;
    }, ignoredDirs);

    // Process TemplateData directories
    for (const relativePath of templateDataPaths) {
      // TemplateData is inside the build directory, so we need the parent
      const buildDir = join(targetDir, relativePath.replace(/TemplateData$/, ''));

      // Check if this is a valid build by verifying if it contains Build directory with wasm file
      const buildSubDir = join(buildDir, 'Build');
      if (!await directoryExists(buildSubDir)) continue;

      // Check for wasm file in the Build directory
      const hasWasm = await walk(buildSubDir, (entry) => !entry.isDirectory() && entry.name.indexOf('.wasm') > 0);

      if (!hasWasm) continue;

      const pathParts = relativePath.split(/[/\\]/);
      let buildName;

      // Get parent directory of TemplateData
      if (pathParts.length >= 2) {
        buildName = pathParts[pathParts.length - 2];
      }

      if (!buildName) {
        buildName = basename(targetDir) || 'Unity WebGL Build';
      }

      const relPath = relative(targetDir, buildDir).split(sep).filter(Boolean).join('/');
      const size = await calculateDirSize(buildDir);

      // Detect compression type
      const compressionType = await detectCompressionType(buildDir);

      builds.push({
        name: buildName,
        path: relPath ? `/${relPath.split('/').map(encodeURIComponent).join('/')}/` : '/',
        size,
        compressionType
      });
    }

    return builds;
  } catch (err) {
    console.error('Error scanning builds:', err);
    return [];
  }
}

/**
 * Detects compression type by checking for wasm files
 * @param {string} buildDir - Build directory path
 * @returns {Promise<string>} Compression type
 */
async function detectCompressionType(buildDir) {
  let compressionType = 'Unknown';
  try {
    const buildSubdir = join(buildDir, 'Build');
    if (await directoryExists(buildSubdir)) {
      const buildFiles = await readdir(buildSubdir);
      for (const file of buildFiles) {
        if (file.endsWith('.wasm.br')) {
          compressionType = 'Brotli';
          break;
        } else if (file.endsWith('.wasm.gz')) {
          compressionType = 'Gzip';
          break;
        } else if (file.endsWith('.wasm')) {
          compressionType = 'Uncompressed';
          break;
        } else if (file.endsWith('.wasm.unityweb')) {
          compressionType = 'Decompression fallback';
          break;
        }
      }
    }
  } catch (err) {
    // Skip if we can't read the directory
  }
  return compressionType;
}

/**
 * Format bytes to MB with 2 decimal places
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string
 */
function formatSizeToMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + 'MB';
}

/**
 * Generate HTML content for builds list
 * @param {Array} builds - Array of build information
 * @returns {string} HTML content for builds list
 */
function generateBuildsList(builds) {
  if (builds.length === 0) {
    return '<p>No builds available.</p>';
  }

  const buildItems = builds
    .map(build => `<li><a href="${escapeHtml(build.path)}"><span class="build-name">${escapeHtml(build.name)}</span><span class="build-size">${escapeHtml(build.compressionType)} ${formatSizeToMB(build.size)}</span></a></li>`)
    .join('');

  return `<ul>${buildItems}</ul>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

/**
 * Generates HTML for the homepage displaying available Unity WebGL builds
 * @param {string} targetDir - Root directory to scan
 * @param {Array} [discoveredBuilds] - Pre-scanned builds; scanned from targetDir when omitted
 * @returns {Promise<string>} HTML content
 */
async function generateHomepage(targetDir, discoveredBuilds) {
  const builds = discoveredBuilds ?? await scanBuilds(targetDir);

  // Sort builds by name in ascending order
  builds.sort((a, b) => a.name.localeCompare(b.name));

  const content = generateBuildsList(builds);

  const styles = `
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      background-color: #f8f9fa;
      color: #333;
    }

    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 30px 20px;
    }

    h1 {
      color: #2c3e50;
      margin-bottom: 30px;
      font-weight: 600;
      border-bottom: 2px solid #e9ecef;
      padding-bottom: 15px;
      font-size: 24px;
      font-style: italic;
    }

    ul {
      list-style-type: none;
      padding: 0;
      margin: 0;
    }

    li {
      margin: 0 0 20px 0;
      padding: 0;
      border-radius: 8px;
      box-shadow: 0 3px 9px rgba(0,0,0,0.08);
      transition: transform 0.2s, box-shadow 0.2s;
      background: white;
      overflow: hidden;
      width: 100%;
    }

    li:hover {
      transform: translateY(-3px);
      box-shadow: 0 3px 12px rgba(0,0,0,0.1);
    }

    a {
      color: #3498db;
      text-decoration: none;
      font-size: 18px;
      display: block;
      padding: 20px;
      text-align: left;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    a:hover {
      color: #2980b9;
    }

    .build-name {
      font-weight: 500;
    }

    .build-size {
      font-size: 12px;
      color: #7f8c8d;
      font-weight: normal;
    }

    p {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 3px 10px rgba(0,0,0,0.08);
    }
  `;

  return `
    <html>
        <head>
            <title>Unity WebGL Builds</title>
            <style>${styles}</style>
        </head>
        <body>
            <div class="container">
                <h1>Unity WebGL Builds</h1>
                ${content}
            </div>
        </body>
    </html>
  `;
}

export { generateHomepage, scanBuilds };
