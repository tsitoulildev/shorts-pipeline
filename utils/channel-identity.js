// The channel identity the running process uses: the Dark History one when DARK_HISTORY_LIVE=true, the old one otherwise.
// Read when the process starts (changing the switch restarts the service). The old file goes away with the old pipeline.
const { isLive } = require('./dark-history/live');

module.exports = isLive() ? require('../config/dark-history-identity.json') : require('../config/channel-identity.json');
