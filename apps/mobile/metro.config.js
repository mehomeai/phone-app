const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// The app imports the repo-root portable client package (../../../src/*).
// Metro only watches the project root by default, so resolution of those
// imports fails outside Replit's workspace layout. Watch the repo root
// (standard Expo monorepo recipe) so `npm run test:ui` works anywhere.
config.watchFolders = [path.resolve(__dirname, '../..')];

module.exports = config;
