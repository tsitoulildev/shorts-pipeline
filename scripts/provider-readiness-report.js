require('dotenv').config();

const { CredentialManager } = require('../utils/credential-manager');
const { AITextService } = require('../utils/ai-text-service');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { VideoProviderRegistry } = require('../utils/video-providers');
const { checkFFmpeg } = require('../utils/ffmpeg');
const telegram = require('../utils/telegram-notifier');

async function main() {
  const credentials = new CredentialManager();
  await credentials.loadCredentials();
  await credentials.loadTokens();

  const raw = credentials.credentials || {};
  const text = new AITextService(raw);
  const generator = new AIVideoGenerator(raw);
  const registry = new VideoProviderRegistry(raw);

  const videoProviders = registry.list().map(provider => ({
    id: provider.id,
    configured: provider.available === true,
    model: provider.model || null,
    local: provider.capabilities?.local === true
  }));

  const ttsProviders = {
    elevenLabs: Boolean(generator.elevenLabsApiKey && generator.elevenLabsVoiceId),
    openai: Boolean(generator.openai),
    gemini: Boolean(generator.gemini)
  };

  const imageProviders = {
    openai: Boolean(generator.openai),
    gemini: Boolean(generator.gemini)
  };

  const youtubeConfigured = Boolean(
    raw.youtube?.client_id &&
    raw.youtube?.client_secret &&
    Array.isArray(raw.youtube?.redirect_uris) &&
    raw.youtube.redirect_uris.length &&
    credentials.tokens?.youtube
  );

  const ffmpeg = await checkFFmpeg();

  const report = {
    generatedAt: new Date().toISOString(),
    secretsExposed: false,
    text: {
      configured: text.isAvailable(),
      provider: text.isAvailable() ? text.providerName : null,
      routing: text.describeChain()
    },
    image: {
      configured: Object.values(imageProviders).some(Boolean),
      providers: imageProviders
    },
    narration: {
      configured: Object.values(ttsProviders).some(Boolean),
      providers: ttsProviders
    },
    video: {
      configuredProviders: videoProviders.filter(provider => provider.configured).map(provider => provider.id),
      providers: videoProviders
    },
    ffmpeg: {
      available: ffmpeg
    },
    youtube: {
      oauthConfigured: youtubeConfigured
    },
    telegram: telegram.status(),
    safeNextStep: {
      canRunPaidImageProbe: Object.values(imageProviders).some(Boolean),
      canRunPaidVideoProbe: videoProviders.some(provider => provider.configured && !provider.local),
      canRunNarrationProbe: Object.values(ttsProviders).some(Boolean),
      canRunYouTubeAccessProbe: youtubeConfigured
    }
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch(error => {
  console.error('Provider readiness report failed:', String(error?.message || error));
  process.exitCode = 1;
});
