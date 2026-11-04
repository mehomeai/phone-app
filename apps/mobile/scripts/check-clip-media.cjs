const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const dataPath = path.resolve(__dirname, '../lib/data.ts');
const sourceFile = ts.createSourceFile(
  dataPath,
  fs.readFileSync(dataPath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);

function propertyValue(object, name) {
  const property = object.properties.find(
    (entry) =>
      ts.isPropertyAssignment(entry) &&
      (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
      entry.name.text === name,
  );

  return property && ts.isStringLiteral(property.initializer)
    ? property.initializer.text
    : undefined;
}

const feedDeclaration = sourceFile.statements
  .filter(ts.isVariableStatement)
  .flatMap((statement) => statement.declarationList.declarations)
  .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'FEED');

if (!feedDeclaration || !feedDeclaration.initializer || !ts.isArrayLiteralExpression(feedDeclaration.initializer)) {
  console.error(`Could not find the FEED array in ${dataPath}`);
  process.exit(1);
}

const clips = [];
let invalidEntries = 0;

for (const [index, entry] of feedDeclaration.initializer.elements.entries()) {
  if (!ts.isObjectLiteralExpression(entry)) {
    console.error(`FEED entry ${index + 1} is not a clip object`);
    invalidEntries += 1;
    continue;
  }

  const id = propertyValue(entry, 'id');
  const video = propertyValue(entry, 'video');

  if (!id || !video) {
    console.error(`FEED entry ${index + 1} must have a string id and video URL`);
    invalidEntries += 1;
    continue;
  }

  try {
    const mediaUrl = new URL(video);
    if (mediaUrl.protocol !== 'http:' && mediaUrl.protocol !== 'https:') {
      throw new Error('unsupported URL protocol');
    }
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : '';
    console.error(`${id}: invalid video URL${detail} — ${video}`);
    invalidEntries += 1;
    continue;
  }

  clips.push({ id, video });
}

if (invalidEntries > 0 || clips.length === 0) {
  process.exit(1);
}

async function checkMedia(
  { id, video },
  { fetchImpl = globalThis.fetch, log = console.log, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {},
) {
  const controller = new AbortController();
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
  const timeout = setTimeoutImpl(() => {
    const timeoutError = new Error('Request timed out after 15000 ms');
    controller.abort(timeoutError);
    rejectTimeout(timeoutError);
  }, 15_000);

  try {
    const request = (async () => {
      const response = await fetchImpl(video, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Range: 'bytes=0-0',
          'User-Agent': 'MeClipMediaCheck/1.0',
        },
        signal: controller.signal,
      });

      if (response.body) await response.body.cancel().catch(() => {});
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        const redirectDetail = location ? ` (Location: ${location})` : '';
        return `${id}: unexpected redirect, HTTP ${response.status}${redirectDetail} — ${video}`;
      }
      if (!response.ok) return `${id}: HTTP ${response.status} ${response.statusText} — ${video}`;

      const contentType = response.headers.get('content-type');
      if (contentType) {
        const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
        if (!mediaType.startsWith('video/') && mediaType !== 'application/octet-stream') {
          return `${id}: unexpected media content type ${contentType} — ${video}`;
        }
      }
      log(`OK ${id}: ${video}`);
      return undefined;
    })();
    return await Promise.race([request, timeoutPromise]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${id}: request failed (${detail}) — ${video}`;
  } finally {
    clearTimeoutImpl(timeout);
  }
}

async function runChecks({
  clipList = clips,
  fetchImpl = globalThis.fetch,
  log = console.log,
  error = console.error,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  log(`Checking ${clipList.length} clip media URL(s)...`);
  const failures = (await Promise.all(
    clipList.map((clip) => checkMedia(clip, { fetchImpl, log, setTimeoutImpl, clearTimeoutImpl })),
  )).filter(Boolean);

  if (failures.length > 0) {
    error(`\n${failures.length} clip media check(s) failed:`);
    for (const failure of failures) error(`- ${failure}`);
    return { failures, exitCode: 1 };
  }

  log('All clip media URLs are reachable without redirects.');
  return { failures, exitCode: 0 };
}

async function main() {
  const result = await runChecks();
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Clip media check failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { checkMedia, runChecks };
