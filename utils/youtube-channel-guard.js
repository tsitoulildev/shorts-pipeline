/**
 * The OAuth token belongs to the Google account (and its default channel) that approved the consent
 * screen, not to the Google Cloud project. A successful login is therefore NOT proof that uploads go to
 * the channel this system is built for: after a re-authorization with the wrong account the first Short
 * went to another channel. This guard compares the authorized channel with the expected one.
 *
 * The expected channel id comes from the environment (`YOUTUBE_EXPECTED_CHANNEL_ID` in .env), not from the repository.
 * It is REQUIRED: with no id configured the guard refuses (CHANNEL_NOT_CONFIGURED) instead of letting an upload through.
 */
const channelIdentity = require('../config/channel-identity.json');

function expectedChannelId(env = process.env, identity = channelIdentity) {
  const value = String(env.YOUTUBE_EXPECTED_CHANNEL_ID || identity?.youtubeChannelId || '').trim(); // identity: optional override for tests/forks
  return value || null;
}

function channelMismatchMessage(actualId, actualTitle, expectedId) {
  const shown = actualTitle ? `${actualTitle} (${actualId})` : String(actualId);
  return `The authorized YouTube channel is ${shown}, not the expected channel ${expectedId}. ` +
    'Re-authorize with the Google account that owns the expected channel (deploy/oracle-vm/README.md, "Re-authorize YouTube").';
}

/** Throws a CHANNEL_MISMATCH error when `channel` is not the expected one; returns the channel otherwise. */
function assertExpectedChannel(channel, env = process.env, identity = channelIdentity) {
  const expected = expectedChannelId(env, identity);
  if (!expected) {
    const error = new Error('No expected YouTube channel is configured, so no upload is allowed. Set YOUTUBE_EXPECTED_CHANNEL_ID in .env to the id of the channel the Shorts must go to.');
    error.code = 'CHANNEL_NOT_CONFIGURED';
    error.status = 409;
    throw error;
  }
  if (!channel?.id || channel.id !== expected) {
    const error = new Error(channelMismatchMessage(channel?.id || 'none', channel?.snippet?.title || channel?.title || null, expected));
    error.code = 'CHANNEL_MISMATCH';
    error.status = 409;
    throw error;
  }
  return channel;
}

function isChannelMismatch(error) {
  return error?.code === 'CHANNEL_MISMATCH' || error?.code === 'CHANNEL_NOT_CONFIGURED';
}

module.exports = { expectedChannelId, channelMismatchMessage, assertExpectedChannel, isChannelMismatch };
