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
  const sourceUrl = propertyValue(entry, 'sourceUrl');

  if (!id || !sourceUrl) {
    console.error(`FEED entry ${index + 1} must have a string id and sourceUrl`);
    invalidEntries += 1;
    continue;
  }

  clips.push({ id, sourceUrl });
}

if (invalidEntries > 0 || clips.length === 0) {
  process.exit(1);
}

async function checkSource({ id, sourceUrl }, { fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetchImpl(sourceUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Range: 'bytes=0-0',
        'User-Agent': 'MeClipSourceCheck/1.0',
      },
      signal: controller.signal,
    });

    if (response.body) {
      await response.body.cancel().catch(() => {});
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      const redirectDetail = location ? ` (Location: ${location})` : '';
      return `${id}: unexpected redirect, HTTP ${response.status}${redirectDetail} — ${sourceUrl}`;
    }

    if (!response.ok) {
      return `${id}: HTTP ${response.status} ${response.statusText} — ${sourceUrl}`;
    }

    console.log(`OK ${id}: ${sourceUrl}`);
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${id}: request failed (${detail}) — ${sourceUrl}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log(`Checking ${clips.length} clip source URL(s)...`);
  const failures = (await Promise.all(clips.map(checkSource))).filter(Boolean);

  if (failures.length > 0) {
    console.error(`\n${failures.length} clip source check(s) failed:`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('All clip source URLs are reachable without redirects.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Clip source check failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { checkSource };
